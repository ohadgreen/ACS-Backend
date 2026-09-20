import { describe, expect, it } from 'vitest';
import { PUSH_TEMPLATES, renderPush, type PushTemplateKey } from './push-templates';

const KEYS = Object.keys(PUSH_TEMPLATES) as PushTemplateKey[];
const LOCALES = ['en', 'he'];

describe('push templates', () => {
  it.each(KEYS)('%s is defined in every supported locale', (key) => {
    for (const locale of LOCALES) {
      const content = renderPush(key, locale);
      expect(content.title.length).toBeGreaterThan(0);
      expect(content.body.length).toBeGreaterThan(0);
    }
  });

  // Guards the phase-4 templates, which will interpolate: a missing parameter
  // must not ship a literal placeholder to a customer's lock screen.
  it.each(KEYS)('%s leaves no unsubstituted placeholder', (key) => {
    for (const locale of LOCALES) {
      const { title, body } = renderPush(key, locale);
      expect(`${title} ${body}`).not.toMatch(/[{}]/);
    }
  });

  it('falls back to English for an unknown locale', () => {
    expect(renderPush('SESSION_STARTING', 'fr')).toEqual(renderPush('SESSION_STARTING', 'en'));
  });

  it('renders Hebrew differently from English', () => {
    expect(renderPush('SESSION_STARTING', 'he')).not.toEqual(renderPush('SESSION_STARTING', 'en'));
  });

  it('keeps titles short enough for a lock screen', () => {
    for (const key of KEYS) {
      for (const locale of LOCALES) {
        expect(renderPush(key, locale).title.length).toBeLessThanOrEqual(40);
      }
    }
  });
});
