import { z } from 'zod';

/**
 * A display string in every supported language. Stored as `jsonb` and returned
 * to clients whole — the server never picks a locale on the client's behalf,
 * because the app can switch language without re-fetching.
 */
export type LocalizedText = Record<string, string>;

/**
 * Builds a strict validator for the configured locale set. Strict rather than
 * permissive: an unexpected locale key is a typo or a config drift, and letting
 * it through means it silently never renders anywhere.
 */
export function localizedTextSchema(locales: string[]) {
  const shape = Object.fromEntries(
    locales.map((locale) => [locale, z.string().min(1).max(2000)]),
  );
  // strictObject rather than the deprecated `.strict()` method — zod 4 moved
  // unknown-key policy into the constructor.
  return z.strictObject(shape);
}

/** The locale list as validated by env.schema.ts, for DTOs built at import time. */
export function supportedLocales(): string[] {
  return (process.env.SUPPORTED_LOCALES ?? 'en,he')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
