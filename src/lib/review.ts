import { dispatchTotal, toPaise, type Paise } from './money';
import type { AiFields, EntryType, FieldKey } from './types';

/**
 * Logic for the review screen: which fields to show for each kind of entry,
 * what he changed, and a live estimate of the total. The server re-checks
 * and re-calculates everything on Save; this is only for a quick, clear screen.
 */

export const ENTRY_TYPES: EntryType[] = ['dispatch', 'payment', 'worker_advance', 'freight_payment'];

export const FIELDS_BY_TYPE: Record<EntryType, FieldKey[]> = {
  dispatch: ['party_name', 'stone_type', 'sqft_quantity', 'unit_rate', 'pieces_count', 'loading_charge', 'packing_charge', 'freight_charge', 'tax_percentage'],
  payment: ['party_name', 'amount'],
  worker_advance: ['worker_name', 'amount'],
  freight_payment: ['transporter_name', 'amount'],
};

/** Must be filled before Save (same rules as the backend). */
export const REQUIRED_BY_TYPE: Record<EntryType, FieldKey[]> = {
  dispatch: ['party_name', 'sqft_quantity', 'unit_rate'],
  payment: ['party_name', 'amount'],
  worker_advance: ['worker_name', 'amount'],
  freight_payment: ['transporter_name', 'amount'],
};

const TEXT_FIELDS = new Set<FieldKey>(['party_name', 'worker_name', 'transporter_name', 'stone_type']);
export const isNumeric = (f: FieldKey) => !TEXT_FIELDS.has(f);

export type FormValues = Partial<Record<FieldKey, string>>;

export function initialForm(fields: AiFields = {}): FormValues {
  const form: FormValues = {};
  for (const type of ENTRY_TYPES) {
    for (const f of FIELDS_BY_TYPE[type]) {
      const v = fields[f];
      form[f] = v === null || v === undefined ? '' : String(v);
    }
  }
  return form;
}

/** "1,50,000" / "₹ 31.5" → number; '' → null; anything else → NaN */
export function parseNumber(input: string | undefined): number | null {
  const s = (input ?? '').replace(/[₹,\s]/g, '');
  if (!s) return null;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN;
}

function valueOf(f: FieldKey, form: FormValues): string | number | null {
  const raw = form[f] ?? '';
  if (isNumeric(f)) return parseNumber(raw);
  const t = raw.trim().replace(/\s+/g, ' ');
  return t ? t : null;
}

export interface FormProblems {
  missing: FieldKey[];
  invalid: FieldKey[];
}

export function checkForm(type: EntryType, form: FormValues): FormProblems {
  const missing = REQUIRED_BY_TYPE[type].filter((f) => {
    const v = valueOf(f, form);
    return v === null || v === 0;
  });
  const invalid = FIELDS_BY_TYPE[type].filter((f) => {
    const v = valueOf(f, form);
    return typeof v === 'number' && !Number.isFinite(v);
  });
  return { missing, invalid };
}

function same(a: unknown, b: unknown) {
  const norm = (v: unknown) =>
    v === null || v === undefined || v === '' ? null : typeof v === 'string' ? v.trim().toLowerCase() : Number(v);
  return norm(a) === norm(b);
}

/** Only what he changed, in the shape the backend expects. Empty object = AI was right. */
export function toEdits(original: AiFields, originalType: EntryType, type: EntryType, form: FormValues) {
  const edits: Record<string, string | number | null> = {};
  if (type !== originalType) edits.transaction_type = type;
  for (const f of FIELDS_BY_TYPE[type]) {
    const v = valueOf(f, form);
    if (!same(original[f], v)) edits[f] = v;
  }
  return edits;
}

/** Live total while editing (paise), or null if the needed numbers aren't valid yet. */
export function estimateTotal(type: EntryType, form: FormValues): Paise | null {
  if (type !== 'dispatch') {
    const amount = parseNumber(form.amount);
    return amount !== null && Number.isFinite(amount) ? toPaise(amount) : null;
  }
  const sqft = parseNumber(form.sqft_quantity);
  const rate = parseNumber(form.unit_rate);
  if (sqft === null || rate === null || !Number.isFinite(sqft) || !Number.isFinite(rate)) return null;
  const n = (f: FieldKey) => {
    const v = parseNumber(form[f]);
    return v !== null && Number.isFinite(v) ? v : 0;
  };
  return dispatchTotal({
    sqft,
    rate,
    loading: n('loading_charge'),
    packing: n('packing_charge'),
    freight: n('freight_charge'),
    taxPercent: n('tax_percentage'),
  });
}
