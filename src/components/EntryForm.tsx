import { Pressable, StyleSheet, Text, View } from 'react-native';
import { FIELDS_BY_TYPE, ENTRY_TYPES, isNumeric, type FormValues } from '@/lib/review';
import { FIELD_LABELS, TYPE_LABELS, useI18n } from '@/lib/i18n';
import type { EntryType, FieldKey } from '@/lib/types';
import { colors, font, space } from './theme';
import { Field } from './ui';

/** The editable entry: type chips + the fields that type needs. */
export function EntryForm({
  type,
  form,
  highlight = [],
  onTypeChange,
  onFieldChange,
}: {
  type: EntryType;
  form: FormValues;
  highlight?: FieldKey[];
  onTypeChange(t: EntryType): void;
  onFieldChange(f: FieldKey, value: string): void;
}) {
  const { lang } = useI18n();
  return (
    <View>
      <View style={styles.chips}>
        {ENTRY_TYPES.map((et) => (
          <Pressable
            key={et}
            testID={`type-${et}`}
            accessibilityRole="radio"
            accessibilityState={{ selected: et === type }}
            onPress={() => onTypeChange(et)}
            style={[styles.chip, et === type && styles.chipOn]}
          >
            <Text style={[styles.chipText, et === type && { color: colors.primaryText }]}>{TYPE_LABELS[lang][et]}</Text>
          </Pressable>
        ))}
      </View>
      {FIELDS_BY_TYPE[type].map((f) => (
        <Field
          key={f}
          testID={`field-${f}`}
          label={FIELD_LABELS[lang][f]}
          value={form[f] ?? ''}
          onChangeText={(v) => onFieldChange(f, v)}
          keyboardType={isNumeric(f) ? 'decimal-pad' : 'default'}
          autoCapitalize={isNumeric(f) ? 'none' : 'words'}
          error={highlight.includes(f)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md },
  chip: { paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: 20, borderWidth: 2, borderColor: colors.primary },
  chipOn: { backgroundColor: colors.primary },
  chipText: { fontSize: font.md, color: colors.primary, fontWeight: '600' },
});
