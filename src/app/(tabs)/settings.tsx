import { useEffect, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import Constants from 'expo-constants';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { isValidUpiId } from '@/lib/reminders';
import { getUpiId, setUpiId } from '@/lib/settings';
import { downloadAndSharePdf } from '@/lib/share';
import { Banner, Button, Card, Field, Muted, styles } from '@/components/ui';
import { space } from '@/components/theme';

export default function Settings() {
  const { t, lang, setLang } = useI18n();
  const { session, logout } = useAuth();
  const [upi, setUpi] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getUpiId().then((v) => setUpi(v ?? ''));
  }, []);

  const upiOk = !upi || isValidUpiId(upi);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card>
        <Muted>{t('business')}</Muted>
        <Text style={styles.h2}>{session?.business.name}</Text>
        <Muted>{t('you')}</Muted>
        <Text style={styles.body}>
          {session?.member.name ?? ''} · {session?.member.phone} · {session?.member.role}
        </Text>
      </Card>

      <Card>
        <Field
          label={t('upiId')}
          value={upi}
          onChangeText={(v) => {
            setUpi(v);
            setSaved(false);
          }}
          autoCapitalize="none"
          placeholder="name@okaxis"
          error={!upiOk}
        />
        {!upiOk && <Banner tone="danger" text={t('upiInvalid')} />}
        {saved && <Banner tone="success" text={t('savedOk')} />}
        <Button
          title={t('save')}
          disabled={!upiOk}
          onPress={async () => {
            await setUpiId(upi || null);
            setSaved(true);
          }}
        />
      </Card>

      <Card>
        <Muted>{t('language')}</Muted>
        <Button title={lang === 'hi' ? 'English' : 'हिंदी'} variant="secondary" onPress={() => setLang(lang === 'hi' ? 'en' : 'hi')} />
      </Card>

      <Button
        title={t('priceList')}
        variant="secondary"
        onPress={() => void downloadAndSharePdf('/app/price-list.pdf', 'Price_List.pdf', t('priceList')).catch(() => undefined)}
      />
      <Button title={t('logout')} variant="danger" onPress={() => void logout()} />
      <Muted>
        {'\n'}
        {t('version')}: {Constants.expoConfig?.version}
      </Muted>
      <Text style={{ height: space.xl }} />
    </ScrollView>
  );
}
