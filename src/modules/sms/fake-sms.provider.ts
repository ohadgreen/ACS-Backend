import { Logger } from '@nestjs/common';
import { SmsDeliveryError, type SmsProvider } from './sms-provider';

export class FakeSmsProvider implements SmsProvider {
  private readonly logger = new Logger(FakeSmsProvider.name);

  readonly sent: Array<{ phone: string; message: string }> = [];
  failNext = false;

  // Not `async`: there is nothing to await, but the contract is a Promise and a
  // failure must reject rather than throw synchronously.
  send(phone: string, message: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(
        new SmsDeliveryError('SMS_DELIVERY_FAILED', 'Fake provider was told to fail.'),
      );
    }
    this.sent.push({ phone, message });

    // Local development needs to read the code, since nothing is actually sent.
    // Silent under test, where suites read it from `sent` instead.
    if (process.env.NODE_ENV !== 'test') {
      this.logger.log(`[fake SMS] ${phone}: ${message}`);
    }
    return Promise.resolve();
  }

  /**
   * The last 6-digit run sent to that number. Lets e2e tests read the real code
   * off the wire, so the whole OTP protocol is exercised rather than stubbed.
   */
  lastCodeFor(phone: string): string | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const entry = this.sent[i]!;
      if (entry.phone !== phone) continue;
      const match = /(\d{6})/.exec(entry.message);
      if (match) return match[1];
    }
    return undefined;
  }
}
