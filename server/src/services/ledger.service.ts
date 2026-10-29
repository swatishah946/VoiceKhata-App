import crypto from 'crypto';
import pool, { Queryable, withTransaction } from '../db';
import { computeDispatchTotals, toPaise, toRupeeString } from '../lib/money';
import { stoneSizeKey } from '../lib/stone';
import { generateRefCode } from '../lib/refcode';
import { validateExtraction, type Extraction } from '../lib/extraction';
import { config } from '../config';

/**
 * The ledger engine.
 *
 * Flow: a voice note becomes a PENDING transaction → he checks it in the app and
 * taps Save → the entry is applied to the balances inside one DB transaction.
 *
 *  - one transaction per voice note (idempotent on its source id);
 *  - every part of the bill (loading, packing, tax, stone type) is stored;
 *  - money math is done in integer paise;
 *  - the spoken rate is compared with the master price list;
 *  - new parties/workers are created only when an entry is SAVED, so a
 *    discarded mis-hearing doesn't leave a junk party behind;
 *  - fuzzy name matching (pg_trgm) for spelling variants of the same name;
 *  - confirm / cancel / edit / undo / price changes are written to audit_logs;
 *  - every confirm path locks the row (SELECT … FOR UPDATE), so an entry can
 *    never be applied twice, however the requests race.
 */

export const PENDING_TTL_HOURS = 24;
export const UNDO_WINDOW_HOURS = 24;
const FUZZY_AUTO_MATCH = 0.6; // similarity needed to reuse an existing name automatically

export type PartyKind = 'customer' | 'transporter';

export interface MatchedName {
  id: string | null; // null = does not exist yet, will be created on confirm
  name: string; // the name that will be used (existing spelling if matched)
  isNew: boolean;
  spokenName: string;
}

export interface PendingEntry {
  id: string;
  refCode: string;
  transactionType: string;
  counterparty: MatchedName | null;
  stoneType?: string;
  pieces?: number;
  sqft?: number;
  rate?: number;
  loading: number; // paise
  packing: number;
  taxPercent: number;
  tax: number;
  freight: number;
  subtotal: number;
  total: number;
  amount: number;
  priceWarning: { masterRate: number; spokenRate: number; diffPercent: number } | null;
  otherPendingCount: number;
  duplicate: boolean;
}

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Existing row with (almost) the same name, or null. */
async function matchExisting(
  db: Queryable,
  table: 'parties' | 'workers',
  orgId: string,
  spoken: string
): Promise<{ id: string; name: string } | null> {
  const exact = await db.query(
    `SELECT id, name FROM ${table} WHERE organization_id = $1 AND lower(name) = lower($2) LIMIT 1`,
    [orgId, spoken]
  );
  if (exact.rows.length) return exact.rows[0];

  const fuzzy = await db.query(
    `SELECT id, name, similarity(lower(name), lower($2)) AS sim
       FROM ${table}
      WHERE organization_id = $1 AND similarity(lower(name), lower($2)) >= $3
      ORDER BY sim DESC
      LIMIT 2`,
    [orgId, spoken, FUZZY_AUTO_MATCH]
  );
  // Only auto-match if there is ONE clear winner
  if (fuzzy.rows.length === 1) return fuzzy.rows[0];
  if (fuzzy.rows.length === 2 && fuzzy.rows[0].sim - fuzzy.rows[1].sim >= 0.15) return fuzzy.rows[0];
  return null;
}

export async function resolveName(
  db: Queryable,
  table: 'parties' | 'workers',
  orgId: string,
  spokenName: string
): Promise<MatchedName> {
  const spoken = cleanName(spokenName);
  const existing = await matchExisting(db, table, orgId, spoken);
  if (existing) return { id: existing.id, name: existing.name, isNew: false, spokenName: spoken };
  return { id: null, name: spoken, isNew: true, spokenName: spoken };
}

