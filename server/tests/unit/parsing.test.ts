import { describe, expect, it } from 'vitest';
import { generateRefCode } from '../../src/lib/refcode';
import { normalizeStoneType, stoneSizeKey } from '../../src/lib/stone';
import { maskPhone, normalizePhone } from '../../src/lib/phone';
import { formatDateIST } from '../../src/lib/time';

describe('reference codes', () => {
  it('generates 4-char codes without confusing characters (no 0/O/1/I)', () => {
    for (let i = 0; i < 200; i++) expect(generateRefCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
  });
});

describe('stone size normalisation', () => {
  it.each([
    ['2x1½', '2x1½'],
    ['2 x 1.5', '2x1½'],
    ['2 by 1 1/2', '2x1½'],
    ['2×1½ Polish', '2x1½polish'],
    ['2½ x 2', '2½x2'],
    ['2.5x2', '2½x2'],
  ])('%s → %s', (input, expected) => expect(normalizeStoneType(input)).toBe(expected));

  it('matches on size only', () => {
    expect(stoneSizeKey('2x1½ Polish')).toBe(stoneSizeKey('2 x 1.5'));
    expect(stoneSizeKey('3x2')).not.toBe(stoneSizeKey('2x3'));
    expect(stoneSizeKey(undefined)).toBe('');
  });
});

describe('phone numbers', () => {
  it('normalises the ways people type numbers to E.164', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('+919876543210');
    expect(normalizePhone('9876543210')).toBe('+919876543210');
    expect(normalizePhone('0091 98765-43210')).toBe('+919876543210');
    expect(normalizePhone('919876543210')).toBe('+919876543210');
  });

  it('rejects garbage', () => {
    expect(normalizePhone('hello')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });

  it('masks numbers for logs', () => {
    expect(maskPhone('+919876543210')).toBe('+91******3210');
    expect(maskPhone(null)).toBe('unknown');
  });
});

describe('dates are shown in IST', () => {
  it('an entry at 01:00 IST (19:30 UTC the day before) shows the IST date', () => {
    expect(formatDateIST('2026-03-14T19:30:00Z')).toBe('15 Mar 2026');
  });
});
