import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { colors, font, space } from './theme';

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  testID,
}: {
  title: string;
  onPress(): void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
}) {
  const bg = variant === 'primary' ? colors.primary : variant === 'danger' ? colors.danger : colors.card;
  const fg = variant === 'secondary' ? colors.primary : colors.primaryText;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        variant === 'secondary' && styles.buttonOutline,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Banner({ text, tone = 'info' }: { text: string; tone?: 'info' | 'warning' | 'success' | 'danger' }) {
  const bg = { info: colors.infoBg, warning: colors.warningBg, success: colors.successBg, danger: '#FDE7E6' }[tone];
  const fg = { info: colors.text, warning: colors.warning, success: colors.success, danger: colors.danger }[tone];
  return (
    <View style={[styles.banner, { backgroundColor: bg }]} accessibilityRole="alert">
      <Text style={{ color: fg, fontSize: font.md }}>{text}</Text>
    </View>
  );
}

export function Field({ label, error, ...props }: TextInputProps & { label: string; error?: boolean }) {
  return (
    <View style={{ marginBottom: space.md }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        style={[styles.input, error && { borderColor: colors.danger, borderWidth: 2 }]}
        {...props}
      />
    </View>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={{ color: colors.muted, fontSize: font.sm }}>{children}</Text>;
}

export function Loading() {
  return (
    <View style={{ padding: space.xl, alignItems: 'center' }}>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, paddingBottom: space.xl * 2 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: space.lg,
    marginBottom: space.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  button: { minHeight: 54, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg, marginVertical: space.xs },
  buttonOutline: { borderWidth: 2, borderColor: colors.primary },
  buttonText: { fontSize: font.lg, fontWeight: '700' },
  banner: { borderRadius: 10, padding: space.md, marginBottom: space.md },
  label: { fontSize: font.md, color: colors.muted, marginBottom: space.xs },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    fontSize: font.lg,
    color: colors.text,
  },
  h1: { fontSize: font.xl, fontWeight: '800', color: colors.text, marginBottom: space.sm },
  h2: { fontSize: font.lg, fontWeight: '700', color: colors.text, marginBottom: space.sm },
  body: { fontSize: font.md, color: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
