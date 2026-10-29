import { Tabs } from 'expo-router/js-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useI18n } from '@/lib/i18n';
import { useSync } from '@/lib/sync-context';
import { colors } from '@/components/theme';

export default function TabsLayout() {
  const { t } = useI18n();
  const { recordings } = useSync();
  const toReview = recordings.filter((r) => r.status === 'ready').length;
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: colors.primaryText,
        headerTitleStyle: { fontWeight: '700' },
        tabBarActiveTintColor: colors.primary,
        tabBarLabelStyle: { fontSize: 13, fontWeight: '600' },
        tabBarStyle: { height: 64, paddingBottom: 8 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('home'),
          headerTitle: t('appName'),
          tabBarBadge: toReview || undefined,
          tabBarIcon: ({ color, size }) => <Ionicons name="mic" color={String(color)} size={size} />,
        }}
      />
      <Tabs.Screen
        name="khata"
        options={{ title: t('khata'), tabBarIcon: ({ color, size }) => <Ionicons name="book" color={String(color)} size={size} /> }}
      />
      <Tabs.Screen
        name="reminders"
        options={{ title: t('reminders'), tabBarIcon: ({ color, size }) => <Ionicons name="alarm" color={String(color)} size={size} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: t('settings'), tabBarIcon: ({ color, size }) => <Ionicons name="settings" color={String(color)} size={size} /> }}
      />
    </Tabs>
  );
}
