import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useI18n } from '@/lib/i18n';
import { useSync } from '@/lib/sync-context';
import { useCachedQuery } from '@/lib/queries';
import { formatINRShort } from '@/lib/money';
import type { TodaySummary } from '@/lib/types';
import { MicButton } from '@/components/MicButton';
import { RecordingRow } from '@/components/RecordingRow';
import { Banner, Card, Muted, styles } from '@/components/ui';
import { colors, space } from '@/components/theme';

export default function Home() {
  const { t } = useI18n();
  const { recordings, online, syncing, addRecording, sync, retry, dismiss } = useSync();
  const summary = useCachedQuery<TodaySummary>('summary', '/summary/today');

  const active = recordings.filter((r) => r.status !== 'saved' && r.status !== 'cancelled');
  const done = recordings.filter((r) => r.status === 'saved').slice(0, 5);
  const waiting = recordings.filter((r) => r.status === 'waiting').length;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={syncing} onRefresh={() => { void sync(); void summary.refetch(); }} />}
    >
      {!online && <Banner text={waiting ? t('offlineSaved') : t('offline')} tone="warning" />}

      <MicButton onRecorded={(uri, secs, id) => void addRecording(uri, secs, id)} />

      {summary.data && (
        <Card>
          <Text style={styles.h2}>{t('today')}</Text>
          <View style={styles.row}>
            <Stat label={t('dispatched')} value={formatINRShort(summary.data.data.dispatchTotal)} />
            <Stat label={t('received')} value={formatINRShort(summary.data.data.paymentsTotal)} />
            <Stat label={t('marketDue')} value={formatINRShort(summary.data.data.marketDue)} />
          </View>
          {summary.data.offlineSince && (
            <Muted>{t('lastUpdated', { time: new Date(summary.data.offlineSince).toLocaleString('en-IN') })}</Muted>
          )}
        </Card>
      )}

      <Text style={[styles.h2, { marginTop: space.sm }]}>{t('recentEntries')}</Text>
      {active.length === 0 && done.length === 0 && <Muted>{t('nothingYet')}</Muted>}
      {[...active, ...done].map((r) => (
        <RecordingRow
          key={r.id}
          r={r}
          onOpen={() => router.push({ pathname: '/review/[id]', params: { id: r.id } })}
          onRetry={() => void retry(r.id)}
          onDismiss={() => void dismiss(r.id)}
        />
      ))}
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ color: colors.muted, fontSize: 13 }}>{label}</Text>
      <Text style={{ color: colors.text, fontSize: 18, fontWeight: '800' }}>{value}</Text>
    </View>
  );
}
