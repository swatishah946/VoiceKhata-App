import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeDispatchTotals, toPaise, toRupeeString } from '../../src/lib/money';
import { normalizePhone } from '../../src/lib/phone';
import { validateExtraction } from '../../src/lib/extraction';

/**
 * Property-based unit tests: instead of a few examples, each property is checked
 * against thousands of generated inputs.
 */

const RUNS = { numRuns: 2000 };
// Amounts as they come from the AI: rupees with at most 2 decimals
const money = (max: number) => fc.integer({ min: 0, max: max * 100 }).map((p) => p / 100);

describe('money properties', () => {
  it('paise → rupee string → paise is lossless', () => {
    fc.assert(fc.property(fc.integer({ min: -1e12, max: 1e12 }), (p) => toPaise(toRupeeString(p)) === p), RUNS);
  });

  it('any 2-decimal rupee amount converts to exactly its paise', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1e11 }), (p) => toPaise(p / 100) === p), RUNS);
  });

  it('subtotal equals the EXACT product (BigInt reference), rounded to the nearest paisa', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_00 }), fc.integer({ min: 1, max: 100_000_00 }), (sqftCenti, ratePaise) => {
        const t = computeDispatchTotals({ sqft: sqftCenti / 100, rate: ratePaise / 100 });
        // exact: sqft(1/100) × rate(paise) / 100, half-up rounding, in arbitrary precision
        const exactTimes100 = BigInt(sqftCenti) * BigInt(ratePaise);
        const expected = (exactTimes100 + 50n) / 100n;
        return BigInt(t.subtotal) === expected;
      }),
      RUNS
    );
  });

  it('bill components always add up and are whole paise', () => {
    fc.assert(
      fc.property(money(100_000), money(10_000), money(50_000), money(50_000), fc.constantFrom(0, 5, 12, 18, 28), money(50_000),
        (sqft, rate, loading, packing, taxPercent, freight) => {
          const t = computeDispatchTotals({ sqft, rate, loading, packing, taxPercent, freight });
          expect(Object.values(t).every(Number.isSafeInteger)).toBe(true);
          expect(t.taxable).toBe(t.subtotal + toPaise(loading) + toPaise(packing));
          expect(t.total).toBe(t.taxable + t.tax - t.freight);
          expect(Math.abs(t.tax - (t.taxable * taxPercent) / 100)).toBeLessThanOrEqual(0.5);
        }),
      RUNS
    );
  });

  it('more sqft never means a smaller bill', () => {
    fc.assert(
      fc.property(money(100_000), money(100_000), money(10_000), (a, b, rate) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        return computeDispatchTotals({ sqft: lo, rate }).total <= computeDispatchTotals({ sqft: hi, rate }).total;
      }),
      RUNS
    );
  });
});

describe('input-handling properties (never crash on anything a user or the AI sends)', () => {
  it('normalizePhone returns valid E.164 or null, for any input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (s) => {
        const p = normalizePhone(s);
        return p === null || /^\+\d{8,15}$/.test(p);
      }),
      RUNS
    );
  });

  it('validateExtraction never throws on arbitrary JSON, and accepted data is sane', () => {
    const numericFields = ['pieces_count', 'sqft_quantity', 'unit_rate', 'amount', 'freight_charge', 'loading_charge',
      'packing_charge', 'tax_percentage', 'updated_rate', 'confidence_level'] as const;
    const aiLike = fc.record(
      {
        intent: fc.constantFrom('TRANSACTION', 'transaction', 'UPDATE_PRICE', 'GET_PDF', 'GET_KHATA', 'HACK', null),
        transaction_type: fc.constantFrom('dispatch', 'payment', 'worker_advance', 'freight_payment', 'Dispatch', 'x', null),
        party_name: fc.option(fc.string()),
        worker_name: fc.option(fc.string()),
        person_name: fc.option(fc.string()),
        updated_stone_type: fc.option(fc.string()),
        amount: fc.oneof(fc.double(), fc.string(), fc.constant(null)),
        sqft_quantity: fc.oneof(fc.double(), fc.string(), fc.constant(null)),
        unit_rate: fc.oneof(fc.double(), fc.string(), fc.constant(null)),
        updated_rate: fc.oneof(fc.double(), fc.constant(null)),
        confidence_level: fc.oneof(fc.double({ min: -1, max: 2 }), fc.constant(null)),
      },
      { requiredKeys: [] }
    );
    fc.assert(
      fc.property(fc.oneof(aiLike, fc.jsonValue()), (raw) => {
        const r = validateExtraction(raw, 0.6);
        if (r.ok) {
          for (const f of numericFields) {
            const v = r.data[f];
            if (v !== undefined) expect(Number.isFinite(v) && v >= 0).toBe(true);
          }
          if (r.data.intent === 'TRANSACTION') expect(r.data.confidence_level).toBeGreaterThanOrEqual(0.6);
        }
      }),
      RUNS
    );
  });
});
