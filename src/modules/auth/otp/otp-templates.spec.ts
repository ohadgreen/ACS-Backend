import { describe, expect, it } from 'vitest';
import { OTP_TEMPLATES, renderOtpMessage } from './otp-templates';

describe('renderOtpMessage', () => {
  it('renders the English template with the code and lifetime', () => {
    const message = renderOtpMessage('en', '048512', 5);
    expect(message).toContain('048512');
    expect(message).toContain('5');
  });

  it('renders the Hebrew template with the code', () => {
    expect(renderOtpMessage('he', '048512', 5)).toContain('048512');
  });

  it('falls back to English for an unknown locale', () => {
    expect(renderOtpMessage('fr', '048512', 5)).toBe(renderOtpMessage('en', '048512', 5));
  });

  it.each(Object.keys(OTP_TEMPLATES))('the %s template fits one SMS segment', (locale) => {
    // Hebrew is UCS-2 at 70 chars per segment; English GSM-7 gets 160.
    const limit = locale === 'en' ? 160 : 70;
    expect(renderOtpMessage(locale, '048512', 5).length).toBeLessThanOrEqual(limit);
  });

  it('never leaks a placeholder into the rendered text', () => {
    for (const locale of Object.keys(OTP_TEMPLATES)) {
      expect(renderOtpMessage(locale, '048512', 5)).not.toMatch(/\{|\}/);
    }
  });
});
