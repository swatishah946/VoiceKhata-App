import { beforeEach, describe, expect, it } from 'vitest';
import * as Ledger from '../../src/services/ledger.service';
import type { Extraction } from '../../src/lib/extraction';
import { ORG, OWNER, partyBalance, pool, resetDb, seedPrice } from '../helpers/db';

const STAFF = '+919812345678';

function dispatch(over: Partial<Extraction> = {}): Extraction {
  return {
    intent: 'TRANSACTION',
    transaction_type: 'dispatch',
    party_name: 'Siddhi Stone',
    stone_type: '2x1½',
    sqft_quantity: 5000,
    unit_rate: 25,
    loading_charge: 1500,
    packing_charge: 500,
    tax_percentage: 5,
    freight_charge: 2000,
    confidence_level: 0.95,
    ...over,
  } as Extraction;
}

function payment(name: string, amount: number): Extraction {
  return { intent: 'TRANSACTION', transaction_type: 'payment', party_name: name, amount, confidence_level: 0.9 } as Extraction;
}

let seq = 0;
const sid = () => `SM${String(++seq).padStart(32, '0')}`;

beforeEach(resetDb);

describe('pending entries', () => {
  it('stores every part of the bill (not only the total)', async () => {
    const e = await Ledger.createPending(ORG, OWNER, sid(), dispatch());
    const row = (await pool.query('SELECT * FROM transactions WHERE id = $1', [e.id])).rows[0];

    expect(row.status).toBe('pending_confirmation');
    expect(Number(row.subtotal_amount)).toBe(125000);
    expect(Number(row.loading_charge)).toBe(1500);
    expect(Number(row.packing_charge)).toBe(500);
    expect(Number(row.tax_percentage)).toBe(5);
    expect(Number(row.tax_amount)).toBe(6350);
    expect(Number(row.freight_charge)).toBe(2000);
    expect(Number(row.total_amount)).toBe(131350);
    expect(row.stone_type_text).toBe('2x1½');
    expect(row.requested_by_phone).toBe(OWNER);
    expect(row.ref_code).toMatch(/^[A-Z2-9]{4}$/);
  });

  it('is idempotent: the same voice note never creates two entries', async () => {
    const id = sid();
    const a = await Ledger.createPending(ORG, OWNER, id, dispatch());
    const b = await Ledger.createPending(ORG, OWNER, id, dispatch());
    expect(b.id).toBe(a.id);
    expect(b.duplicate).toBe(true);
    const n = await pool.query('SELECT COUNT(*)::int AS n FROM transactions');
    expect(n.rows[0].n).toBe(1);
  });

  it('does not create a party until the entry is confirmed', async () => {
    const e = await Ledger.createPending(ORG, OWNER, sid(), dispatch({ party_name: 'Brand New Traders' }));
    expect(e.counterparty?.isNew).toBe(true);
    expect((await pool.query('SELECT * FROM parties')).rowCount).toBe(0);

    await Ledger.cancelPending(ORG, OWNER);
    expect((await pool.query('SELECT * FROM parties')).rowCount).toBe(0); // cancelled → no junk party
  });

  it('warns when the spoken rate differs from the price list', async () => {
    await seedPrice('2x1½', 31.5);
    const e = await Ledger.createPending(ORG, OWNER, sid(), dispatch({ stone_type: '2 x 1.5 polish', unit_rate: 25 }));
    expect(e.priceWarning).toEqual({ masterRate: 31.5, spokenRate: 25, diffPercent: -20.6 });

    const ok = await Ledger.createPending(ORG, OWNER, sid(), dispatch({ unit_rate: 31 }));
    expect(ok.priceWarning).toBeNull();
  });

  it('reuses an existing party when the AI spells the name slightly differently', async () => {
    await Ledger.createPending(ORG, OWNER, sid(), dispatch({ party_name: 'Siddhi Stone Company' }));
    await Ledger.confirmPending(ORG, OWNER);

    const e = await Ledger.createPending(ORG, OWNER, sid(), payment('Sidhhi Stone Company', 1000));
    expect(e.counterparty?.isNew).toBe(false);
    expect(e.counterparty?.name).toBe('Siddhi Stone Company');
    expect(e.counterparty?.spokenName).toBe('Sidhhi Stone Company');
  });
});

