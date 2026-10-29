import pool, { Queryable, withTransaction } from '../db';

/**
 * Ledger reconciliation.
 *
 * `party_balances` and `worker_ledger` are running totals that are updated on
 * every confirm / undo. They are a CACHE: the source of truth is the list of
 * confirmed transactions. This service recomputes the totals from the
 * transactions and reports (or fixes) any difference.
 *
 * Used by:
 *  - `npm run reconcile` (check) / `npm run reconcile -- --fix` (rebuild)
 *  - the property-based tests, which assert there is NEVER a mismatch after any
 *    random sequence of entries, confirms, cancels and undos.
 */

export interface Mismatch {
  kind: 'party' | 'worker';
  id: string;
  name: string;
  field: string;
  stored: number;
  expected: number;
}

const PARTY_EXPECTED = `
  SELECT p.id, p.name,
         COALESCE(SUM(GREATEST(t.total_amount, 0)), 0)::numeric(14,2) AS total_billed,
         COALESCE(SUM(t.advance_paid), 0)::numeric(14,2)             AS total_paid,
         COALESCE(SUM(t.outstanding_balance), 0)::numeric(14,2)      AS outstanding_balance
    FROM parties p
    LEFT JOIN transactions t ON t.party_id = p.id AND t.status = 'confirmed'
   WHERE p.organization_id = $1
   GROUP BY p.id, p.name`;

const WORKER_EXPECTED = `
  SELECT w.id, w.name,
         COALESCE(SUM(t.advance_paid), 0)::numeric(14,2)  AS advances_taken,
         (-COALESCE(SUM(t.advance_paid), 0))::numeric(14,2) AS net_due
    FROM workers w
    LEFT JOIN transactions t ON t.worker_id = w.id AND t.status = 'confirmed'
   WHERE w.organization_id = $1
   GROUP BY w.id, w.name`;

export async function findMismatches(orgId: string, db: Queryable = pool): Promise<Mismatch[]> {
  const out: Mismatch[] = [];

  const parties = await db.query(
    `SELECT e.*, b.total_billed AS s_billed, b.total_paid AS s_paid, b.outstanding_balance AS s_out
       FROM (${PARTY_EXPECTED}) e
       LEFT JOIN party_balances b ON b.party_id = e.id`,
    [orgId]
  );
  for (const r of parties.rows) {
    const pairs: Array<[string, unknown, unknown]> = [
      ['total_billed', r.s_billed, r.total_billed],
      ['total_paid', r.s_paid, r.total_paid],
      ['outstanding_balance', r.s_out, r.outstanding_balance],
    ];
    for (const [field, stored, expected] of pairs) {
      if (Number(stored ?? 0) !== Number(expected)) {
        out.push({ kind: 'party', id: r.id, name: r.name, field, stored: Number(stored ?? 0), expected: Number(expected) });
      }
    }
  }

  const workers = await db.query(
    `SELECT e.*, l.advances_taken AS s_adv, l.net_due AS s_net
       FROM (${WORKER_EXPECTED}) e
       LEFT JOIN worker_ledger l ON l.worker_id = e.id`,
    [orgId]
  );
  for (const r of workers.rows) {
    const pairs: Array<[string, unknown, unknown]> = [
      ['advances_taken', r.s_adv, r.advances_taken],
      ['net_due', r.s_net, r.net_due],
    ];
    for (const [field, stored, expected] of pairs) {
      if (Number(stored ?? 0) !== Number(expected)) {
        out.push({ kind: 'worker', id: r.id, name: r.name, field, stored: Number(stored ?? 0), expected: Number(expected) });
      }
    }
  }
  return out;
}

/** Rebuild all running totals from the confirmed transactions (one DB transaction). */
export async function rebuildBalances(orgId: string): Promise<{ parties: number; workers: number }> {
  return withTransaction(async (db) => {
    // Lock the ledger tables so no confirm can run halfway through the rebuild
    await db.query('LOCK TABLE party_balances, worker_ledger IN SHARE ROW EXCLUSIVE MODE');

    const p = await db.query(
      `INSERT INTO party_balances (organization_id, party_id, total_billed, total_paid, outstanding_balance, updated_at)
       SELECT $1, e.id, e.total_billed, e.total_paid, e.outstanding_balance, CURRENT_TIMESTAMP FROM (${PARTY_EXPECTED}) e
       ON CONFLICT (organization_id, party_id) DO UPDATE SET
         total_billed = EXCLUDED.total_billed, total_paid = EXCLUDED.total_paid,
         outstanding_balance = EXCLUDED.outstanding_balance, updated_at = CURRENT_TIMESTAMP`,
      [orgId]
    );
    const w = await db.query(
      `INSERT INTO worker_ledger (organization_id, worker_id, advances_taken, net_due, updated_at)
       SELECT $1, e.id, e.advances_taken, e.net_due, CURRENT_TIMESTAMP FROM (${WORKER_EXPECTED}) e
       ON CONFLICT (organization_id, worker_id) DO UPDATE SET
         advances_taken = EXCLUDED.advances_taken, net_due = EXCLUDED.net_due, updated_at = CURRENT_TIMESTAMP`,
      [orgId]
    );
    await db.query(
      `INSERT INTO audit_logs (organization_id, action, entity_type, new_values, user_agent)
       VALUES ($1, 'ledger.rebuild', 'ledger', $2, 'system')`,
      [orgId, JSON.stringify({ parties: p.rowCount, workers: w.rowCount })]
    );
    return { parties: p.rowCount ?? 0, workers: w.rowCount ?? 0 };
  });
}
