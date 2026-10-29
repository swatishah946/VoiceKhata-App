/**
 * Checks that every party/worker balance equals the sum of its confirmed
 * transactions. Safe to run any time (read-only unless --fix is given).
 *
 * Usage:
 *   npm run reconcile             # report differences
 *   npm run reconcile -- --fix    # rebuild balances from transactions
 */
import { config } from '../src/config';
import pool from '../src/db';
import { findMismatches, rebuildBalances } from '../src/services/reconcile.service';

async function main() {
  const orgId = process.env.ORG_ID || config.DEFAULT_ORG_ID;
  const fix = process.argv.includes('--fix');

  const mismatches = await findMismatches(orgId);
  if (mismatches.length === 0) {
    console.log('✅ All balances match the confirmed transactions.');
  } else {
    console.log(`⚠️ ${mismatches.length} difference(s):`);
    console.table(mismatches.map((m) => ({ type: m.kind, name: m.name, field: m.field, stored: m.stored, expected: m.expected })));
    if (fix) {
      const r = await rebuildBalances(orgId);
      console.log(`🔧 Rebuilt ${r.parties} party balance(s) and ${r.workers} worker ledger(s).`);
      const after = await findMismatches(orgId);
      console.log(after.length === 0 ? '✅ Now consistent.' : `❌ Still ${after.length} difference(s).`);
    } else {
      console.log('Run with --fix to rebuild balances from transactions.');
    }
  }
  await pool.end();
  process.exit(mismatches.length && !fix ? 2 : 0);
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