/** Insert-or-get, safe under concurrency thanks to UNIQUE(organization_id, name). */
async function ensureParty(db: Queryable, orgId: string, name: string, type: PartyKind): Promise<string> {
  const existing = await matchExisting(db, 'parties', orgId, name);
  if (existing) return existing.id;
  const res = await db.query(
    `INSERT INTO parties (id, organization_id, name, type) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, name) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [crypto.randomUUID(), orgId, cleanName(name), type]
  );
  return res.rows[0].id;
}

async function ensureWorker(db: Queryable, orgId: string, name: string): Promise<string> {
  const existing = await matchExisting(db, 'workers', orgId, name);
  if (existing) return existing.id;
  const res = await db.query(
    `INSERT INTO workers (id, organization_id, name) VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [crypto.randomUUID(), orgId, cleanName(name)]
  );
  return res.rows[0].id;
}

/**
 * Candidates for a spoken name ("Ramesh"). Returns up to 5, best first, so the
 * caller can ask "which one?" instead of guessing the wrong customer.
 */
export async function findPeople(
  orgId: string,
  query: string,
  db: Queryable = pool
): Promise<Array<{ id: string; name: string; type: 'party' | 'worker'; score: number }>> {
  const q = cleanName(query);
  const words = q.split(' ').filter(Boolean);
  const res = await db.query(
    `WITH candidates AS (
       SELECT id, name, 'party' AS type FROM parties WHERE organization_id = $1
       UNION ALL
       SELECT id, name, 'worker' AS type FROM workers WHERE organization_id = $1
     )
     SELECT id, name, type,
            CASE WHEN lower(name) = lower($2) THEN 2
                 ELSE similarity(lower(name), lower($2)) + CASE WHEN lower(name) LIKE ALL($3::text[]) THEN 0.5 ELSE 0 END
            END AS score
       FROM candidates
      WHERE lower(name) = lower($2)
         OR similarity(lower(name), lower($2)) >= 0.3
         OR lower(name) LIKE ALL($3::text[])
      ORDER BY score DESC
      LIMIT 5`,
    [orgId, q, words.map((w) => `%${w.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%`)]
  );
  return res.rows.map((r) => ({ ...r, score: Number(r.score) }));
}

/** Decide whether one candidate is clearly the right person. */
export function pickPerson<T extends { score: number }>(candidates: T[]): T | null {
  if (candidates.length === 0) return null;
  if (candidates[0].score >= 2) return candidates[0]; // exact name
  if (candidates.length === 1) return candidates[0];
  return candidates[0].score - candidates[1].score >= 0.25 ? candidates[0] : null;
}

// ---------------------------------------------------------------------------
// Creating pending entries
// ---------------------------------------------------------------------------

async function lookupMasterPrice(db: Queryable, orgId: string, stoneType?: string) {
  if (!stoneType) return null;
  const key = stoneSizeKey(stoneType);
  const res = await db.query(
    `SELECT id, size_format, current_price FROM stone_types WHERE organization_id = $1 AND is_active = TRUE`,
    [orgId]
  );
  const row = res.rows.find((r) => stoneSizeKey(r.size_format) === key);
  return row ? { id: row.id as string, name: row.size_format as string, price: Number(row.current_price) } : null;
}

function toEntry(row: any, otherPendingCount: number, duplicate: boolean): PendingEntry {
  const x = row.ai_extracted_json || {};
  const counterName: string | undefined =
    row.party_name || row.worker_name || x.party_name || x.worker_name || x.transporter_name;
  return {
    id: row.id,
    refCode: row.ref_code,
    transactionType: row.transaction_type,
    counterparty: counterName
      ? {
          id: row.party_id || row.worker_id || null,
          name: counterName,
          isNew: !row.party_id && !row.worker_id,
          spokenName: x.party_name || x.worker_name || x.transporter_name || counterName,
        }
      : null,
    stoneType: row.stone_type_text || undefined,
    pieces: row.pieces_count ?? undefined,
    sqft: row.sqft_quantity != null ? Number(row.sqft_quantity) : undefined,
    rate: row.unit_rate != null ? Number(row.unit_rate) : undefined,
    loading: toPaise(row.loading_charge),
    packing: toPaise(row.packing_charge),
    taxPercent: Number(row.tax_percentage || 0),
    tax: toPaise(row.tax_amount),
    freight: toPaise(row.freight_charge),
    subtotal: toPaise(row.subtotal_amount),
    total: toPaise(row.total_amount),
    amount: toPaise(row.advance_paid),
    priceWarning: row.price_warning || null,
    otherPendingCount,
    duplicate,
  };
}

