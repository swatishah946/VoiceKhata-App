/**
 * Stone size normalisation, so "2 x 1.5", "2x1½", "2 by 1 1/2" and "2×1½"
 * are all recognised as the same catalogue item.
 */
export function normalizeStoneType(input: string | null | undefined): string {
  if (!input) return '';
  let s = String(input).toLowerCase().trim();
  s = s.replace(/[×✕*]/g, 'x').replace(/\s*by\s*/g, 'x');
  s = s.replace(/(\d)\s*(?:1\/2|\.5)(?!\d)/g, '$1½'); // "1 1/2" or "1.5" -> "1½"
  s = s.replace(/(^|[^\d])(?:1\/2|\.5)(?!\d)/g, '$1½'); // bare "1/2" -> "½"
  s = s.replace(/(inch(es)?|in\b|["”″])/g, '"');
  s = s.replace(/\s+/g, '');
  return s;
}

/** Only the size part ("2x1½ polish" -> "2x1½"), used for matching the price list. */
export function stoneSizeKey(input: string | null | undefined): string {
  const n = normalizeStoneType(input);
  const m = n.match(/^[\d½"]+x[\d½"]+/);
  return m ? m[0] : n;
}