describe('confirm / cancel', () => {
  it('confirm applies the bill to the party balance', async () => {
    await Ledger.createPending(ORG, OWNER, sid(), dispatch());
    const r = await Ledger.confirmPending(ORG, OWNER);
    expect(r.status).toBe('done');
    expect(await partyBalance('Siddhi Stone')).toEqual({ billed: 131350, paid: 0, outstanding: 131350 });
  });

  it('a payment reduces the outstanding balance', async () => {
    await Ledger.createPending(ORG, OWNER, sid(), dispatch());
    await Ledger.confirmPending(ORG, OWNER);
    await Ledger.createPending(ORG, OWNER, sid(), payment('siddhi stone', 50000));
    await Ledger.confirmPending(ORG, OWNER);
    expect(await partyBalance('Siddhi Stone')).toEqual({ billed: 131350, paid: 50000, outstanding: 81350 });
  });

  it('confirm acts on the member\'s own entry, not someone else\'s newer one', async () => {
    await pool.query(`INSERT INTO organization_members (phone, organization_id, role) VALUES ($1, $2, 'staff')`, [STAFF, ORG]);
    const mine = await Ledger.createPending(ORG, OWNER, sid(), payment('Ramesh', 1000));
    const theirs = await Ledger.createPending(ORG, STAFF, sid(), payment('Suresh', 9999));

    const r = await Ledger.confirmPending(ORG, OWNER);
    expect(r.status === 'done' && r.entry.id).toBe(mine.id);
    const other = await pool.query('SELECT status FROM transactions WHERE id = $1', [theirs.id]);
    expect(other.rows[0].status).toBe('pending_confirmation');
  });

  it('a reference code picks a specific pending entry', async () => {
    const first = await Ledger.createPending(ORG, OWNER, sid(), payment('Ramesh', 1000));
    const second = await Ledger.createPending(ORG, OWNER, sid(), payment('Suresh', 2000));
    expect(second.otherPendingCount).toBe(1);

    const r = await Ledger.confirmPending(ORG, OWNER, first.refCode);
    expect(r.status === 'done' && r.entry.id).toBe(first.id);
  });

  it('a wrong reference code confirms nothing', async () => {
    await Ledger.createPending(ORG, OWNER, sid(), payment('Ramesh', 1000));
    expect((await Ledger.confirmPending(ORG, OWNER, 'ZZZZ')).status).toBe('not_found');
  });

  it('confirming twice cannot double-count', async () => {
    await Ledger.createPending(ORG, OWNER, sid(), payment('Ramesh', 1000));
    expect((await Ledger.confirmPending(ORG, OWNER)).status).toBe('done');
    expect((await Ledger.confirmPending(ORG, OWNER)).status).toBe('not_found');
    expect((await partyBalance('Ramesh'))!.paid).toBe(1000);
  });

  it('two confirms at the same moment still apply the entry once (row lock)', async () => {
    await Ledger.createPending(ORG, OWNER, sid(), payment('Ramesh', 1000));
    const results = await Promise.all([Ledger.confirmPending(ORG, OWNER), Ledger.confirmPending(ORG, OWNER)]);
    expect(results.filter((r) => r.status === 'done')).toHaveLength(1);
    expect((await partyBalance('Ramesh'))!.paid).toBe(1000);
  });

  it('pending entries expire after 24 hours', async () => {
    const e = await Ledger.createPending(ORG, OWNER, sid(), payment('Ramesh', 1000));
    await pool.query(`UPDATE transactions SET created_at = created_at - interval '25 hours' WHERE id = $1`, [e.id]);
    expect((await Ledger.confirmPending(ORG, OWNER)).status).toBe('not_found');
  });

  it('cancel marks the entry cancelled and leaves balances untouched', async () => {
    await Ledger.createPending(ORG, OWNER, sid(), dispatch());
    expect((await Ledger.cancelPending(ORG, OWNER)).status).toBe('done');
    expect((await Ledger.confirmPending(ORG, OWNER)).status).toBe('not_found');
    expect(await partyBalance('Siddhi Stone')).toBeNull();
  });

  it('worker advances go to the worker ledger', async () => {
    await Ledger.createPending(ORG, OWNER, sid(), {
      intent: 'TRANSACTION', transaction_type: 'worker_advance', worker_name: 'Mohan', amount: 2000, confidence_level: 1,
    } as Extraction);
    await Ledger.confirmPending(ORG, OWNER);
    const r = await pool.query(`SELECT l.* FROM worker_ledger l JOIN workers w ON w.id = l.worker_id WHERE w.name = 'Mohan'`);
    expect(Number(r.rows[0].advances_taken)).toBe(2000);
    expect(Number(r.rows[0].net_due)).toBe(-2000);
  });

  it('freight payments create the transporter as a transporter party', async () => {
    await Ledger.createPending(ORG, OWNER, sid(), {
      intent: 'TRANSACTION', transaction_type: 'freight_payment', transporter_name: 'Shiv Roadlines', amount: 7000, confidence_level: 1,
    } as Extraction);
    await Ledger.confirmPending(ORG, OWNER);
    const p = await pool.query(`SELECT type FROM parties WHERE name = 'Shiv Roadlines'`);
    expect(p.rows[0].type).toBe('transporter');
  });

  it('writes an audit log for confirm and cancel', async () => {
    await Ledger.createPending(ORG, OWNER, sid(), payment('A', 1));
    await Ledger.confirmPending(ORG, OWNER);
    await Ledger.createPending(ORG, OWNER, sid(), payment('B', 1));
    await Ledger.cancelPending(ORG, OWNER);
    const logs = await pool.query(`SELECT action, user_agent FROM audit_logs ORDER BY created_at`);
    expect(logs.rows.map((r) => r.action)).toEqual(['transaction.confirm', 'transaction.cancel']);
    expect(logs.rows[0].user_agent).toBe(`app:${OWNER}`);
  });
});

