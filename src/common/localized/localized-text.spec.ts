import { describe, expect, it } from 'vitest';
import { localizedTextSchema } from './localized-text';

const schema = localizedTextSchema(['en', 'he']);

describe('localizedTextSchema', () => {
  it('accepts an object carrying every supported locale', () => {
    expect(schema.parse({ en: 'Beginner Slope', he: 'מסלול מתחילים' })).toEqual({
      en: 'Beginner Slope',
      he: 'מסלול מתחילים',
    });
  });

  it('rejects a missing locale', () => {
    expect(() => schema.parse({ en: 'Beginner Slope' })).toThrow();
  });

  it('rejects an empty string for a supported locale', () => {
    expect(() => schema.parse({ en: '', he: 'מסלול' })).toThrow();
  });

  it('rejects an unsupported extra locale rather than silently keeping it', () => {
    expect(() => schema.parse({ en: 'A', he: 'ב', fr: 'C' })).toThrow();
  });

  it('rejects a plain string', () => {
    expect(() => schema.parse('Beginner Slope')).toThrow();
  });

  it('adapts to a different supported set', () => {
    const trilingual = localizedTextSchema(['en', 'he', 'ar']);
    expect(() => trilingual.parse({ en: 'A', he: 'ב' })).toThrow();
    expect(trilingual.parse({ en: 'A', he: 'ב', ar: 'ج' })).toBeTruthy();
  });
});
