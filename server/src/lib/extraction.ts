import { z } from 'zod';

/**
 * Validation for whatever Gemini returns. The AI's JSON is never trusted:
 * every field is checked and cleaned (e.g. "unit_rate": "25 rupaye" → 25,
 * negative or absurd amounts rejected), and entries with missing essentials
 * are rejected with the list of what is missing.
 */

const MAX_AMOUNT = 100_000_000; // ₹10 crore — anything larger is almost certainly a mis-hearing
const MAX_SQFT = 1_000_000;

/** Accepts 25, "25", "₹25", "25 rupaye", "1,50,000" → number. Empty → undefined. */
function numberish(max: number) {
  return z.preprocess((v) => {
    if (v === null || v === undefined || v === '') return undefined;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const cleaned = v.replace(/[₹,\s]/g, '').replace(/(rs\.?|rupaye|rupees?|inr)/gi, '');
      const m = cleaned.match(/^-?\d+(\.\d+)?/);
      return m ? Number(m[0]) : Number.NaN;
    }
    return Number.NaN;
  }, z.number().finite().min(0, 'cannot be negative').max(max).optional());
}

function nameish() {
  return z.preprocess((v) => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim().replace(/\s+/g, ' ');
    if (!t || ['null', 'none', 'unknown', '...', 'n/a'].includes(t.toLowerCase())) return undefined;
    return t.slice(0, 120);
  }, z.string().optional());
}

export const IntentSchema = z.enum(['TRANSACTION', 'UPDATE_PRICE', 'GET_PDF', 'GET_KHATA', 'GET_BALANCE']);
export const TransactionTypeSchema = z.enum(['dispatch', 'payment', 'worker_advance', 'freight_payment']);

export const ExtractionSchema = z.object({
  intent: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), IntentSchema),
  transaction_type: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() && v !== 'null' ? v.trim().toLowerCase() : undefined),
    TransactionTypeSchema.optional()
  ),
  party_name: nameish(),
  worker_name: nameish(),
  transporter_name: nameish(),
  person_name: nameish(),
  stone_type: nameish(),
  pieces_count: numberish(10_000_000),
  sqft_quantity: numberish(MAX_SQFT),
  unit_rate: numberish(100_000),
  amount: numberish(MAX_AMOUNT),
  freight_charge: numberish(MAX_AMOUNT),
  loading_charge: numberish(MAX_AMOUNT),
  packing_charge: numberish(MAX_AMOUNT),
  tax_percentage: numberish(100),
  updated_stone_type: nameish(),
  updated_rate: numberish(100_000),
  confidence_level: numberish(1).default(0),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

export type ValidationResult =
  | { ok: true; data: Extraction }
  | { ok: false; reason: 'invalid_json' | 'missing_fields' | 'low_confidence'; missing?: string[]; data?: Extraction };

/** Which fields each kind of entry cannot do without. */
export function missingEssentials(d: Extraction): string[] {
  const missing: string[] = [];
  if (d.intent === 'TRANSACTION') {
    switch (d.transaction_type) {
      case 'dispatch':
        if (!d.party_name) missing.push('party name');
        if (!d.sqft_quantity) missing.push('sqft');
        if (!d.unit_rate) missing.push('rate');
        break;
      case 'payment':
        if (!d.party_name) missing.push('party name');
        if (!d.amount) missing.push('amount');
        break;
      case 'worker_advance':
        if (!d.worker_name) missing.push('worker name');
        if (!d.amount) missing.push('amount');
        break;
      case 'freight_payment':
        if (!d.transporter_name && !d.party_name && !d.worker_name) missing.push('transporter name');
        if (!d.amount) missing.push('amount');
        break;
      default:
        missing.push('type of entry (dispatch / payment / advance)');
    }
  } else if (d.intent === 'UPDATE_PRICE') {
    if (!d.updated_stone_type) missing.push('stone size');
    if (!d.updated_rate) missing.push('new rate');
  } else if (d.intent === 'GET_KHATA' || d.intent === 'GET_BALANCE') {
    if (!d.person_name) missing.push('person name');
  }
  return missing;
}

export function validateExtraction(raw: unknown, minConfidence: number): ValidationResult {
  const parsed = ExtractionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid_json' };

  const data = parsed.data;
  const missing = missingEssentials(data);
  if (missing.length) return { ok: false, reason: 'missing_fields', missing, data };

  // Read-only requests (price list / khata) are harmless, so only money-changing
  // intents are held to the confidence threshold.
  const changesMoney = data.intent === 'TRANSACTION' || data.intent === 'UPDATE_PRICE';
  if (changesMoney && (data.confidence_level ?? 0) < minConfidence) {
    return { ok: false, reason: 'low_confidence', data };
  }
  return { ok: true, data };
}