async function countOtherPending(db: Queryable, orgId: string, phone: string, exceptId: string) {
  const res = await db.query(
    `SELECT COUNT(*)::int AS n FROM transactions
      WHERE organization_id = $1 AND requested_by_phone = $2 AND status = 'pending_confirmation'
        AND created_at > NOW() AT TIME ZONE 'UTC' - make_interval(hours => $3) AND id <> $4`,
    [orgId, phone, PENDING_TTL_HOURS, exceptId]
  );
  return res.rows[0].n as number;
}

const SELECT_TX = `
  SELECT t.*, p.name AS party_name, w.name AS worker_name
    FROM transactions t
    LEFT JOIN parties p ON p.id = t.party_id
    LEFT JOIN workers w ON w.id = t.worker_id`;

/**
 * Everything derived from an extraction: who it is for (matched to an existing
 * party/worker when possible), the bill in paise, and the price-list check.
 * Used when an entry is created and again when it is edited in the app.
 */
async function computeEntryValues(db: Queryable, orgId: string, data: Extraction) {
  const type = data.transaction_type!;
  let counterparty: MatchedName | null = null;
  let partyId: string | null = null;
  let workerId: string | null = null;

  if (type === 'dispatch' || type === 'payment') {
    counterparty = await resolveName(db, 'parties', orgId, data.party_name!);
    partyId = counterparty.id;
  } else if (type === 'worker_advance') {
    counterparty = await resolveName(db, 'workers', orgId, data.worker_name!);
    workerId = counterparty.id;
  } else if (type === 'freight_payment') {
    counterparty = await resolveName(db, 'parties', orgId, (data.transporter_name || data.party_name || data.worker_name)!);
    partyId = counterparty.id;
  }

  let subtotal = 0, tax = 0, total = 0, amount = 0, outstanding = 0;
  let master: Awaited<ReturnType<typeof lookupMasterPrice>> = null;
  let priceWarning: PendingEntry['priceWarning'] = null;

  if (type === 'dispatch') {
    const t = computeDispatchTotals({
      sqft: data.sqft_quantity!,
      rate: data.unit_rate!,
      loading: data.loading_charge,
      packing: data.packing_charge,
      taxPercent: data.tax_percentage,
      freight: data.freight_charge,
    });
    subtotal = t.subtotal;
    tax = t.tax;
    total = t.total;
    outstanding = t.total;

    master = await lookupMasterPrice(db, orgId, data.stone_type);
    if (master && master.price > 0) {
      const diffPercent = ((data.unit_rate! - master.price) / master.price) * 100;
      if (Math.abs(diffPercent) > config.PRICE_VARIANCE_WARN_PCT) {
        priceWarning = {
          masterRate: master.price,
          spokenRate: data.unit_rate!,
          diffPercent: Math.round(diffPercent * 10) / 10,
        };
      }
    }
  } else {
    amount = toPaise(data.amount);
    outstanding = -amount; // money received / advance given reduces what they owe
  }

  return { counterparty, partyId, workerId, subtotal, tax, total, amount, outstanding, master, priceWarning };
}

