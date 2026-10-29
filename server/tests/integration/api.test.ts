import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { signToken } from '../../src/middleware/auth';
import * as Ledger from '../../src/services/ledger.service';
import type { Extraction } from '../../src/lib/extraction';
import { ORG, OWNER, pool, resetDb } from '../helpers/db';

/** Balances, history, PDFs and reports, as the app reads them. Real database. */

const app = createApp({ enqueueAppVoice: async () => undefined });
const token = signToken({ orgId: ORG, role: 'owner', phone: OWNER });
const get = (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`);

let seq = 0;
async function saved(e: Partial<Extraction>) {
  const p = await Ledger.createPending(ORG, OWNER, `src${++seq}`, { intent: 'TRANSACTION', confidence_level: 1, ...e } as Extraction);
  await Ledger.confirmById(ORG, p.id);
  return p;
}

beforeEach(async () => {
  await resetDb();
  await saved({ transaction_type: 'dispatch', party_name: 'Siddhi Stone', sqft_quantity: 100, unit_rate: 30, stone_type: '2x1½' });
  await saved({ transaction_type: 'payment', party_name: 'Siddhi Stone', amount: 1000 });
  await saved({ transaction_type: 'worker_advance', worker_name: 'Mohan', amount: 500 });
});

describe('read API', () => {
  it('health check reports the database', async () => {
    expect((await request(app).get('/health')).body).toMatchObject({ status: 'OK', db: 'up' });
  });

  it('parties with balances, most owed first', async () => {
    const r = await get('/api/parties');
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ name: 'Siddhi Stone', outstanding_balance: '2000.00' });
  });

  it('party detail with its entries, and its khata PDF', async () => {
    const id = (await get('/api/parties')).body[0].id;
    const d = await get(`/api/parties/${id}`);
    expect(d.body.transactions).toHaveLength(2);
    const pdf = await get(`/api/parties/${id}/khata.pdf`).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['cache-control']).toBe('no-store');
  });

  it('workers and their advances', async () => {
    const w = await get('/api/workers');
    expect(w.body[0]).toMatchObject({ name: 'Mohan', advances_taken: '500.00' });
    const d = await get(`/api/workers/${w.body[0].id}`);
    expect(d.body.transactions).toHaveLength(1);
    expect((await get(`/api/workers/${w.body[0].id}/khata.pdf`)).status).toBe(200);
  });

  it('unknown or malformed ids are a clean 404', async () => {
    expect((await get('/api/parties/not-a-uuid')).status).toBe(404);
    expect((await get('/api/parties/00000000-0000-0000-0000-000000000001')).status).toBe(404);
    expect((await get('/api/workers/00000000-0000-0000-0000-000000000001/khata.pdf')).status).toBe(404);
  });

  it('entries list with limit and status filter', async () => {
    expect((await get('/api/transactions?limit=2')).body).toHaveLength(2);
    expect((await get('/api/transactions?status=confirmed')).body).toHaveLength(3);
    expect((await get('/api/transactions?status=hacked')).status).toBe(400);
  });

  it("today's summary and totals", async () => {
    const s = await get('/api/summary/today');
    expect(s.body).toMatchObject({ dispatchTotal: 300000, paymentsTotal: 100000, advancesTotal: 50000, marketDue: 200000 });
    const a = await get('/api/analytics');
    expect(a.body).toMatchObject({ totalMarketDue: 2000, monthlySales: 3000, pendingCount: 0 });
  });

  it('CSV export for the accountant, with date checks', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const csv = await get(`/api/export/transactions.csv?from=2020-01-01&to=${today}`);
    expect(csv.status).toBe(400); // more than one year
    const from = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    const ok = await get(`/api/export/transactions.csv?from=${from}&to=${today}`);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('Siddhi Stone');
    expect((await get('/api/export/transactions.csv?from=x&to=y')).status).toBe(400);
  });

  it('another business cannot see this data', async () => {
    const other = '11111111-1111-1111-1111-111111111111';
    await pool.query(`INSERT INTO organizations (id, name, owner_phone) VALUES ($1, 'Other', '+911111111111') ON CONFLICT DO NOTHING`, [other]);
    const t = signToken({ orgId: other, role: 'owner', phone: '+911111111111' });
    const r = await request(app).get('/api/parties').set('Authorization', `Bearer ${t}`);
    expect(r.body).toEqual([]);
  });
});
