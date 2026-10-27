/**
 * Money is handled in integer paise, exactly like the backend, so the
 * estimate shown while editing matches the bill the server calculates.
 */
export type Paise = number;

export function toPaise(rupees: number | null | undefined): Paise {
  if (rupees === null || rupees === undefined || !Number.isFinite(rupees)) return 0;
  return Math.round(Number((rupees * 100).toFixed(4)));
}

/** 1234567.5 rupees in paise → "₹12,34,567.50" (Indian grouping) */
export function formatINR(paise: Paise): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / 100);
  const p = String(abs % 100).padStart(2, '0');
  return `${sign}₹${groupIndian(rupees)}.${p}`;
}

/** Whole rupees, for compact lists: "₹1,59,000" */
export function formatINRShort(paise: Paise): string {
  const sign = paise < 0 ? '-' : '';
  return `${sign}₹${groupIndian(Math.round(Math.abs(paise) / 100))}`;
}

function groupIndian(n: number): string {
  const s = String(n);
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/** Same rule as the backend: total = (sqft × rate + loading + packing) + tax − freight */
export function dispatchTotal(input: {
  sqft: number;
  rate: number;
  loading?: number | null;
  packing?: number | null;
  taxPercent?: number | null;
  freight?: number | null;
}): Paise {
  const sqftCenti = Math.round(Number((input.sqft * 100).toFixed(4)));
  const subtotal = Math.round((sqftCenti * toPaise(input.rate)) / 100);
  const taxable = subtotal + toPaise(input.loading) + toPaise(input.packing);
  const bp = Math.round(Number(((input.taxPercent || 0) * 100).toFixed(4)));
  const tax = Math.round((taxable * bp) / 10000);
  return taxable + tax - toPaise(input.freight);
}
