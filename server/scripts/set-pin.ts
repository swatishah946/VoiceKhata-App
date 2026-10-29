/**
 * Set (or change) the PIN a member uses to log in to the Android app.
 * The member must already exist (npm run add-member).
 *
 * Usage:
 *   npm run set-pin -- +919876543210 4821
 */
import bcrypt from 'bcryptjs';
import '../src/config';
import pool from '../src/db';
import { normalizePhone } from '../src/lib/phone';

async function main() {
  const [rawPhone, pin] = process.argv.slice(2);
  const phone = normalizePhone(rawPhone);
  if (!phone || !/^\d{4,6}$/.test(pin || '')) {
    console.error('Usage: npm run set-pin -- <phone e.g. +919876543210> <4-6 digit PIN>');
    process.exit(1);
  }
  const r = await pool.query(`UPDATE organization_members SET pin_hash = $1 WHERE phone = $2`, [
    await bcrypt.hash(pin, 12),
    phone,
  ]);
  if (!r.rowCount) {
    console.error(`❌ ${phone} is not a member. Add it first: npm run add-member -- ${phone} "Name" owner`);
    process.exit(1);
  }
  console.log(`✅ PIN set for ${phone}`);
  await pool.end();
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
