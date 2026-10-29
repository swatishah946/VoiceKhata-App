import { useState } from 'react';
import { Linking, ScrollView, Share, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { TYPE_LABELS, useI18n } from '@/lib/i18n';
import { formatINRShort, toPaise } from '@/lib/money';
import { reminderMessage, whatsAppLink } from '@/lib/reminders';
import { getUpiId } from '@/lib/settings';
import { downloadAndSharePdf } from '@/lib/share';
import type { PartyDetail } from '@/lib/types';
import { Banner, Button, Card, Loading, Muted, styles } from '@/components/ui';
import { colors, space } from '@/components/theme';

export default function Party() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, lang } = useI18n();
  const { session } = useAuth();
  const party = useQuery({ queryKey: ['party', id], queryFn: () => api<PartyDetail>(`/parties/${id}`) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (party.isLoading) return <Loading />;
  if (!party.data) return <Banner text={t('offline')} tone="warning" />;
  const p = party.data;
  const due = toPaise(Number(p.outstanding_balance ?? 0));

  async function sharePdf() {
    setBusy(true);
    setError(null);
    try {
      await downloadAndSharePdf(`/parties/${p.id}/khata.pdf`, `Khata_${p.name}.pdf`, t('sharePdf'));
    } catch {
      setError(t('offline'));
    } finally {
      setBusy(false);
    }
  }

  async function remind() {
    const message = reminderMessage({
      partyName: p.name,
      amountPaise: due,
      businessName: session?.business.name ?? 'VoiceKhata',
      upiId: await getUpiId(),
    });
    const link = whatsAppLink(p.phone, message);
    if (link) await Linking.openURL(link);
    else await Share.share({ message });
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: p.name }} />
      <Card>
        <Muted>{t('balance')}</Muted>
        <Text style={[styles.h1, { color: due > 0 ? colors.danger : colors.success, fontSize: 32 }]}>{formatINRShort(due)}</Text>
      </Card>
      {error && <Banner text={error} tone="danger" />}
      <Button title={t('sharePdf')} onPress={sharePdf} loading={busy} />
      {due > 0 && <Button title={t('sendReminder')} variant="secondary" onPress={() => void remind()} />}

      <Text style={[styles.h2, { marginTop: space.lg }]}>{t('entries')}</Text>
      {p.transactions
        .filter((x) => x.status === 'confirmed')
        .map((x) => {
          const amount = x.transaction_type === 'dispatch' ? Number(x.total_amount) : -Number(x.advance_paid);
          return (
            <View key={x.id} style={[styles.card, styles.row, { marginBottom: space.sm }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.body}>{TYPE_LABELS[lang][x.transaction_type]}</Text>
                <Muted>
                  {new Date(x.created_at).toLocaleDateString('en-IN')}
                  {x.sqft_quantity ? ` · ${Number(x.sqft_quantity)} sqft × ₹${Number(x.unit_rate)}` : ''}
                </Muted>
              </View>
              <Text style={{ fontWeight: '800', fontSize: 17, color: amount > 0 ? colors.text : colors.success }}>
                {formatINRShort(toPaise(amount))}
              </Text>
            </View>
          );
        })}
    </ScrollView>
  );
}
