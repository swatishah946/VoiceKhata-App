/**
 * Seeds the stone price list (stone_types) with the current rates.
 * Existing rates are NOT overwritten.
 *
 * Usage: npm run seed:prices
 */
import { config } from '../src/config';
import pool from '../src/db';

const PRICES: Array<[string, number]> = [
  ['2x1½', 31.5], ['23"x17"', 31.5], ['2½x2', 33], ['3x2', 37], ['4x2', 40], ['5x2', 47],
  ['6x2', 48], ['22"x16"', 27], ['22"x22"', 29], ['3½x2', 40], ['4½x2', 40], ['6½x2', 56.5],
  ['4x2½', 56], ['5x2½', 59], ['6x2½', 62],
];

async function main() {
  const orgId = process.env.ORG_ID || config.DEFAULT_ORG_ID;
  let added = 0;
  for (const [size, rate] of PRICES) {
    const r = await pool.query(
      `INSERT INTO stone_types (organization_id, size_format, finish, current_price)
       VALUES ($1, $2, 'Standard', $3)
       ON CONFLICT (organization_id, size_format, finish) DO NOTHING`,
      [orgId, size, rate]
    );
    added += r.rowCount ?? 0;
  }
  console.log(`✅ ${added} new stone sizes added (${PRICES.length - added} already existed, left unchanged)`);
  await pool.end();
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