describe('undo', () => {
  it('reverses the last confirmed entry and restores the balance', async () => {
    await Ledger.createPending(ORG, OWNER, sid(), dispatch());
    await Ledger.confirmPending(ORG, OWNER);
    await Ledger.createPending(ORG, OWNER, sid(), payment('Siddhi Stone', 50000));
    await Ledger.confirmPending(ORG, OWNER);

    const r = await Ledger.undoLastConfirmed(ORG, OWNER);
    expect(r.status).toBe('done');
    expect(await partyBalance('Siddhi Stone')).toEqual({ billed: 131350, paid: 0, outstanding: 131350 });

    const statuses = await pool.query(`SELECT transaction_type, status FROM transactions ORDER BY created_at`);
    expect(statuses.rows.map((r) => r.status)).toEqual(['confirmed', 'reversed']);
  });

  it('has nothing to undo when there are no recent confirmed entries', async () => {
    expect((await Ledger.undoLastConfirmed(ORG, OWNER)).status).toBe('not_found');
  });
});

describe('finding people for "X ka khata bhejo"', () => {
  beforeEach(async () => {
    for (const n of ['Ramesh Traders', 'Rameshwar Stone', 'Suresh Kumar', 'Ambika Textile']) {
      await pool.query(`INSERT INTO parties (organization_id, name, type) VALUES ($1, $2, 'customer')`, [ORG, n]);
    }
    await pool.query(`INSERT INTO workers (organization_id, name) VALUES ($1, 'Mohan Loader')`, [ORG]);
  });

  it('an exact name wins outright', async () => {
    const c = await Ledger.findPeople(ORG, 'suresh kumar');
    expect(Ledger.pickPerson(c)?.name).toBe('Suresh Kumar');
  });

  it('an ambiguous name returns choices instead of guessing', async () => {
    const c = await Ledger.findPeople(ORG, 'Ramesh');
    expect(c.map((x) => x.name)).toEqual(expect.arrayContaining(['Ramesh Traders', 'Rameshwar Stone']));
    expect(Ledger.pickPerson(c)).toBeNull();
  });

  it('tolerates spelling differences', async () => {
    const c = await Ledger.findPeople(ORG, 'Ambika Textiles');
    expect(Ledger.pickPerson(c)?.name).toBe('Ambika Textile');
  });

  it('finds workers too', async () => {
    const c = await Ledger.findPeople(ORG, 'Mohan');
    expect(Ledger.pickPerson(c)).toMatchObject({ name: 'Mohan Loader', type: 'worker' });
  });

  it('returns nothing for unknown names', async () => {
    expect(await Ledger.findPeople(ORG, 'Zebra Marbles')).toEqual([]);
  });

  it('treats % and _ in a name literally', async () => {
    expect(await Ledger.findPeople(ORG, '%')).toEqual([]);
  });
});

describe('price list updates', () => {
  it('updates the matching stone and records history + audit', async () => {
    await seedPrice('2x1½', 31.5);
    const r = await Ledger.updateStonePrice(ORG, OWNER, '2 x 1.5', 32);
    expect(r).toEqual({ name: '2x1½', oldPrice: 31.5, newPrice: 32, isNew: false });

    const rows = await pool.query(`SELECT current_price FROM stone_types`);
    expect(rows.rowCount).toBe(1); // updated, not duplicated
    expect(Number(rows.rows[0].current_price)).toBe(32);

    const h = await pool.query(`SELECT old_price, new_price FROM stone_price_history`);
    expect(h.rows[0]).toMatchObject({ old_price: '31.50', new_price: '32.00' });
    expect((await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'price.update'`)).rowCount).toBe(1);
  });

  it('adds a new stone size when it does not exist', async () => {
    const r = await Ledger.updateStonePrice(ORG, OWNER, '7x2', 70);
    expect(r.isNew).toBe(true);
    expect(r.oldPrice).toBeNull();
  });
});
