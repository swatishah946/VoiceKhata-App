/**
 * One-time setup: business name + owner who can log in with a PIN.
 *
 * Usage:
 *   npm run setup -- "Shah Stone Traders" +919876543210 "Papa" 4821
 */
import bcrypt from 'bcryptjs';
import { config } from '../src/config';
import pool from '../src/db';
import { normalizePhone } from '../src/lib/phone';

async function main() {
  const [business, rawPhone, name, pin] = process.argv.slice(2);
  const phone = normalizePhone(rawPhone);
  if (!business || !phone || !name || !/^\d{4,6}$/.test(pin || '')) {
    console.error('Usage: npm run setup -- "<business name>" <owner phone> "<owner name>" <4-6 digit PIN>');
    process.exit(1);
  }
  const orgId = process.env.ORG_ID || config.DEFAULT_ORG_ID;
  await pool.query(`UPDATE organizations SET name = $2, owner_name = $3 WHERE id = $1`, [orgId, business.trim(), name]);
  await pool.query(
    `INSERT INTO organization_members (phone, organization_id, name, role, pin_hash) VALUES ($1, $2, $3, 'owner', $4)
     ON CONFLICT (phone) DO UPDATE SET organization_id = EXCLUDED.organization_id, name = EXCLUDED.name,
       role = 'owner', pin_hash = EXCLUDED.pin_hash, is_active = TRUE`,
    [phone, orgId, name, await bcrypt.hash(pin, 12)]
  );
  console.log(`✅ "${business}" is set up. ${name} (${phone}) can log in to the app with the PIN.`);
  await pool.end();
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