export async function createPending(
  orgId: string,
  phone: string,
  messageId: string,
  data: Extraction,
  /** The voice transcript, kept for audits and the accuracy eval */
  sourceText?: string
): Promise<PendingEntry> {
  // Idempotency: same voice note → same entry, never a second one
  const existing = await pool.query(`${SELECT_TX} WHERE t.source_id = $1`, [messageId]);
  if (existing.rows.length) {
    return toEntry(existing.rows[0], await countOtherPending(pool, orgId, phone, existing.rows[0].id), true);
  }

  const type = data.transaction_type!;
  const { counterparty, partyId, workerId, subtotal, tax, total, amount, outstanding, master, priceWarning } =
    await computeEntryValues(pool, orgId, data);

  const id = crypto.randomUUID();
  const refCode = generateRefCode();

  try {
    await pool.query(
      `INSERT INTO transactions (
         id, organization_id, party_id, worker_id, transaction_type,
         stone_type_id, stone_type_text, pieces_count, sqft_quantity, unit_rate,
         master_price, price_variance, subtotal_amount,
         freight_charge, loading_charge, packing_charge, tax_percentage, tax_amount,
         total_amount, advance_paid, outstanding_balance,
         status, needs_price_confirmation, price_warning, ai_extracted_json,
         source_id, requested_by_phone, ref_code, transcription_text
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
                 'pending_confirmation',$22,$23,$24,$25,$26,$27,$28)`,
      [
        id, orgId, partyId, workerId, type,
        master?.id ?? null, data.stone_type ?? null, data.pieces_count ?? null,
        data.sqft_quantity ?? null, data.unit_rate ?? null,
        master?.price ?? null,
        master ? toRupeeString(toPaise(data.unit_rate) - toPaise(master.price)) : null,
        toRupeeString(subtotal),
        toRupeeString(toPaise(data.freight_charge)), toRupeeString(toPaise(data.loading_charge)),
        toRupeeString(toPaise(data.packing_charge)), data.tax_percentage ?? 0, toRupeeString(tax),
        toRupeeString(total), toRupeeString(amount), toRupeeString(outstanding),
        Boolean(counterparty?.isNew || priceWarning), priceWarning ? JSON.stringify(priceWarning) : null,
        JSON.stringify(data), messageId, phone, refCode, sourceText?.slice(0, 2000) ?? null,
      ]
    );
  } catch (err: any) {
    // Unique index hit: a concurrent retry already inserted this message
    if (err.code === '23505') return createPending(orgId, phone, messageId, data, sourceText);
    throw err;
  }

  const row = (await pool.query(`${SELECT_TX} WHERE t.id = $1`, [id])).rows[0];
  const entry = toEntry(row, await countOtherPending(pool, orgId, phone, id), false);
  if (counterparty) entry.counterparty = counterparty;
  return entry;
}

// ---------------------------------------------------------------------------
// Confirm / cancel / undo
// ---------------------------------------------------------------------------

