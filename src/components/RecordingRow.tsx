import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Recording } from '@/lib/recordings';
import { useI18n, type TKey } from '@/lib/i18n';
import { colors, font, space } from './theme';
import { Button } from './ui';

const STATUS: Record<Recording['status'], { key: TKey; icon: keyof typeof Ionicons.glyphMap; color: string }> = {
  waiting: { key: 'sending', icon: 'cloud-offline-outline', color: colors.warning },
  processing: { key: 'processing', icon: 'hourglass-outline', color: colors.muted },
  ready: { key: 'toReview', icon: 'create-outline', color: colors.primary },
  rejected: { key: 'rejected', icon: 'alert-circle-outline', color: colors.danger },
  failed: { key: 'failed', icon: 'refresh-circle-outline', color: colors.danger },
  saved: { key: 'saved', icon: 'checkmark-circle', color: colors.success },
  cancelled: { key: 'cancelled', icon: 'close-circle-outline', color: colors.muted },
};

export function reasonText(r: Recording, t: (k: TKey, v?: Record<string, string | number>) => string) {
  switch (r.reason) {
    case 'missing_fields':
      return t('reason_missing_fields', { fields: r.missing.join(', ') });
    case 'not_understood':
    case 'not_an_entry':
    case 'too_long':
    case 'server_error':
      return t(`reason_${r.reason}` as TKey);
    default:
      return t('reason_other');
  }
}

export function RecordingRow({
  r,
  onOpen,
  onRetry,
  onDismiss,
}: {
  r: Recording;
  onOpen(): void;
  onRetry(): void;
  onDismiss(): void;
}) {
  const { t } = useI18n();
  const s = STATUS[r.status];
  const time = new Date(r.recordedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  return (
    <Pressable
      testID={`recording-${r.id}`}
      onPress={r.status === 'ready' ? onOpen : undefined}
      style={styles.row}
      accessibilityRole={r.status === 'ready' ? 'button' : undefined}
    >
      <View style={styles.top}>
        <Ionicons name={s.icon} size={26} color={s.color} />
        <View style={{ flex: 1, marginLeft: space.sm }}>
          <Text style={[styles.status, { color: s.color }]}>{t(s.key)}</Text>
          <Text style={styles.sub} numberOfLines={2}>
            {time} · {r.durationSec}s{r.transcript ? ` · “${r.transcript}”` : ''}
          </Text>
        </View>
        {r.status === 'ready' && <Ionicons name="chevron-forward" size={24} color={colors.primary} />}
      </View>
      {r.status === 'rejected' && <Text style={styles.reason}>{reasonText(r, t)}</Text>}
      {r.status === 'failed' && <Text style={styles.reason}>{t('reason_server_error')}</Text>}
      {(r.status === 'failed' || r.status === 'rejected') && (
        <View style={styles.actions}>
          {r.status === 'failed' && (
            <View style={{ flex: 1 }}>
              <Button title={t('tryAgain')} onPress={onRetry} />
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Button title={t('dismiss')} variant="secondary" onPress={onDismiss} />
          </View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { backgroundColor: colors.card, borderRadius: 12, padding: space.md, marginBottom: space.sm, borderWidth: 1, borderColor: colors.border },
  top: { flexDirection: 'row', alignItems: 'center' },
  status: { fontSize: font.lg, fontWeight: '700' },
  sub: { fontSize: font.sm, color: colors.muted, marginTop: 2 },
  reason: { fontSize: font.md, color: colors.text, marginTop: space.sm },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
});
