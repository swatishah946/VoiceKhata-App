import { describe, expect, it } from 'vitest';
import { csvCell } from '../../src/services/reports.service';
import { validateExtraction } from '../../src/lib/extraction';

describe('CSV cells', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('Gupta, Sons')).toBe('"Gupta, Sons"');
    expect(csvCell('6" tile')).toBe('"6"" tile"');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell(null)).toBe('');
  });

  it.each(['=1+1', '+91 call', '-cmd', '@SUM(A1)', '\t=x'])('defuses formula-looking text %j', (v) => {
    expect(csvCell(v).replace(/^"/, '').startsWith("'")).toBe(true);
  });

  it('leaves numbers (including negative amounts) untouched', () => {
    expect(csvCell('-2000.00', false)).toBe('-2000.00');
    expect(csvCell(31.5, false)).toBe('31.5');
  });
});

describe('GET_BALANCE extraction', () => {
  it('needs a person name', () => {
    expect(validateExtraction({ intent: 'GET_BALANCE' }, 0.6)).toMatchObject({ ok: false, missing: ['person name'] });
    expect(validateExtraction({ intent: 'GET_BALANCE', person_name: 'Ramesh' }, 0.6).ok).toBe(true);
  });
});