async function audit(
  db: Queryable,
  orgId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  oldValues: unknown,
  newValues: unknown,
  actor: string
) {
  await db.query(
    `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, old_values, new_values, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [orgId, action, entityType, entityId, JSON.stringify(oldValues ?? null), JSON.stringify(newValues ?? null), actor]
  );
}

/** Apply (sign = +1) or reverse (sign = -1) a transaction's effect on balances. */
async function applyToBalances(db: Queryable, tx: any, sign: 1 | -1) {
  const billed = sign * Math.max(toPaise(tx.total_amount), 0);
  const paid = sign * toPaise(tx.advance_paid);
  const outstanding = sign * toPaise(tx.outstanding_balance);
  const isPayment = tx.transaction_type !== 'dispatch';

  if (tx.party_id) {
    await db.query(
      `INSERT INTO party_balances (organization_id, party_id, total_billed, total_paid, outstanding_balance,
                                   last_transaction_date, last_payment_date, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CASE WHEN $6 THEN CURRENT_TIMESTAMP END, CURRENT_TIMESTAMP)
       ON CONFLICT (organization_id, party_id) DO UPDATE SET
         total_billed = party_balances.total_billed + EXCLUDED.total_billed,
         total_paid = party_balances.total_paid + EXCLUDED.total_paid,
         outstanding_balance = party_balances.outstanding_balance + EXCLUDED.outstanding_balance,
         last_transaction_date = CURRENT_TIMESTAMP,
         last_payment_date = CASE WHEN $6 THEN CURRENT_TIMESTAMP ELSE party_balances.last_payment_date END,
         updated_at = CURRENT_TIMESTAMP`,
      [tx.organization_id, tx.party_id, toRupeeString(billed), toRupeeString(paid), toRupeeString(outstanding), isPayment && sign > 0]
    );
  }

  if (tx.worker_id) {
    await db.query(
      `INSERT INTO worker_ledger (organization_id, worker_id, advances_taken, net_due, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (organization_id, worker_id) DO UPDATE SET
         advances_taken = worker_ledger.advances_taken + EXCLUDED.advances_taken,
         net_due = worker_ledger.net_due + EXCLUDED.net_due,
         updated_at = CURRENT_TIMESTAMP`,
      [tx.organization_id, tx.worker_id, toRupeeString(paid), toRupeeString(-paid)] // negative = worker owes us
    );
  }
}

export type ActionResult =
  | { status: 'done'; entry: PendingEntry }
  | { status: 'not_found' };

/** Shared by every confirm path. `tx` must be locked FOR UPDATE. */
async function applyConfirm(db: Queryable, orgId: string, tx: any, actor: string) {
  const x = tx.ai_extracted_json || {};

  // Create the party/worker now (not at pending time) if it is new
  if (!tx.party_id && !tx.worker_id) {
    if (tx.transaction_type === 'worker_advance' && x.worker_name) {
      tx.worker_id = await ensureWorker(db, orgId, x.worker_name);
    } else if (tx.transaction_type === 'freight_payment') {
      const name = x.transporter_name || x.party_name || x.worker_name;
      if (name) tx.party_id = await ensureParty(db, orgId, name, 'transporter');
    } else if (x.party_name) {
      tx.party_id = await ensureParty(db, orgId, x.party_name, 'customer');
    }
  }

  await applyToBalances(db, tx, 1);
  await db.query(
    `UPDATE transactions
        -- clock_timestamp() = the real moment of confirmation. CURRENT_TIMESTAMP is the
        -- transaction START time, so a confirm that waited on a lock got an EARLIER time than
        -- the one it waited for, and "undo" then reversed the wrong entry (found by the
        -- property-based test).
        SET status = 'confirmed', confirmed_at = clock_timestamp() AT TIME ZONE 'UTC', party_id = $2, worker_id = $3,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [tx.id, tx.party_id, tx.worker_id]
  );
  await audit(db, orgId, 'transaction.confirm', 'transaction', tx.id, { status: 'pending_confirmation' }, { status: 'confirmed' }, actor);
}

async function markCancelled(db: Queryable, orgId: string, id: string, actor: string) {
  await db.query(`UPDATE transactions SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  await audit(db, orgId, 'transaction.cancel', 'transaction', id, { status: 'pending_confirmation' }, { status: 'cancelled' }, actor);
}

async function loadEntry(db: Queryable, id: string, otherPending: number) {
  const row = (await db.query(`${SELECT_TX} WHERE t.id = $1`, [id])).rows[0];
  return toEntry(row, otherPending, false);
}

/** Confirm this member's newest pending entry (max 24 h old), or the one with this ref code. */
export async function confirmPending(orgId: string, phone: string, ref?: string): Promise<ActionResult> {
  return withTransaction(async (db) => {
    const found = await db.query(
      `SELECT * FROM transactions
        WHERE organization_id = $1 AND requested_by_phone = $2 AND status = 'pending_confirmation'
          AND created_at > NOW() AT TIME ZONE 'UTC' - make_interval(hours => $3)
          AND ($4::text IS NULL OR ref_code = $4)
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [orgId, phone, PENDING_TTL_HOURS, ref ?? null]
    );
    if (!found.rows.length) return { status: 'not_found' } as const;
    const tx = found.rows[0];
    await applyConfirm(db, orgId, tx, `app:${phone}`);
    return { status: 'done', entry: await loadEntry(db, tx.id, await countOtherPending(db, orgId, phone, tx.id)) } as const;
  });
}

