import { Router, Request, Response } from 'express';
import pool from '../db';
import { authMiddleware } from '../middleware/auth';
import { generateKhataPdf } from '../services/pdf.service';
import { dailySummary, transactionsCsv } from '../services/reports.service';

const router = Router();

/**
 * Read routes the app uses for balances, history, PDFs and reports.
 * Everything requires a login token and is scoped to the token's business.
 */
router.use(authMiddleware);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(['pending_confirmation', 'confirmed', 'cancelled', 'reversed']);

/** Validates :id so a malformed id is a clean 404 instead of a Postgres error. */
function idParam(req: Request, res: Response): string | null {
  const id = String(req.params.id);
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return id;
}

router.get('/transactions', async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !STATUSES.has(status)) return res.status(400).json({ error: 'Invalid status' });
  const result = await pool.query(
    `SELECT t.id, t.transaction_type, t.status, t.stone_type_text, t.pieces_count, t.sqft_quantity,
            t.unit_rate, t.subtotal_amount, t.loading_charge, t.packing_charge, t.tax_percentage,
            t.tax_amount, t.freight_charge, t.total_amount, t.advance_paid, t.outstanding_balance,
            t.needs_price_confirmation, t.price_warning, t.ref_code, t.created_at, t.confirmed_at,
            COALESCE(p.name, t.ai_extracted_json->>'party_name') AS party_name,
            COALESCE(w.name, t.ai_extracted_json->>'worker_name') AS worker_name
       FROM transactions t
       LEFT JOIN parties p ON t.party_id = p.id
       LEFT JOIN workers w ON t.worker_id = w.id
      WHERE t.organization_id = $1 AND ($3::text IS NULL OR t.status = $3)
      ORDER BY t.created_at DESC
      LIMIT $2`,
    [req.user!.orgId, limit, status]
  );
  res.json(result.rows);
});

/** CSV for the accountant: /api/export/transactions.csv?from=2026-09-01&to=2026-09-30 (IST days, max 1 year). */
router.get('/export/transactions.csv', async (req: Request, res: Response) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  const fromD = new Date(from + 'T00:00:00Z');
  const toD = new Date(to + 'T00:00:00Z');
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || isNaN(+fromD) || isNaN(+toD) || fromD > toD || +toD - +fromD > 366 * 86400_000) {
    return res.status(400).json({ error: 'Use ?from=YYYY-MM-DD&to=YYYY-MM-DD (from ≤ to, at most one year)' });
  }
  const csv = await transactionsCsv(req.user!.orgId, from, to);
  res.setHeader('Content-Disposition', `attachment; filename="voicekhata_${from}_to_${to}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/csv; charset=utf-8').send(csv);
});

router.get('/summary/today', async (req: Request, res: Response) => {
  res.json(await dailySummary(req.user!.orgId));
});

router.get('/parties', async (req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT p.id, p.name, p.type, b.total_billed, b.total_paid, b.outstanding_balance, b.last_payment_date
       FROM parties p
       LEFT JOIN party_balances b ON p.id = b.party_id
      WHERE p.organization_id = $1
      ORDER BY b.outstanding_balance DESC NULLS LAST`,
    [req.user!.orgId]
  );
  res.json(result.rows);
});

router.get('/analytics', async (req: Request, res: Response) => {
  const orgId = req.user!.orgId;
  const [market, sales, pending] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(outstanding_balance), 0) AS total_market_due
         FROM party_balances WHERE organization_id = $1 AND outstanding_balance > 0`,
      [orgId]
    ),
    // "This month" in INDIA time (timestamps are stored in UTC)
    pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS monthly_sales
         FROM transactions
        WHERE organization_id = $1 AND transaction_type = 'dispatch' AND status = 'confirmed'
          AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')
              >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata')`,
      [orgId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM transactions WHERE organization_id = $1 AND status = 'pending_confirmation'`,
      [orgId]
    ),
  ]);
  res.json({
    totalMarketDue: Number(market.rows[0].total_market_due),
    monthlySales: Number(sales.rows[0].monthly_sales),
    pendingCount: pending.rows[0].n,
  });
});

router.get('/workers', async (req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT w.id, w.name, l.advances_taken, l.net_due
       FROM workers w
       LEFT JOIN worker_ledger l ON w.id = l.worker_id
      WHERE w.organization_id = $1
      ORDER BY l.net_due ASC NULLS LAST`,
    [req.user!.orgId]
  );
  res.json(result.rows);
});

/** One party or worker: balance + every entry (for the detail page). */
async function personDetail(req: Request, res: Response, type: 'party' | 'worker') {
  const id = idParam(req, res);
  if (!id) return;
  const orgId = req.user!.orgId;
  const person = await pool.query(
    type === 'party'
      ? `SELECT p.id, p.name, p.type, p.phone, b.total_billed, b.total_paid, b.outstanding_balance, b.last_payment_date
           FROM parties p LEFT JOIN party_balances b ON b.party_id = p.id WHERE p.id = $1 AND p.organization_id = $2`
      : `SELECT w.id, w.name, 'worker' AS type, w.phone, l.advances_taken, l.net_due
           FROM workers w LEFT JOIN worker_ledger l ON l.worker_id = w.id WHERE w.id = $1 AND w.organization_id = $2`,
    [id, orgId]
  );
  if (!person.rows.length) return res.status(404).json({ error: 'Not found' });
  const column = type === 'party' ? 'party_id' : 'worker_id';
  const tx = await pool.query(
    `SELECT id, transaction_type, status, stone_type_text, pieces_count, sqft_quantity, unit_rate, subtotal_amount,
            loading_charge, packing_charge, tax_percentage, tax_amount, freight_charge, total_amount, advance_paid,
            ref_code, created_at, confirmed_at
       FROM transactions WHERE organization_id = $1 AND ${column} = $2
      ORDER BY created_at DESC LIMIT 500`,
    [orgId, id]
  );
  res.json({ ...person.rows[0], transactions: tx.rows });
}

async function personKhataPdf(req: Request, res: Response, type: 'party' | 'worker') {
  const id = idParam(req, res);
  if (!id) return;
  const table = type === 'party' ? 'parties' : 'workers';
  const person = await pool.query(`SELECT id, name FROM ${table} WHERE id = $1 AND organization_id = $2`, [id, req.user!.orgId]);
  if (!person.rows.length) return res.status(404).json({ error: 'Not found' });
  const pdf = await generateKhataPdf(req.user!.orgId, { id, type, name: person.rows[0].name });
  const safeName = person.rows[0].name.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60) || 'khata';
  res.setHeader('Content-Disposition', `attachment; filename="Khata_${safeName}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/pdf').send(pdf);
}

router.get('/parties/:id', (req, res) => personDetail(req, res, 'party'));
router.get('/parties/:id/khata.pdf', (req, res) => personKhataPdf(req, res, 'party'));
router.get('/workers/:id', (req, res) => personDetail(req, res, 'worker'));
router.get('/workers/:id/khata.pdf', (req, res) => personKhataPdf(req, res, 'worker'));

export default router;
