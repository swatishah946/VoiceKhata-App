import { describe, expect, it } from 'vitest';
import { validateExtraction, ExtractionSchema } from '../../src/lib/extraction';

const dispatch = {
  intent: 'TRANSACTION',
  transaction_type: 'dispatch',
  party_name: 'Siddhi Stone',
  stone_type: '2x1½',
  sqft_quantity: 5000,
  unit_rate: 31.5,
  confidence_level: 0.95,
};

describe('extraction validation (never trust raw AI output)', () => {
  it('accepts a complete dispatch', () => {
    const r = validateExtraction(dispatch, 0.6);
    expect(r.ok).toBe(true);
  });

  it('cleans numbers written as strings', () => {
    const d = ExtractionSchema.parse({ ...dispatch, unit_rate: '31.5 rupaye', sqft_quantity: '5,000', amount: '₹1,50,000' });
    expect(d.unit_rate).toBe(31.5);
    expect(d.sqft_quantity).toBe(5000);
    expect(d.amount).toBe(150000);
  });

  it('treats "null", "unknown", empty strings as missing', () => {
    const d = ExtractionSchema.parse({ ...dispatch, worker_name: 'null', transporter_name: '  ', person_name: 'Unknown' });
    expect(d.worker_name).toBeUndefined();
    expect(d.transporter_name).toBeUndefined();
    expect(d.person_name).toBeUndefined();
  });

  it('normalises intent and type casing', () => {
    const d = ExtractionSchema.parse({ ...dispatch, intent: 'transaction', transaction_type: 'Dispatch' });
    expect(d.intent).toBe('TRANSACTION');
    expect(d.transaction_type).toBe('dispatch');
  });

  it('rejects negative amounts', () => {
    expect(validateExtraction({ ...dispatch, unit_rate: -25 }, 0.6)).toMatchObject({ ok: false, reason: 'invalid_json' });
  });

  it('rejects absurdly large amounts (likely mis-heard)', () => {
    expect(
      validateExtraction({ intent: 'TRANSACTION', transaction_type: 'payment', party_name: 'X', amount: 5e9, confidence_level: 1 }, 0.6).ok
    ).toBe(false);
  });

  it('rejects unknown intents', () => {
    expect(validateExtraction({ intent: 'DELETE_EVERYTHING' }, 0.6)).toMatchObject({ ok: false, reason: 'invalid_json' });
  });

  it('rejects non-objects', () => {
    expect(validateExtraction('hello', 0.6).ok).toBe(false);
    expect(validateExtraction(null, 0.6).ok).toBe(false);
  });

  it.each([
    [{ ...dispatch, party_name: undefined }, 'party name'],
    [{ ...dispatch, sqft_quantity: 0 }, 'sqft'],
    [{ ...dispatch, unit_rate: null }, 'rate'],
    [{ intent: 'TRANSACTION', transaction_type: 'payment', party_name: 'Ramesh' }, 'amount'],
    [{ intent: 'TRANSACTION', transaction_type: 'worker_advance', amount: 2000 }, 'worker name'],
    [{ intent: 'TRANSACTION', transaction_type: 'freight_payment', amount: 2000 }, 'transporter name'],
    [{ intent: 'TRANSACTION', party_name: 'X', amount: 1 }, 'type of entry (dispatch / payment / advance)'],
    [{ intent: 'UPDATE_PRICE', updated_stone_type: '2x1½' }, 'new rate'],
    [{ intent: 'GET_KHATA' }, 'person name'],
  ])('reports missing essentials %#', (input, expected) => {
    const r = validateExtraction({ confidence_level: 1, ...input }, 0.6);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('missing_fields');
      expect(r.missing).toContain(expected);
    }
  });

  it('holds money-changing entries to the confidence threshold', () => {
    expect(validateExtraction({ ...dispatch, confidence_level: 0.4 }, 0.6)).toMatchObject({ ok: false, reason: 'low_confidence' });
    expect(validateExtraction({ intent: 'UPDATE_PRICE', updated_stone_type: '3x2', updated_rate: 40, confidence_level: 0.3 }, 0.6).ok).toBe(false);
  });

  it('does not block read-only requests on confidence', () => {
    expect(validateExtraction({ intent: 'GET_PDF', confidence_level: 0.2 }, 0.6).ok).toBe(true);
    expect(validateExtraction({ intent: 'GET_KHATA', person_name: 'Ramesh', confidence_level: 0.2 }, 0.6).ok).toBe(true);
  });
});
