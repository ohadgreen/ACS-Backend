import { Logger } from '@nestjs/common';
import type { PushFailure, PushMessage, PushProvider, PushResult } from './push-provider';

const ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/** Expo rejects larger batches outright. */
const MAX_BATCH = 100;

interface ExpoTicket {
  status: 'ok' | 'error';
  details?: { error?: string };
}

/**
 * Maps Expo's ticket vocabulary onto ours. Anything unrecognised is treated as
 * transient: retrying a handful of times is cheaper than silently dropping a
 * notification because Expo added an error code we had not seen.
 */
function classify(detail: string | undefined): PushFailure {
  switch (detail) {
    case 'DeviceNotRegistered':
      return 'DEVICE_NOT_REGISTERED';
    case 'MessageTooBig':
    case 'InvalidCredentials':
      return 'INVALID';
    default:
      return 'TRANSIENT';
  }
}

export class ExpoPushProvider implements PushProvider {
  private readonly logger = new Logger(ExpoPushProvider.name);

  constructor(private readonly accessToken: string | undefined) {}

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    const results: PushResult[] = [];
    for (let i = 0; i < messages.length; i += MAX_BATCH) {
      results.push(...(await this.sendBatch(messages.slice(i, i + MAX_BATCH))));
    }
    return results;
  }

  private async sendBatch(batch: PushMessage[]): Promise<PushResult[]> {
    const allTransient = (): PushResult[] =>
      batch.map((m) => ({ token: m.token, ok: false, error: 'TRANSIENT' as const }));

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(
          batch.map((m) => ({ to: m.token, title: m.title, body: m.body, data: m.data })),
        ),
      });
    } catch (cause) {
      this.logger.warn(`push transport unreachable: ${String(cause)}`);
      return allTransient();
    }

    if (!response.ok) {
      this.logger.warn(`push transport returned ${response.status}`);
      return allTransient();
    }

    const payload = (await response.json()) as { data?: ExpoTicket[] };
    const tickets = payload.data ?? [];

    return batch.map((m, index) => {
      const ticket = tickets[index];
      // A missing ticket means the response did not line up with the request;
      // retrying is the safe reading.
      if (!ticket) return { token: m.token, ok: false, error: 'TRANSIENT' as const };
      if (ticket.status === 'ok') return { token: m.token, ok: true };
      return { token: m.token, ok: false, error: classify(ticket.details?.error) };
    });
  }
}
