import { useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { FIELD_LABELS, useI18n } from '@/lib/i18n';
import { formatINR } from '@/lib/money';
import { checkForm, estimateTotal, initialForm, toEdits, type FormValues } from '@/lib/review';
import { useSync } from '@/lib/sync-context';
import type { Entry, EntryType, FieldKey, UploadView } from '@/lib/types';
import { EntryForm } from '@/components/EntryForm';
import { Banner, Button, Card, Loading, Muted, styles } from '@/components/ui';
import { colors, space } from '@/components/theme';

/**
 * Replaces WhatsApp's "yes / no": he sees what was understood, fixes any
 * number with one tap, and saves. The server re-checks and re-calculates.
 */
export default function Review() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, lang } = useI18n();
  const { recordings, markDone } = useSync();
  const queryClient = useQueryClient();
  const local = recordings.find((r) => r.id === id);

  const upload = useQuery({
    queryKey: ['upload', local?.uploadId],
    enabled: !!local?.uploadId,
    queryFn: () => api<UploadView>(`/app/voice/${local!.uploadId}`),
  });

  const entry = upload.data?.entry as Entry | undefined;
  const original = useMemo(() => upload.data?.fields ?? {}, [upload.data]);
  const [type, setType] = useState<EntryType>('dispatch');
  const [form, setForm] = useState<FormValues>({});
  const [highlight, setHighlight] = useState<FieldKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'cancel' | null>(null);

  useEffect(() => {
    if (!entry) return;
    setType(entry.transactionType);
    setForm(initialForm(original));
  }, [entry?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!local) return <Banner text={t('alreadyDone')} />;
  if (upload.isLoading || !entry) {
    return upload.error ? <Banner text={t('offline')} tone="warning" /> : <Loading />;
  }
  if (entry.status !== 'pending_confirmation') return <Banner text={t('alreadyDone')} />;

  const total = estimateTotal(type, form);
  const labels = FIELD_LABELS[lang];

  async function finish(status: 'saved' | 'cancelled') {
    await markDone(id, status);
    await queryClient.invalidateQueries();
    router.back();
  }

  async function save() {
    const problems = checkForm(type, form);
    if (problems.missing.length || problems.invalid.length) {
      setHighlight([...problems.missing, ...problems.invalid]);
      setError(
        problems.missing.length
          ? t('required', { fields: problems.missing.map((f) => labels[f]).join(', ') })
          : t('invalidNumber', { fields: problems.invalid.map((f) => labels[f]).join(', ') })
      );
      return;
    }
    setBusy('save');
    setError(null);
    try {
      await api(`/app/entries/${entry!.id}/save`, {
        method: 'POST',
        body: { edits: toEdits(original, entry!.transactionType, type, form) },
      });
      await finish('saved');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return finish('saved');
      if (err instanceof ApiError && err.status === 422) setError(t('required', { fields: (err.body?.missing ?? []).join(', ') }));
      else setError(err instanceof ApiError && err.isOffline ? t('offline') : (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function cancel() {
    Alert.alert(t('cancelEntry'), '', [
      { text: '←', style: 'cancel' },
      {
        text: t('cancelEntry'),
        style: 'destructive',
        onPress: async () => {
          setBusy('cancel');
          try {
            await api(`/app/entries/${entry!.id}/cancel`, { method: 'POST' });
            await finish('cancelled');
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) await finish('cancelled');
            else setError(t('offline'));
          } finally {
            setBusy(null);
          }
        },
      },
    ]);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {upload.data?.transcript && (
        <Card style={{ backgroundColor: colors.infoBg }}>
          <Muted>{t('heard')}</Muted>
          <Text style={styles.body}>“{upload.data.transcript}”</Text>
        </Card>
      )}
      {upload.data?.reason === 'low_confidence' && <Banner text={t('lowConfidence')} tone="warning" />}
      {entry.priceWarning && (
        <Banner
          tone="warning"
          text={t('priceWarning', { pct: Math.abs(entry.priceWarning.diffPercent), master: entry.priceWarning.masterRate })}
        />
      )}
      {entry.counterparty?.isNew && <Banner text={`${t('newParty')}: ${entry.counterparty.name}`} />}

      <EntryForm
        type={type}
        form={form}
        highlight={highlight}
        onTypeChange={setType}
        onFieldChange={(f, v) => {
          setForm((prev) => ({ ...prev, [f]: v }));
          setHighlight((h) => h.filter((x) => x !== f));
        }}
      />

      <Card>
        <View style={styles.row}>
          <Text style={styles.h2}>{t('estimate')}</Text>
          <Text testID="estimate" style={[styles.h1, { color: colors.primary }]}>
            {total === null ? '—' : formatINR(total)}
          </Text>
        </View>
        <Muted>Ref {entry.refCode}</Muted>
      </Card>

      {error && <Banner text={error} tone="danger" />}
      <Button testID="save" title={t('save')} onPress={save} loading={busy === 'save'} disabled={!!busy} />
      <View style={{ height: space.sm }} />
      <Button title={t('cancelEntry')} variant="secondary" onPress={cancel} loading={busy === 'cancel'} disabled={!!busy} />
    </ScrollView>
  );
}
