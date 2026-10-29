import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import * as Ledger from '../../src/services/ledger.service';
import { findMismatches, rebuildBalances } from '../../src/services/reconcile.service';
import { computeDispatchTotals, toPaise } from '../../src/lib/money';
import type { Extraction } from '../../src/lib/extraction';
import { ORG, OWNER, pool, resetDb } from '../helpers/db';

/**
 * PROPERTY-BASED TEST of the whole ledger.
 *
 * Instead of hand-picking a few scenarios, fast-check generates hundreds of
 * random sequences of operations — new entries from two phones, confirm, confirm by
 * ref code, cancel, undo, re-sent uploads, two confirms at the same instant — runs them
 * against the real database, and after EVERY sequence checks that:
 *
 *   1. the stored balances equal a simple in-memory model of the ledger, and
 *   2. the stored balances equal the sum of confirmed transactions (reconcile).
 *
 * If anything ever fails, fast-check automatically shrinks the sequence to the
 * shortest one that still fails and prints it, so the bug is easy to reproduce.
 */

const STAFF = '+919812345678';
const PHONES = [OWNER, STAFF] as const;
// Deliberately dissimilar names so fuzzy matching never merges two of them
const PARTIES = ['Alpha Granite', 'Bharat Marbles', 'Kiran Traders'];
const WORKERS = ['Mohan', 'Iqbal'];

type Entry =
  | { type: 'dispatch'; party: string; sqft: number; rate: number; loading: number; packing: number; tax: number; freight: number }
  | { type: 'payment'; party: string; amount: number }
  | { type: 'worker_advance'; worker: string; amount: number };

type Op =
  | { op: 'create'; phone: number; entry: Entry }
  | { op: 'redeliver'; phone: number } // the phone re-sends the last upload
  | { op: 'confirm'; phone: number; pick: number | null } // null = newest pending, n = by ref code of the n-th pending
  | { op: 'confirmTwiceAtOnce'; phone: number }
  | { op: 'cancel'; phone: number }
  | { op: 'undo'; phone: number };

// ---- generators -------------------------------------------------------------
const rupees = (maxPaise: number) => fc.integer({ min: 0, max: maxPaise }).map((p) => p / 100);
const phoneIdx = fc.integer({ min: 0, max: PHONES.length - 1 });

const entryArb: fc.Arbitrary<Entry> = fc.oneof(
  fc.record({
    type: fc.constant('dispatch' as const),
    party: fc.constantFrom(...PARTIES),
    sqft: fc.integer({ min: 1, max: 500_000 }).map((c) => c / 100), // 0.01 … 5000 sqft
    rate: fc.integer({ min: 100, max: 10_000 }).map((p) => p / 100), // ₹1 … ₹100
    loading: rupees(500_000),
    packing: rupees(200_000),
    tax: fc.constantFrom(0, 5, 12, 18),
    freight: rupees(500_000),
  }),
  fc.record({ type: fc.constant('payment' as const), party: fc.constantFrom(...PARTIES), amount: rupees(10_000_000).filter((a) => a > 0) }),
  fc.record({ type: fc.constant('worker_advance' as const), worker: fc.constantFrom(...WORKERS), amount: rupees(2_000_000).filter((a) => a > 0) })
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ op: fc.constant('create' as const), phone: phoneIdx, entry: entryArb }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('redeliver' as const), phone: phoneIdx }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant('confirm' as const), phone: phoneIdx, pick: fc.option(fc.nat(3), { nil: null }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('confirmTwiceAtOnce' as const), phone: phoneIdx }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('cancel' as const), phone: phoneIdx }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('undo' as const), phone: phoneIdx }) }
);

// ---- the model: what the ledger SHOULD contain ----------------------------
interface ModelTx { ref: string; entry: Entry; messageId: string }
class Model {
  pending = new Map<string, ModelTx[]>(); // per phone, oldest → newest
  confirmed = new Map<string, ModelTx[]>(); // per phone, in confirmation order
  lastMessage = new Map<string, { id: string; entry: Entry }>();
  party = new Map<string, { billed: number; paid: number; outstanding: number }>();
  worker = new Map<string, { advances: number; net: number }>();

  list<K, V>(m: Map<K, V[]>, k: K) {
    if (!m.has(k)) m.set(k, []);
    return m.get(k)!;
  }