export async function cancelPending(orgId: string, phone: string, ref?: string): Promise<ActionResult> {
  return withTransaction(async (db) => {
    const found = await db.query(
      `SELECT id FROM transactions
        WHERE organization_id = $1 AND requested_by_phone = $2 AND status = 'pending_confirmation'
          AND ($3::text IS NULL OR ref_code = $3)
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [orgId, phone, ref ?? null]
    );
    if (!found.rows.length) return { status: 'not_found' } as const;
    await markCancelled(db, orgId, found.rows[0].id, `app:${phone}`);
    return { status: 'done', entry: await loadEntry(db, found.rows[0].id, 0) } as const;
  });
}

/**
 * Confirm / cancel one entry by id, under the same row lock as the other confirm
 * paths. Scoped to the organisation (no cross-business access).
 */
export async function confirmById(orgId: string, id: string, actor = 'app'): Promise<ActionResult> {
  return withTransaction(async (db) => {
    const found = await db.query(
      `SELECT * FROM transactions WHERE id = $1 AND organization_id = $2 AND status = 'pending_confirmation' FOR UPDATE`,
      [id, orgId]
    );
    if (!found.rows.length) return { status: 'not_found' } as const;
    await applyConfirm(db, orgId, found.rows[0], actor);
    return { status: 'done', entry: await loadEntry(db, id, 0) } as const;
  });
}

export async function cancelById(orgId: string, id: string, actor = 'app'): Promise<ActionResult> {
  return withTransaction(async (db) => {
    const found = await db.query(
      `SELECT id FROM transactions WHERE id = $1 AND organization_id = $2 AND status = 'pending_confirmation' FOR UPDATE`,
      [id, orgId]
    );
    if (!found.rows.length) return { status: 'not_found' } as const;
    await markCancelled(db, orgId, id, actor);
    return { status: 'done', entry: await loadEntry(db, id, 0) } as const;
  });
}

/** Fields he can correct on the app's review screen before saving. */
export const EDITABLE_FIELDS = [
  'transaction_type', 'party_name', 'worker_name', 'transporter_name', 'stone_type', 'pieces_count',
  'sqft_quantity', 'unit_rate', 'amount', 'freight_charge', 'loading_charge', 'packing_charge', 'tax_percentage',
] as const;
export type EntryEdits = Partial<Record<(typeof EDITABLE_FIELDS)[number], string | number | null>>;

function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) =>
    v === null || v === undefined || v === '' ? null : typeof v === 'string' ? v.trim().toLowerCase() : Number(v);
  return norm(a) === norm(b);
}

export type ReviewResult = ActionResult | { status: 'invalid'; missing: string[] };

/**
 * App review screen → Save. Applies his corrections, re-validates them and
 * re-computes the bill on the server (the phone's totals are never trusted),
 * records what the AI said vs what he saved (for measuring real accuracy), and
 * confirms — all inside one transaction holding the row lock, so two Saves at
 * the same moment (e.g. from two phones) still apply the entry once.
 */
export async function confirmWithEdits(
  orgId: string,
  id: string,
  edits: EntryEdits,
  actor: string
): Promise<ReviewResult> {
  return withTransaction(async (db) => {
    const found = await db.query(
      `SELECT * FROM transactions WHERE id = $1 AND organization_id = $2 AND status = 'pending_confirmation' FOR UPDATE`,
      [id, orgId]
    );
    if (!found.rows.length) return { status: 'not_found' } as const;
    const tx = found.rows[0];
    const aiValues = tx.ai_extracted_json || {};

    const merged: Record<string, unknown> = { ...aiValues, intent: 'TRANSACTION', confidence_level: 1 };
    for (const field of EDITABLE_FIELDS) {
      if (field in edits) merged[field] = edits[field];
    }
    const v = validateExtraction(merged, 0);
    if (!v.ok) return { status: 'invalid', missing: v.missing ?? ['valid values'] } as const;
    const data = v.data;

    const changed = EDITABLE_FIELDS.filter((f) => !sameValue(aiValues[f], data[f]));
    if (changed.length) {
      const c = await computeEntryValues(db, orgId, data);
      const updated = await db.query(
        `UPDATE transactions SET
           transaction_type = $2, party_id = $3, worker_id = $4, stone_type_id = $5, stone_type_text = $6,
           pieces_count = $7, sqft_quantity = $8, unit_rate = $9, master_price = $10, price_variance = $11,
           subtotal_amount = $12, freight_charge = $13, loading_charge = $14, packing_charge = $15,
           tax_percentage = $16, tax_amount = $17, total_amount = $18, advance_paid = $19, outstanding_balance = $20,
           price_warning = $21, ai_extracted_json = $22, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING *`,
        [
          id, data.transaction_type, c.partyId, c.workerId, c.master?.id ?? null, data.stone_type ?? null,
          data.pieces_count ?? null, data.sqft_quantity ?? null, data.unit_rate ?? null, c.master?.price ?? null,
          c.master ? toRupeeString(toPaise(data.unit_rate) - toPaise(c.master.price)) : null,
          toRupeeString(c.subtotal), toRupeeString(toPaise(data.freight_charge)),
          toRupeeString(toPaise(data.loading_charge)), toRupeeString(toPaise(data.packing_charge)),
          data.tax_percentage ?? 0, toRupeeString(c.tax), toRupeeString(c.total), toRupeeString(c.amount),
          toRupeeString(c.outstanding), c.priceWarning ? JSON.stringify(c.priceWarning) : null, JSON.stringify(data),
        ]
      );
      Object.assign(tx, updated.rows[0]);
      await audit(db, orgId, 'transaction.edit', 'transaction', id, pick(aiValues, changed), pick(data, changed), actor);
    }

    await db.query(
      `INSERT INTO entry_reviews (transaction_id, organization_id, ai_values, final_values, changed_fields)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (transaction_id) DO NOTHING`,
      [id, orgId, JSON.stringify(pick(aiValues, EDITABLE_FIELDS)), JSON.stringify(pick(data, EDITABLE_FIELDS)), changed]
    );
    await applyConfirm(db, orgId, tx, actor);
    return { status: 'done', entry: await loadEntry(db, id, 0) } as const;
  });
}

function pick(obj: Record<string, any>, keys: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  return out;
}

/** One entry, for the app's review screen. */
export async function getEntry(orgId: string, id: string): Promise<(PendingEntry & { status: string }) | null> {
  const r = await pool.query(`${SELECT_TX} WHERE t.id = $1 AND t.organization_id = $2`, [id, orgId]);
  if (!r.rows.length) return null;
  return { ...toEntry(r.rows[0], 0, false), status: r.rows[0].status };
}

/** Reverse the sender's most recent confirmed entry (within UNDO_WINDOW_HOURS). */
export async function undoLastConfirmed(orgId: string, phone: string): Promise<ActionResult> {
  return withTransaction(async (db) => {
    const found = await db.query(
      `SELECT * FROM transactions
        WHERE organization_id = $1 AND requested_by_phone = $2 AND status = 'confirmed'
          AND confirmed_at > NOW() AT TIME ZONE 'UTC' - make_interval(hours => $3)
        ORDER BY confirmed_at DESC, id DESC LIMIT 1 FOR UPDATE`,
      [orgId, phone, UNDO_WINDOW_HOURS]
    );
    if (!found.rows.length) return { status: 'not_found' } as const;
    const tx = found.rows[0];
    await applyToBalances(db, tx, -1);
    await db.query(`UPDATE transactions SET status = 'reversed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [tx.id]);
    await audit(db, orgId, 'transaction.undo', 'transaction', tx.id, { status: 'confirmed' }, { status: 'reversed' }, `app:${phone}`);
    const row = (await db.query(`${SELECT_TX} WHERE t.id = $1`, [tx.id])).rows[0];
    return { status: 'done', entry: toEntry(row, 0, false) } as const;
  });
}

// ---------------------------------------------------------------------------
// Price list
// ---------------------------------------------------------------------------

export async function updateStonePrice(orgId: string, phone: string, stoneType: string, rate: number) {
  return withTransaction(async (db) => {
    const key = stoneSizeKey(stoneType);
    const all = await db.query(
      `SELECT id, size_format, current_price FROM stone_types WHERE organization_id = $1 FOR UPDATE`,
      [orgId]
    );
    const match = all.rows.find((r) => stoneSizeKey(r.size_format) === key);
    const newPrice = toRupeeString(toPaise(rate));

    let id: string, name: string, oldPrice: number | null;
    if (match) {
      id = match.id;
      name = match.size_format;
      oldPrice = Number(match.current_price);
      await db.query(
        `UPDATE stone_types SET current_price = $2, is_active = TRUE, last_price_update = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id, newPrice]
      );
    } else {
      name = stoneType.trim();
      oldPrice = null;
      const ins = await db.query(
        `INSERT INTO stone_types (organization_id, size_format, finish, current_price, last_price_update)
         VALUES ($1, $2, 'Standard', $3, CURRENT_TIMESTAMP) RETURNING id`,
        [orgId, name, newPrice]
      );
      id = ins.rows[0].id;
    }

    await db.query(
      `INSERT INTO stone_price_history (stone_type_id, organization_id, old_price, new_price, change_reason, change_date)
       VALUES ($1, $2, $3, $4, 'App update', CURRENT_DATE)`,
      [id, orgId, oldPrice, newPrice]
    );
    await audit(db, orgId, 'price.update', 'stone_type', id, { price: oldPrice }, { price: Number(newPrice) }, `app:${phone}`);
    return { name, oldPrice, newPrice: Number(newPrice), isNew: !match };
  });
}
