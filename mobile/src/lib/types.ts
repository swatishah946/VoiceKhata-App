import type { Paise } from './money';

export interface Member {
  phone: string;
  name: string | null;
  role: 'owner' | 'staff';
}

export interface Session {
  token: string;
  member: Member;
  business: { name: string };
}

export type EntryType = 'dispatch' | 'payment' | 'worker_advance' | 'freight_payment';

/** A pending (or saved) entry, as the backend describes it. Money in paise. */
export interface Entry {
  id: string;
  status: 'pending_confirmation' | 'confirmed' | 'cancelled' | 'reversed';
  refCode: string;
  transactionType: EntryType;
  counterparty: { id: string | null; name: string; isNew: boolean; spokenName: string } | null;
  stoneType?: string;
  pieces?: number;
  sqft?: number;
  rate?: number;
  loading: Paise;
  packing: Paise;
  taxPercent: number;
  tax: Paise;
  freight: Paise;
  subtotal: Paise;
  total: Paise;
  amount: Paise;
  priceWarning: { masterRate: number; spokenRate: number; diffPercent: number } | null;
}

export type FieldKey =
  | 'party_name' | 'worker_name' | 'transporter_name' | 'stone_type' | 'pieces_count' | 'sqft_quantity'
  | 'unit_rate' | 'amount' | 'freight_charge' | 'loading_charge' | 'packing_charge' | 'tax_percentage';

export type AiFields = Partial<Record<FieldKey | 'transaction_type', string | number | null>>;

/** GET /api/app/voice/:id */
export interface UploadView {
  uploadId: string;
  clientEntryId: string;
  status: 'queued' | 'ready' | 'rejected' | 'failed';
  reason: string | null;
  missing: string[];
  transcript: string | null;
  createdAt: string;
  entry?: Entry | null;
  fields?: AiFields;
}

export interface PartySummary {
  id: string;
  name: string;
  type: string;
  total_billed: string | null;
  total_paid: string | null;
  outstanding_balance: string | null;
  last_payment_date: string | null;
}

export interface PartyDetail extends PartySummary {
  phone: string | null;
  transactions: Array<{
    id: string;
    transaction_type: EntryType;
    status: string;
    stone_type_text: string | null;
    sqft_quantity: string | null;
    unit_rate: string | null;
    total_amount: string | null;
    advance_paid: string | null;
    created_at: string;
  }>;
}

export type AgeBucket = '0-30' | '31-60' | '61-90' | '90+';
export interface AgeingReport {
  rows: Array<{
    partyId: string;
    name: string;
    phone: string | null;
    outstanding: Paise;
    buckets: Record<AgeBucket, Paise>;
    oldestUnpaidDays: number | null;
  }>;
  totals: Record<AgeBucket, Paise>;
  totalOutstanding: Paise;
}

export interface TodaySummary {
  date: string;
  dispatchCount: number;
  dispatchTotal: Paise;
  paymentsCount: number;
  paymentsTotal: Paise;
  advancesTotal: Paise;
  pendingCount: number;
  marketDue: Paise;
  topDue: Array<{ name: string; outstanding: Paise }>;
}