  apply(e: Entry, sign: 1 | -1) {
    if (e.type === 'worker_advance') {
      const w = this.worker.get(e.worker) ?? { advances: 0, net: 0 };
      const a = toPaise(e.amount);
      this.worker.set(e.worker, { advances: w.advances + sign * a, net: w.net - sign * a });
      return;
    }
    const p = this.party.get(e.party) ?? { billed: 0, paid: 0, outstanding: 0 };
    if (e.type === 'dispatch') {
      const t = computeDispatchTotals({ sqft: e.sqft, rate: e.rate, loading: e.loading, packing: e.packing, taxPercent: e.tax, freight: e.freight });
      this.party.set(e.party, { billed: p.billed + sign * Math.max(t.total, 0), paid: p.paid, outstanding: p.outstanding + sign * t.total });
    } else {
      const a = toPaise(e.amount);
      this.party.set(e.party, { billed: p.billed, paid: p.paid + sign * a, outstanding: p.outstanding - sign * a });
    }
  }
}

function toExtraction(e: Entry): Extraction {
  const base = { intent: 'TRANSACTION', confidence_level: 1 } as const;
  if (e.type === 'dispatch') {
    return { ...base, transaction_type: 'dispatch', party_name: e.party, sqft_quantity: e.sqft, unit_rate: e.rate,
      loading_charge: e.loading, packing_charge: e.packing, tax_percentage: e.tax, freight_charge: e.freight } as Extraction;
  }
  if (e.type === 'payment') return { ...base, transaction_type: 'payment', party_name: e.party, amount: e.amount } as Extraction;
  return { ...base, transaction_type: 'worker_advance', worker_name: e.worker, amount: e.amount } as Extraction;
}

let msgSeq = 0;

async function run(ops: Op[]) {
  await resetDb();
  await pool.query(`INSERT INTO organization_members (phone, organization_id, role) VALUES ($1, $2, 'staff')`, [STAFF, ORG]);
  const m = new Model();

  for (const o of ops) {
    const phone = PHONES[o.phone];
    const pending = m.list(m.pending, phone);
    const confirmed = m.list(m.confirmed, phone);

    switch (o.op) {
      case 'create': {
        const id = `SMprop${String(++msgSeq).padStart(20, '0')}`;
        const e = await Ledger.createPending(ORG, phone, id, toExtraction(o.entry));
        pending.push({ ref: e.refCode, entry: o.entry, messageId: id });
        m.lastMessage.set(phone, { id, entry: o.entry });
        break;
      }
      case 'redeliver': {
        const last = m.lastMessage.get(phone);
        if (!last) break;
        const e = await Ledger.createPending(ORG, phone, last.id, toExtraction(last.entry));
        expect(e.duplicate).toBe(true); // model unchanged
        break;
      }
      case 'confirm': {
        const idx = o.pick === null ? pending.length - 1 : pending.length ? o.pick % pending.length : -1;
        const ref = o.pick === null || idx < 0 ? undefined : pending[idx].ref;
        const r = await Ledger.confirmPending(ORG, phone, ref);
        if (idx < 0) {
          expect(r.status).toBe('not_found');
        } else {
          expect(r.status).toBe('done');
          const [tx] = pending.splice(idx, 1);
          confirmed.push(tx);
          m.apply(tx.entry, 1);
        }
        break;
      }
      case 'confirmTwiceAtOnce': {
        const results = await Promise.all([Ledger.confirmPending(ORG, phone), Ledger.confirmPending(ORG, phone)]);
        const done = results.filter((r) => r.status === 'done').length;
        expect(done).toBeLessThanOrEqual(Math.min(2, pending.length));
        // Each successful confirm confirmed a DIFFERENT entry, newest first — never the same one twice
        for (let i = 0; i < done; i++) {
          const tx = pending.pop()!;
          confirmed.push(tx);
          m.apply(tx.entry, 1);
        }
        break;
      }
      case 'cancel': {
        const r = await Ledger.cancelPending(ORG, phone);
        expect(r.status).toBe(pending.length ? 'done' : 'not_found');
        pending.pop();
        break;
      }
      case 'undo': {
        const r = await Ledger.undoLastConfirmed(ORG, phone);
        expect(r.status).toBe(confirmed.length ? 'done' : 'not_found');
        const tx = confirmed.pop();
        if (tx) m.apply(tx.entry, -1);
        break;
      }
    }
  }

  // --- invariant 1: database == model --------------------------------------
  const parties = await pool.query(
    `SELECT p.name, b.total_billed, b.total_paid, b.outstanding_balance FROM parties p
       LEFT JOIN party_balances b ON b.party_id = p.id WHERE p.organization_id = $1`, [ORG]);
  const dbParty = Object.fromEntries(parties.rows.map((r) => [r.name, {
    billed: toPaise(r.total_billed ?? 0), paid: toPaise(r.total_paid ?? 0), outstanding: toPaise(r.outstanding_balance ?? 0),
  }]));
  const zero = { billed: 0, paid: 0, outstanding: 0 };
  for (const name of new Set([...Object.keys(dbParty), ...m.party.keys()])) {
    expect(dbParty[name] ?? zero, `party ${name}`).toEqual(m.party.get(name) ?? zero);
  }

  const workers = await pool.query(
    `SELECT w.name, l.advances_taken, l.net_due FROM workers w
       LEFT JOIN worker_ledger l ON l.worker_id = w.id WHERE w.organization_id = $1`, [ORG]);
  for (const r of workers.rows) {
    const want = m.worker.get(r.name) ?? { advances: 0, net: 0 };
    expect({ advances: toPaise(r.advances_taken ?? 0), net: toPaise(r.net_due ?? 0) }, `worker ${r.name}`).toEqual(want);
  }

  // --- invariant 2: running totals == sum of confirmed transactions --------
  expect(await findMismatches(ORG)).toEqual([]);

  // --- invariant 3: exactly the model's pending entries are still pending --
  const pendingCount = await pool.query(`SELECT COUNT(*)::int AS n FROM transactions WHERE status = 'pending_confirmation'`);
  expect(pendingCount.rows[0].n).toBe([...m.pending.values()].reduce((s, l) => s + l.length, 0));
}

