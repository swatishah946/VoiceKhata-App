import { describe, expect, it } from 'vitest';
import { computeDispatchTotals, formatINR, toPaise, toRupeeString } from '../../src/lib/money';

describe('money: paise conversion', () => {
  it('converts rupees to integer paise without float drift', () => {
    expect(toPaise(0.1)).toBe(10);
    expect(toPaise(1.005)).toBe(101); // naive Math.round(1.005*100) gives 100
    expect(toPaise('31.50')).toBe(3150);
    expect(toPaise(null)).toBe(0);
    expect(toPaise(undefined)).toBe(0);
  });

  it('rejects non-numeric amounts', () => {
    expect(() => toPaise('abc')).toThrow();
    expect(() => toPaise(Number.NaN)).toThrow();
  });

  it('formats paise back to a DECIMAL(12,2) string', () => {
    expect(toRupeeString(0)).toBe('0.00');
    expect(toRupeeString(5)).toBe('0.05');
    expect(toRupeeString(123456)).toBe('1234.56');
    expect(toRupeeString(-2050)).toBe('-20.50');
  });

  it('formats Indian currency with lakh grouping', () => {
    expect(formatINR(12345678)).toBe('₹1,23,456.78');
  });

  it('0.1 + 0.2 is exactly 0.30 in paise', () => {
    expect(toRupeeString(toPaise(0.1) + toPaise(0.2))).toBe('0.30');
  });
});

describe('money: dispatch bill (business rule from the billing sheet)', () => {
  it('computes the example from the original test script', () => {
    // 5000 sqft @ ₹25, loading 1500, packing 500, tax 5%, freight 2000
    const t = computeDispatchTotals({ sqft: 5000, rate: 25, loading: 1500, packing: 500, taxPercent: 5, freight: 2000 });
    expect(t.subtotal).toBe(125000_00);
    expect(t.taxable).toBe(127000_00);
    expect(t.tax).toBe(6350_00);
    expect(t.freight).toBe(2000_00);
    expect(t.total).toBe(131350_00); // 127000 + 6350 − 2000
  });

  it('handles fractional sqft and rates exactly', () => {
    const t = computeDispatchTotals({ sqft: 1234.5, rate: 31.5 });
    expect(t.subtotal).toBe(3888675); // ₹38,886.75
    expect(t.total).toBe(3888675);
  });

  it('rounds tax to the nearest paisa', () => {
    const t = computeDispatchTotals({ sqft: 1, rate: 0.33, taxPercent: 18 });
    expect(t.subtotal).toBe(33);
    expect(t.tax).toBe(6); // 5.94 paise → 6
  });

  it('treats missing optional charges as zero', () => {
    const t = computeDispatchTotals({ sqft: 100, rate: 40 });
    expect(t).toEqual({ subtotal: 400000, taxable: 400000, tax: 0, freight: 0, total: 400000 });
  });

  it('tax is applied on loading and packing too, but not on freight', () => {
    const t = computeDispatchTotals({ sqft: 100, rate: 10, loading: 100, packing: 0, taxPercent: 10, freight: 500 });
    expect(t.tax).toBe(11000); // 10% of (1000 + 100)
    expect(t.total).toBe(110000 + 11000 - 50000);
  });
});
