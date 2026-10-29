/**
 * Register a person who can log in to the app (then set their PIN with npm run set-pin).
 *
 * Usage:
 *   npm run add-member -- +919876543210 "Papa" owner
 *   npm run add-member -- +919812345678 "Munshi" staff
 *
 * Only registered people can log in.
 */
import { config } from '../src/config';
import pool from '../src/db';
import { normalizePhone } from '../src/lib/phone';
import { addMember } from '../src/services/members.service';

async function main() {
  const [rawPhone, name = null, role = 'owner'] = process.argv.slice(2);
  const phone = normalizePhone(rawPhone);
  if (!phone || (role !== 'owner' && role !== 'staff')) {
    console.error('Usage: npm run add-member -- <phone e.g. +919876543210> [name] [owner|staff]');
    process.exit(1);
  }
  const orgId = process.env.ORG_ID || config.DEFAULT_ORG_ID;
  await addMember(orgId, phone, name, role);
  console.log(`✅ ${phone} (${name ?? 'no name'}) can log in as ${role} of org ${orgId}`);
  await pool.end();
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
