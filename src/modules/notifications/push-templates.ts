export type PushTemplateKey = 'SESSION_STARTING' | 'CUSTOMER_READY';

export interface PushContent {
  title: string;
  body: string;
}

/**
 * Developer-owned strings, so they live in code rather than the database —
 * the same split as OTP_TEMPLATES.
 *
 * A push is the documented exception to the rule that the server never
 * pre-resolves a locale: the text is delivered by the OS, so the client cannot
 * localize it after the fact. `users.preferred_locale` decides which one.
 *
 * No interpolation yet — neither notification carries a variable. Phase 4's
 * PROMO_READY is the first that will, and the spec's placeholder test is
 * already here waiting for it.
 */
export const PUSH_TEMPLATES: Record<PushTemplateKey, Record<string, PushContent>> = {
  SESSION_STARTING: {
    en: { title: 'Your session starts now', body: 'Tap to confirm you are ready to film.' },
    he: { title: 'הצילום שלך מתחיל עכשיו', body: 'הקישו כדי לאשר שאתם מוכנים.' },
  },
  CUSTOMER_READY: {
    en: { title: 'Customer is ready', body: 'They confirmed they are at the location.' },
    he: { title: 'הלקוח מוכן', body: 'התקבל אישור שהלקוח נמצא במקום.' },
  },
};

export function renderPush(key: PushTemplateKey, locale: string): PushContent {
  const byLocale = PUSH_TEMPLATES[key];
  return byLocale[locale] ?? byLocale.en!;
}
