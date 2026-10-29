import pool from '../../src/db';

export const ORG = '00000000-0000-0000-0000-000000000000';
export const OWNER = '+919876543210';
export const STRANGER = '+919999900000';

/** Wipe all data and register the owner, so every test starts from the same state. */
export async function resetDb() {
  await pool.query(`
    TRUNCATE audit_logs, party_balances, worker_ledger, stone_price_history,
             entry_reviews, voice_uploads, transactions, stone_types, parties, workers, organization_members
    RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO organizations (id, name, owner_phone) VALUES ($1, 'VoiceKhata Admin', '+10000000000')
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [ORG]
  );
  await pool.query(
    `INSERT INTO organization_members (phone, organization_id, name, role) VALUES ($1, $2, 'Papa', 'owner')`,
    [OWNER, ORG]
  );
}

export async function seedPrice(size: string, price: number) {
  await pool.query(
    `INSERT INTO stone_types (organization_id, size_format, finish, current_price) VALUES ($1, $2, 'Standard', $3)`,
    [ORG, size, price]
  );
}

export async function partyBalance(name: string) {
  const r = await pool.query(
    `SELECT b.* FROM party_balances b JOIN parties p ON p.id = b.party_id WHERE p.organization_id = $1 AND p.name = $2`,
    [ORG, name]
  );
  return r.rows[0]
    ? {
        billed: Number(r.rows[0].total_billed),
        paid: Number(r.rows[0].total_paid),
        outstanding: Number(r.rows[0].outstanding_balance),
      }
    : null;
}

export { pool };
