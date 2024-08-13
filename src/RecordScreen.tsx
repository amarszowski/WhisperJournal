import React from 'react';
import {
  ActivityIndicator,
  IconButton,
  Text,
  ProgressBar,
} from 'react-native-paper';
import {Audio} from 'expo-av';
import {FFmpegKit, ReturnCode} from 'ffmpeg-kit-react-native';
import type {TranscribeFileOptions, WhisperContext} from 'whisper.rn';
import {
  log,
  ensureDirExists,
  formatTimeString,
  getFilename,
  initializeContext,
} from './helpers';
import {SettingsContext} from './SettingsContext';
import type {ModelName} from './types';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system';
import {StyleSheet, View} from 'react-native';
import {docDir, docDirName} from './constants';

export default function RecordScreen() {
  const insets = useSafeAreaInsets();
  const settings = React.useContext(SettingsContext);
  const journalDir = settings.journalDir;
  const [loadedModel, setLoadedModel] = React.useState<ModelName | undefined>();
  const [canRecord, setCanRecord] = React.useState(false);
  const [isRecording, setIsRecording] = React.useState<
    Audio.Recording | undefined
  >();
  const [status, setStatus] = React.useState('Inicjalizowanie...');
  const [elapsed, setElapsed] = React.useState<number | undefined>();
  const [progress, setProgress] = React.useState<number>(-1);
  const [intervalFn, setIntervalFn] = React.useState<
    NodeJS.Timeout | undefined
  >();
  const [whisperContext, setWhisperContext] = React.useState<
    WhisperContext | undefined
  >();

  function setStatusAndLog(
    message: string,
    fn: (message: any) => void = console.log,
  ) {
    log(message, fn);
    setStatus(message);
  }

  React.useEffect(() => {
    log('wywołano hook useEffect');
    if (!loadedModel || loadedModel !== settings.modelName) {
      setStatusAndLog(
        `Pobieranie i inicjalizowanie modelu ${settings.modelName}`,
      );
      setCanRecord(false);
      initializeContext(
        whisperContext,
        setWhisperContext,
        docDirName,
        settings.modelName,
        data => {
          if (data.totalBytesExpectedToWrite !== -1) {
            setProgress(
              data.totalBytesWritten / data.totalBytesExpectedToWrite,
            );
          }
        },
      ).then(() => {
        setLoadedModel(settings.modelName);
        setCanRecord(true);
        setStatusAndLog('Gotowy do nagrywania!');
      });
    }
  }, [whisperContext, settings.modelName, loadedModel]);

  async function transcribe(filename: string) {
    if (!whisperContext) {
      return log('Brak kontekstu');
    }

    setStatusAndLog('Transkrypcja...');
    const startTime = Date.now();
    const options: TranscribeFileOptions = {
      language: settings.modelName.endsWith('.en') ? 'en' : settings.language,
      translate:
        settings.translate &&
        settings.language === 'auto' &&
        !settings.modelName.endsWith('.en'),
      onProgress: _progress => {
        const endTime = Date.now();
        setProgress(_progress / 100);
        const timeLeft = (
          ((endTime - startTime) * (100 - _progress)) /
          _progress /
          1000
        ).toFixed(0);
        setStatusAndLog(`Transkrypcja...\nPrzewidywany czas pozostały: ${timeLeft}s`);
      },
      onNewSegments: segment => {
        log(segment.result);
      },
    };
    log(options);
    const {
      // stop,
      promise,
    } = whisperContext.transcribe(docDirName + filename, options);
    promise.then(transcript => {
      const endTime = Date.now();
      log(
        `Zapisano wynik transkrypcji: ${transcript.result}\n` +
          `Transkrypcja ukończona w czasie ${endTime - startTime}ms`,
      );
      setStatusAndLog(`Zakończono transkrypcję w czasie ${endTime - startTime}ms!`);
    });
    promise.catch(error => {
      setStatusAndLog(`Błąd: ${error}`);
    });
    return promise;
  }

  async function startRecording() {
    try {
      setStatusAndLog('Żądanie uprawnień...');
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      if (isRecording) {
        setStatusAndLog('Zatrzymywanie poprzedniego nagrywania...');
        await isRecording.stopAndUnloadAsync();
      }
      setStatusAndLog('Rozpoczynanie nagrywania...');
      const {recording} = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      setProgress(-1);
      setElapsed(0);
      const timeNow = Date.now();
      const interval = setInterval(() => {
        setElapsed(Date.now() - timeNow);
      }, 1000);
      setIntervalFn(interval);
      setIsRecording(recording);
      setStatusAndLog('Nagrywanie...');
    } catch (err) {
      setStatusAndLog(`Nie udało się rozpocząć nagrywania: ${err}`, console.error);
    }
  }

  async function stopRecording() {
    if (isRecording) {
      setStatusAndLog('Zatrzymywanie nagrywania...');
      clearInterval(intervalFn);
      setElapsed(undefined);
      setIntervalFn(undefined);
      setIsRecording(undefined);
      await isRecording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
      });
      const uri = isRecording.getURI();
      log(`Nagrywanie zatrzymane i zapisane w ${uri}`);
      const fileName = getFilename('');
      const uriOut = `${docDir.fileDir}${fileName}.wav`;
      const wavFile = `${fileName}.wav`;
      await ensureDirExists(docDirName);
      setStatusAndLog('Konwertowanie pliku...');
      const noiseReductionString = settings.noiseReduction
        ? '-af "afftdn=nf=-25" '
        : '';
      const ffmpegCommand = `-i ${uri} -ar 16000 -ac 1 ${noiseReductionString}-c:a pcm_s16le ${uriOut}`;
      log(ffmpegCommand);
      FFmpegKit.execute(ffmpegCommand).then(async session => {
        const returnCode = await session.getReturnCode();

        if (ReturnCode.isSuccess(returnCode)) {
          log(`Pomyślnie zapisano przekonwertowany plik do ${uriOut}`);
          if (journalDir.saf) {
            const wavUri =
              await FileSystem.StorageAccessFramework.createFileAsync(
                journalDir.fileDir,
                fileName,
                'audio/x-wav',
              );
            const base64wav = await FileSystem.readAsStringAsync(uriOut, {
              encoding: 'base64',
            });
            await FileSystem.StorageAccessFramework.writeAsStringAsync(
              wavUri,
              base64wav,
              {encoding: 'base64'},
            );
          }
          const transcript = await transcribe(wavFile);
          if (transcript) {
            const {result} = transcript;
            setStatusAndLog('Zapisywanie do pliku...');
            let transcriptName = `${docDir.fileDir}${fileName}.md`;
            if (journalDir.saf) {
              transcriptName =
                await FileSystem.StorageAccessFramework.createFileAsync(
                  journalDir.fileDir,
                  fileName,
                  'text/markdown',
                );
              FileSystem.deleteAsync(uriOut, {idempotent: true}).then(() => {
                log(`Pomyślnie usunięto ${uriOut}`);
              });
            }
            FileSystem.writeAsStringAsync(transcriptName, result.trim()).then(
              () => {
                setStatusAndLog(`Zakończono zapisywanie do pliku '${fileName}'!`);
              },
            );
          }
        } else if (ReturnCode.isCancel(returnCode)) {
          log('Anulowano');
        } else {
          log('Błąd');
        }
      });
    }
  }

  const styles = StyleSheet.create({
    view: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: insets.top,
      paddingBottom: insets.bottom,
      paddingLeft: insets.left,
      paddingRight: insets.right,
    },
    progressBar: {
      width: 200,
    },
  });

  return (
    <View style={styles.view}>
      {canRecord ? (
        <IconButton
          icon={isRecording ? 'stop' : 'record'}
          mode="contained"
          onPress={isRecording ? stopRecording : startRecording}
          size={30}
          iconColor={isRecording ? undefined : 'red'}
        />
      ) : (
        <ActivityIndicator animating={true} size="large" />
      )}
      <Text>{status}</Text>
      <ProgressBar
        progress={progress}
        visible={progress !== -1 && progress !== 1}
        style={styles.progressBar}
      />
      {elapsed !== undefined && <Text>{formatTimeString(elapsed)}</Text>}
    </View>
  );
}
