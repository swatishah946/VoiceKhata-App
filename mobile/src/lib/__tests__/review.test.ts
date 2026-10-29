import { checkForm, estimateTotal, initialForm, parseNumber, toEdits } from '../review';
import type { AiFields } from '../types';

const AI: AiFields = {
  transaction_type: 'dispatch', party_name: 'Siddhi Stone', stone_type: '2x1½',
  sqft_quantity: 5000, unit_rate: 31.5, loading_charge: 1500, pieces_count: null,
};

describe('review form', () => {
  it('fills the form from what the AI understood', () => {
    const f = initialForm(AI);
    expect(f).toMatchObject({ party_name: 'Siddhi Stone', sqft_quantity: '5000', unit_rate: '31.5', pieces_count: '', amount: '' });
  });

  it('parses numbers the way people type them', () => {
    expect(parseNumber('1,50,000')).toBe(150000);
    expect(parseNumber('₹ 31.5')).toBe(31.5);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNaN();
    expect(parseNumber('-5')).toBeNaN(); // no negative amounts
  });

  it('sends nothing when he changed nothing (AI was right)', () => {
    expect(toEdits(AI, 'dispatch', 'dispatch', initialForm(AI))).toEqual({});
  });

  it('sends only the fields he changed', () => {
    const form = { ...initialForm(AI), unit_rate: '32', party_name: ' siddhi stone ' }; // case/space change is not a change
    expect(toEdits(AI, 'dispatch', 'dispatch', form)).toEqual({ unit_rate: 32 });
  });

  it('changing the entry type sends the type and that type’s fields', () => {
    const form = { ...initialForm(AI), amount: '5000' };
    expect(toEdits(AI, 'dispatch', 'payment', form)).toEqual({ transaction_type: 'payment', amount: 5000 });
  });

  it('clearing a field sends null', () => {
    const form = { ...initialForm(AI), loading_charge: '' };
    expect(toEdits(AI, 'dispatch', 'dispatch', form)).toEqual({ loading_charge: null });
  });

  it('blocks Save when required fields are missing or numbers are wrong', () => {
    const form = { ...initialForm(AI), unit_rate: '', sqft_quantity: '50o0' };
    expect(checkForm('dispatch', form)).toEqual({ missing: ['unit_rate'], invalid: ['sqft_quantity'] });
    expect(checkForm('payment', initialForm({ party_name: 'Ramesh' }))).toEqual({ missing: ['amount'], invalid: [] });
    expect(checkForm('dispatch', initialForm(AI))).toEqual({ missing: [], invalid: [] });
  });

  it('shows a live total estimate as he edits', () => {
    expect(estimateTotal('dispatch', initialForm(AI))).toBe(15_900_000);
    expect(estimateTotal('dispatch', { ...initialForm(AI), unit_rate: '32' })).toBe(16_150_000);
    expect(estimateTotal('dispatch', { ...initialForm(AI), unit_rate: '' })).toBeNull();
    expect(estimateTotal('payment', { amount: '5,000' })).toBe(500_000);
  });
});
