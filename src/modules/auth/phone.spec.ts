import { describe, expect, it } from 'vitest';
import { normalizePhone, phoneCountry } from './phone';

describe('normalizePhone', () => {
  it('normalizes a local Israeli number to E.164', () => {
    expect(normalizePhone('050-123-4567', 'IL')).toBe('+972501234567');
  });

  it('normalizes the same number written several ways to one value', () => {
    const forms = ['0501234567', '050 123 4567', '+972 50 123 4567', '+972501234567'];
    const normalized = new Set(forms.map((f) => normalizePhone(f, 'IL')));
    expect(normalized.size).toBe(1);
  });

  it('accepts an international number regardless of default country', () => {
    expect(normalizePhone('+14155552671', 'IL')).toBe('+14155552671');
  });

  it('rejects a number that is not valid', () => {
    expect(() => normalizePhone('12', 'IL')).toThrow();
  });

  it('rejects free text', () => {
    expect(() => normalizePhone('call me maybe', 'IL')).toThrow();
  });
});

describe('phoneCountry', () => {
  it('identifies an Israeli number', () => {
    expect(phoneCountry('+972501234567')).toBe('IL');
  });

  it('identifies a US number', () => {
    expect(phoneCountry('+14155552671')).toBe('US');
  });

  it('returns undefined for an unparseable value', () => {
    expect(phoneCountry('nonsense')).toBeUndefined();
  });
});
