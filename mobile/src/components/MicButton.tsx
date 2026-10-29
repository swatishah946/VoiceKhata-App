import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { MAX_RECORDING_SECONDS } from '@/lib/config';
import { useI18n } from '@/lib/i18n';
import { colors, font, space } from './theme';

/**
 * One big button: tap to start, tap to stop. (Hold-to-talk is hard for older
 * users; a tap is easier and the timer shows it is recording.)
 * Speech only needs 16 kHz mono; at 32 kbps a 20-second entry is about 80 KB,
 * which uploads quickly even on a weak 2G/3G signal.
 */
const VOICE = { ...RecordingPresets.HIGH_QUALITY, sampleRate: 16000, numberOfChannels: 1, bitRate: 32000 };

export function MicButton({ onRecorded }: { onRecorded(uri: string, durationSec: number, id: string): void }) {
  const { t } = useI18n();
  const recorder = useAudioRecorder(VOICE);
  const state = useAudioRecorderState(recorder, 250);
  const [denied, setDenied] = useState(false);
  const idRef = useRef<string | null>(null);
  const busy = useRef(false);

  async function start() {
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setDenied(true);
      return;
    }
    setDenied(false);
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    idRef.current = Crypto.randomUUID();
    await recorder.prepareToRecordAsync();
    recorder.record();
  }

  async function stop() {
    const seconds = Math.round(state.durationMillis / 1000);
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    const uri = recorder.uri;
    // Ignore accidental taps (less than a second)
    if (uri && idRef.current && state.durationMillis >= 1000) onRecorded(uri, seconds, idRef.current);
    idRef.current = null;
  }

  async function toggle() {
    if (busy.current) return;
    busy.current = true;
    try {
      if (state.isRecording) await stop();
      else await start();
    } finally {
      busy.current = false;
    }
  }

  // Auto-stop a forgotten recording
  useEffect(() => {
    if (state.isRecording && state.durationMillis >= MAX_RECORDING_SECONDS * 1000) void toggle();
  }, [state.isRecording, state.durationMillis]); // eslint-disable-line react-hooks/exhaustive-deps

  const secs = Math.floor(state.durationMillis / 1000);
  const recording = state.isRecording;
  return (
    <View style={styles.wrap}>
      <Pressable
        testID="mic-button"
        accessibilityRole="button"
        accessibilityLabel={recording ? t('tapToStop') : t('tapToSpeak')}
        onPress={toggle}
        style={({ pressed }) => [
          styles.mic,
          { backgroundColor: recording ? colors.recording : colors.primary, transform: [{ scale: pressed ? 0.96 : 1 }] },
        ]}
      >
        <Ionicons name={recording ? 'stop' : 'mic'} size={64} color="#fff" />
      </Pressable>
      <Text style={styles.label}>
        {recording ? `${t('recording')} ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : t('tapToSpeak')}
      </Text>
      {recording ? <Text style={styles.hint}>{t('tapToStop')}</Text> : <Text style={styles.hint}>{t('speakExample')}</Text>}
      {denied && <Text style={[styles.hint, { color: colors.danger }]}>{t('micDenied')}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingVertical: space.lg },
  mic: {
    width: 150,
    height: 150,
    borderRadius: 75,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
  },
  label: { fontSize: font.xl, fontWeight: '800', color: colors.text, marginTop: space.md },
  hint: { fontSize: font.sm, color: colors.muted, marginTop: space.xs, textAlign: 'center', paddingHorizontal: space.lg },
});
