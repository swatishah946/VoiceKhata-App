import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { loginErrorKey, useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { Banner, Button, Field, Muted, styles } from '@/components/ui';
import { colors, space } from '@/components/theme';

export default function Login() {
  const { login } = useAuth();
  const { t, lang, setLang } = useI18n();
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await login(phone, pin);
    } catch (err) {
      setError(t(loginErrorKey(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={[styles.content, { flexGrow: 1, justifyContent: 'center' }]} keyboardShouldPersistTaps="handled">
          <View style={{ alignItems: 'center', marginBottom: space.xl }}>
            <Ionicons name="mic-circle" size={88} color={colors.primary} />
            <Text style={[styles.h1, { fontSize: 32 }]}>{t('appName')}</Text>
          </View>
          {error && <Banner text={error} tone="danger" />}
          <Field
            testID="login-phone"
            label={t('phone')}
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            autoComplete="tel"
            placeholder="98765 43210"
          />
          <Field
            testID="login-pin"
            label={t('pin')}
            value={pin}
            onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad"
            secureTextEntry
            placeholder="••••"
          />
          <Button testID="login-submit" title={t('login')} onPress={submit} loading={busy} disabled={phone.length < 10 || pin.length < 4} />
          <View style={{ marginTop: space.md, alignItems: 'center' }}>
            <Muted>{t('loginHelp')}</Muted>
          </View>
          <View style={{ marginTop: space.xl }}>
            <Button title={lang === 'hi' ? 'English' : 'हिंदी'} variant="secondary" onPress={() => setLang(lang === 'hi' ? 'en' : 'hi')} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
