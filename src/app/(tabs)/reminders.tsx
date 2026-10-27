import { Linking, RefreshControl, ScrollView, Share, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useCachedQuery } from '@/lib/queries';
import { formatINRShort } from '@/lib/money';
import { reminderMessage, whatsAppLink } from '@/lib/reminders';
import { getUpiId } from '@/lib/settings';
import type { AgeBucket, AgeingReport } from '@/lib/types';
import { Banner, Button, Card, Loading, Muted, styles } from '@/components/ui';
import { colors, space } from '@/components/theme';

const BUCKETS: AgeBucket[] = ['0-30', '31-60', '61-90', '90+'];
const BUCKET_COLOR: Record<AgeBucket, string> = { '0-30': colors.success, '31-60': colors.warning, '61-90': '#B85C00', '90+': colors.danger };

/** Who owes money and for how long — oldest dues first. */
export default function Reminders() {
  const { t } = useI18n();
  const { session } = useAuth();
  const report = useCachedQuery<AgeingReport>('ageing', '/app/reports/ageing');

  async function remind(row: AgeingReport['rows'][number]) {
    const message = reminderMessage({
      partyName: row.name,
      amountPaise: row.outstanding,
      businessName: session?.business.name ?? 'VoiceKhata',
      upiId: await getUpiId(),
      days: row.oldestUnpaidDays,
    });
    const link = whatsAppLink(row.phone, message);
    if (link) await Linking.openURL(link);
    else await Share.share({ message });
  }

  if (report.isLoading) return <Loading />;
  const data = report.data?.data;
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={report.isFetching} onRefresh={() => void report.refetch()} />}
    >
      {report.data?.offlineSince && (
        <Banner tone="warning" text={t('lastUpdated', { time: new Date(report.data.offlineSince).toLocaleString('en-IN') })} />
      )}
      {!data && <Banner tone="warning" text={t('offline')} />}
      {data && (
        <Card>
          <Text style={styles.h2}>
            {t('marketDue')}: {formatINRShort(data.totalOutstanding)}
          </Text>
          <View style={styles.row}>
            {BUCKETS.map((b) => (
              <View key={b} style={{ flex: 1 }}>
                <Text style={{ color: BUCKET_COLOR[b], fontWeight: '700' }}>{t('days', { n: b })}</Text>
                <Text style={{ fontWeight: '800', fontSize: 15 }}>{formatINRShort(data.totals[b])}</Text>
              </View>
            ))}
          </View>
        </Card>
      )}
      {data && data.rows.length === 0 && <Muted>{t('noDues')}</Muted>}
      {data?.rows.map((row) => {
        const worst = [...BUCKETS].reverse().find((b) => row.buckets[b] > 0) ?? '0-30';
        return (
          <Card key={row.partyId}>
            <View style={styles.row}>
              <Text
                style={[styles.h2, { flex: 1, marginBottom: 0 }]}
                onPress={() => router.push({ pathname: '/party/[id]', params: { id: row.partyId } })}
              >
                {row.name}
              </Text>
              <Text style={{ fontSize: 20, fontWeight: '800', color: BUCKET_COLOR[worst] }}>{formatINRShort(row.outstanding)}</Text>
            </View>
            {row.oldestUnpaidDays !== null && (
              <Muted>
                {t('overdue')}: {t('days', { n: row.oldestUnpaidDays })}
              </Muted>
            )}
            <Button title={t('sendReminder')} variant="secondary" onPress={() => void remind(row)} />
          </Card>
        );
      })}
    </ScrollView>
  );
}
