import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { ValidationError } from '../../common/errors/domain-error';
import { ErrorCodes } from '../../common/errors/error-codes';

/**
 * Every phone reaching storage, an SMS gateway, or a rate-limit key passes
 * through here. `0501234567` and `+972501234567` must collapse to one value,
 * or the OTP cooldown, daily cap, and attempt counter all key off different
 * strings for one real phone and are trivially bypassed.
 */
export function normalizePhone(raw: string, defaultCountry: CountryCode = 'IL'): string {
  const parsed = parsePhoneNumberFromString(raw.trim(), defaultCountry);
  if (!parsed?.isValid()) {
    throw new ValidationError(ErrorCodes.VALIDATION_FAILED, 'Phone number is not valid.', {
      field: 'phone',
    });
  }
  return parsed.number;
}

/** Used to gate delivery: the MVP gateway serves one country. */
export function phoneCountry(raw: string, defaultCountry: CountryCode = 'IL'): string | undefined {
  return parsePhoneNumberFromString(raw.trim(), defaultCountry)?.country;
}
