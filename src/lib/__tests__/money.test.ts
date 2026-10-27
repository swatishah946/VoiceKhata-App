import { dispatchTotal, formatINR, formatINRShort, toPaise } from '../money';

describe('money (same rules as the backend)', () => {
  it('converts rupees to integer paise without float drift', () => {
    expect(toPaise(31.5)).toBe(3150);
    expect(toPaise(0.1 + 0.2)).toBe(30);
    expect(toPaise(1.005)).toBe(101);
    expect(toPaise(null)).toBe(0);
    expect(toPaise(Number.NaN)).toBe(0);
  });

  it('formats in Indian grouping', () => {
    expect(formatINR(15_900_000)).toBe('₹1,59,000.00');
    expect(formatINR(123_456_789_05)).toBe('₹12,34,56,789.05');
    expect(formatINR(-50)).toBe('-₹0.50');
    expect(formatINRShort(15_900_000)).toBe('₹1,59,000');
    expect(formatINRShort(99_999)).toBe('₹1,000');
  });

  it('dispatch total: sqft × rate + loading + packing, plus GST, minus freight', () => {
    // the WhatsApp example: 5000 sqft × ₹31.5 + ₹1,500 loading = ₹1,59,000
    expect(dispatchTotal({ sqft: 5000, rate: 31.5, loading: 1500 })).toBe(15_900_000);
    // 100 × 30 = 3000; + 200 packing = 3200; 18% = 576; − 500 freight = 3276
    expect(dispatchTotal({ sqft: 100, rate: 30, packing: 200, taxPercent: 18, freight: 500 })).toBe(327_600);
    expect(dispatchTotal({ sqft: 1234.56, rate: 31.5 })).toBe(3_888_864);
  });
});
