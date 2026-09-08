/**
 * Developer-owned strings, so they live in code rather than the database —
 * unlike admin-authored content.
 *
 * Keep the Hebrew text short: Hebrew SMS encodes as UCS-2 at 70 characters per
 * segment (GSM-7 gives 160), so a longer template silently bills two segments
 * for every code sent. A unit test asserts the ceiling.
 */
export const OTP_TEMPLATES: Record<string, (code: string, minutes: number) => string> = {
  en: (code, minutes) => `ACS code: ${code}. Valid ${minutes} min.`,
  he: (code, minutes) => `קוד ACS: ${code}. תקף ${minutes} דקות.`,
};

export function renderOtpMessage(locale: string, code: string, ttlMinutes: number): string {
  const template = OTP_TEMPLATES[locale] ?? OTP_TEMPLATES.en!;
  return template(code, ttlMinutes);
}