describe('ledger properties (random operation sequences against real Postgres)', () => {
  beforeAll(() => {
    msgSeq = 0;
  });

  it('balances always match the model and the confirmed transactions', async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 25 }), run), {
      numRuns: Number(process.env.PROPERTY_RUNS || 60),
      verbose: 1,
      // Regression: the first bug this test found. Two confirms at once + "undo" reversed the
      // wrong entry because confirmed_at used the transaction START time. Always re-checked.
      examples: [[[
        { op: 'create', phone: 0, entry: { type: 'worker_advance', worker: 'Mohan', amount: 8610.65 } },
        { op: 'create', phone: 0, entry: { type: 'payment', party: 'Alpha Granite', amount: 4993.42 } },
        { op: 'confirmTwiceAtOnce', phone: 0 },
        { op: 'undo', phone: 0 },
      ]]],
    });
  }, 180_000);

  it('rebuilding balances from transactions is a no-op on a consistent ledger', async () => {
    await run([
      { op: 'create', phone: 0, entry: { type: 'payment', party: 'Kiran Traders', amount: 1234.56 } },
      { op: 'confirm', phone: 0, pick: null },
    ]);
    const before = await pool.query(`SELECT party_id, total_billed, total_paid, outstanding_balance FROM party_balances ORDER BY party_id`);
    await rebuildBalances(ORG);
    const after = await pool.query(`SELECT party_id, total_billed, total_paid, outstanding_balance FROM party_balances ORDER BY party_id`);
    expect(after.rows).toEqual(before.rows);
  });

  it('reconcile detects a tampered balance and --fix repairs it', async () => {
    await run([
      { op: 'create', phone: 0, entry: { type: 'payment', party: 'Alpha Granite', amount: 5000 } },
      { op: 'confirm', phone: 0, pick: null },
    ]);
    await pool.query(`UPDATE party_balances SET outstanding_balance = outstanding_balance + 1`);
    const found = await findMismatches(ORG);
    expect(found).toEqual([
      { kind: 'party', id: expect.any(String), name: 'Alpha Granite', field: 'outstanding_balance', stored: -4999, expected: -5000 },
    ]);
    await rebuildBalances(ORG);
    expect(await findMismatches(ORG)).toEqual([]);
  });
});
