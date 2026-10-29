/**
 * Short reference code shown with each entry (e.g. "Ref K7Q2"), so an entry can
 * be named out loud. No 0/O/1/I, which are easy to confuse on a phone screen.
 */
export const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REF_RE = /^[A-HJ-NP-Z2-9]{4}$/;

export function generateRefCode(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 4; i++) out += REF_ALPHABET[Math.floor(rand() * REF_ALPHABET.length)];
  return out;
}
