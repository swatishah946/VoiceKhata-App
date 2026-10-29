/**
 * Phone helpers. Everything is stored in E.164 form ("+919876543210") so
 * lookups are consistent however the number was typed.
 */

export function normalizePhone(input: string | undefined | null): string | null {
  if (!input) return null;
  let s = String(input).trim();
  s = s.replace(/[\s\-()]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    // A bare 10-digit Indian mobile number
    if (/^[6-9]\d{9}$/.test(s)) s = '+91' + s;
    else s = '+' + s;
  }
  return /^\+\d{8,15}$/.test(s) ? s : null;
}

/** For logs: "+919876543210" -> "+91******3210" (never log full numbers) */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return 'unknown';
  const p = String(phone);
  if (p.length <= 7) return '***';
  return p.slice(0, 3) + '*'.repeat(p.length - 7) + p.slice(-4);
}
