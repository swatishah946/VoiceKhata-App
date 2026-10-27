import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useI18n } from '@/lib/i18n';
import { useCachedQuery } from '@/lib/queries';
import { formatINRShort, toPaise } from '@/lib/money';
import type { PartySummary } from '@/lib/types';
import { Banner, Field, Loading, Muted, styles } from '@/components/ui';
import { colors, space } from '@/components/theme';

export default function Khata() {
  const { t } = useI18n();
  const parties = useCachedQuery<PartySummary[]>('parties', '/parties');
  const [q, setQ] = useState('');

  const list = useMemo(() => {
    const all = parties.data?.data ?? [];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((p) => p.name.toLowerCase().includes(needle)) : all;
  }, [parties.data, q]);

  return (
    <View style={styles.screen}>
      <View style={{ padding: space.lg, paddingBottom: 0 }}>
        <Field label={t('searchParty')} value={q} onChangeText={setQ} placeholder="Ramesh…" />
        {parties.data?.offlineSince && (
          <Banner tone="warning" text={t('lastUpdated', { time: new Date(parties.data.offlineSince).toLocaleString('en-IN') })} />
        )}
        {parties.error && !parties.data && <Banner tone="warning" text={t('offline')} />}
      </View>
      {parties.isLoading ? (
        <Loading />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ padding: space.lg, paddingTop: space.sm }}
          refreshControl={<RefreshControl refreshing={parties.isFetching} onRefresh={() => void parties.refetch()} />}
          ListEmptyComponent={<Muted>{t('noParties')}</Muted>}
          renderItem={({ item }) => {
            const due = toPaise(Number(item.outstanding_balance ?? 0));
            return (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push({ pathname: '/party/[id]', params: { id: item.id } })}
                style={[styles.card, styles.row, { marginBottom: space.sm }]}
              >
                <Text style={[styles.body, { flex: 1, fontWeight: '600' }]} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={{ fontSize: 18, fontWeight: '800', color: due > 0 ? colors.danger : colors.success }}>
                  {formatINRShort(due)}
                </Text>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}
