/**
 * Money helpers.
 *
 * Why: JavaScript numbers are binary floats, so 0.1 + 0.2 = 0.30000000000000004.
 * For a ledger that is unacceptable. All arithmetic here happens in integer
 * PAISE (1 rupee = 100 paise) and is only converted back to rupees at the end.
 */

export type Paise = number;

export function toPaise(rupees: number | string | null | undefined): Paise {
  if (rupees === null || rupees === undefined || rupees === '') return 0;
  const n = typeof rupees === 'string' ? Number(rupees) : rupees;
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${rupees}`);
  // Round via string to avoid 1.005 * 100 = 100.49999 style errors
  return Math.round(Number((n * 100).toFixed(4)));
}

/** Paise -> rupee string with 2 decimals, exactly what Postgres DECIMAL(12,2) expects. */
export function toRupeeString(paise: Paise): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(Math.round(paise));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Indian formatting for messages/PDFs: 1234567.5 -> "₹12,34,567.50" */
export function formatINR(paise: Paise): string {
  const rupees = paise / 100;
  return (
    '₹' +
    rupees.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

export interface DispatchInput {
  sqft: number; // may be fractional, e.g. 5000.5
  rate: number; // rupees per sqft, e.g. 31.5
  loading?: number; // rupees
  packing?: number; // rupees
  taxPercent?: number; // e.g. 5 or 18
  freight?: number; // rupees, DEDUCTED (factory pays freight / FOR rate)
}

export interface DispatchTotals {
  subtotal: Paise;
  taxable: Paise;
  tax: Paise;
  freight: Paise;
  total: Paise;
}

/**
 * Business rule (from the family's billing sheet):
 *   subtotal = sqft × rate
 *   taxable  = subtotal + loading + packing
 *   tax      = taxable × tax%
 *   total    = taxable + tax − freight
 */
export function computeDispatchTotals(input: DispatchInput): DispatchTotals {
  const sqftCenti = Math.round(Number((input.sqft * 100).toFixed(4))); // sqft in 1/100ths
  const ratePaise = toPaise(input.rate);
  const subtotal = Math.round((sqftCenti * ratePaise) / 100);

  const taxable = subtotal + toPaise(input.loading) + toPaise(input.packing);
  const taxBasisPoints = Math.round(Number(((input.taxPercent || 0) * 100).toFixed(4)));
  const tax = Math.round((taxable * taxBasisPoints) / 10000);
  const freight = toPaise(input.freight);
  const total = taxable + tax - freight;

  return { subtotal, taxable, tax, freight, total };
}
