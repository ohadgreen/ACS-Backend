import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsDeliveryError, type SmsProvider } from './sms-provider';
import type { Env } from '../../infra/config/env.schema';

const ENDPOINT = 'https://api.sms4free.co.il/ApiSMS/v2/SendSMS';
const TIMEOUT_MS = 10_000;

interface Sms4FreeResponse {
  status?: number;
  message?: string;
}

@Injectable()
export class Sms4FreeProvider implements SmsProvider {
  private readonly logger = new Logger(Sms4FreeProvider.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  async send(phone: string, message: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: this.config.get('SMS4FREE_API_KEY', { infer: true }),
          user: this.config.get('SMS4FREE_USER', { infer: true }),
          pass: this.config.get('SMS4FREE_PASS', { infer: true }),
          sender: this.config.get('SMS4FREE_SENDER', { infer: true }),
          recipient: phone,
          msg: message,
        }),
        // A hung gateway must not hold an HTTP request open indefinitely.
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      this.logger.error({ err: cause }, 'SMS4Free request failed');
      throw new SmsDeliveryError('SMS_DELIVERY_FAILED', 'Could not reach the SMS gateway.');
    }

    const body = (await res.json().catch(() => ({}))) as Sms4FreeResponse;

    // SMS4Free returns a positive count on success and a negative error code on
    // failure. Log the vendor detail; never return it — the message can name
    // account state the caller has no business seeing.
    if (!res.ok || (body.status ?? -1) <= 0) {
      this.logger.error(
        {
          httpStatus: res.status,
          providerStatus: body.status,
          providerMessage: body.message,
          phone,
        },
        'SMS4Free rejected a send',
      );
      throw new SmsDeliveryError('SMS_DELIVERY_FAILED', 'The SMS gateway rejected the message.');
    }
  }
}
