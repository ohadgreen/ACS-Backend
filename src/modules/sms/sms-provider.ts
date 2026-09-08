import { DomainError } from '../../common/errors/domain-error';

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

/**
 * The only external boundary in scope, and deliberately one method. The vendor
 * knows nothing about OTP; swapping SMS4Free for InforU or a managed service is
 * a new class plus a config value, with no change outside the factory.
 *
 * Resolves on gateway acceptance, not handset delivery.
 */
export interface SmsProvider {
  send(phone: string, message: string): Promise<void>;
}

/** Vendor status codes never escape the adapter — this is what callers see. */
export class SmsDeliveryError extends DomainError {
  readonly status = 502;
}
