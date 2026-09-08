import { SmsDeliveryError, type SmsProvider } from './sms-provider';

export class FakeSmsProvider implements SmsProvider {
  readonly sent: Array<{ phone: string; message: string }> = [];
  failNext = false;

  async send(phone: string, message: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new SmsDeliveryError('SMS_DELIVERY_FAILED', 'Fake provider was told to fail.');
    }
    this.sent.push({ phone, message });
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
