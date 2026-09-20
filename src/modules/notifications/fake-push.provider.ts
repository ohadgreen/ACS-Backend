import { Logger } from '@nestjs/common';
import type { PushFailure, PushMessage, PushProvider, PushResult } from './push-provider';

/**
 * Records notifications instead of sending them. Integration and e2e suites
 * read `sent` back, so the whole path — enqueue, resolve, render, send — runs
 * rather than being mocked away, exactly as FakeSmsProvider carries the OTP
 * tests.
 */
export class FakePushProvider implements PushProvider {
  private readonly logger = new Logger(FakePushProvider.name);

  readonly sent: PushMessage[] = [];
  failNextWith: PushFailure | undefined;

  send(messages: PushMessage[]): Promise<PushResult[]> {
    const failure = this.failNextWith;
    if (failure) {
      this.failNextWith = undefined;
      return Promise.resolve(messages.map((m) => ({ token: m.token, ok: false, error: failure })));
    }

    this.sent.push(...messages);
    if (process.env.NODE_ENV !== 'test') {
      for (const m of messages) {
        this.logger.log(`[fake push] ${m.token}: ${m.title} — ${m.body}`);
      }
    }
    return Promise.resolve(messages.map((m) => ({ token: m.token, ok: true })));
  }

  reset(): void {
    this.sent.length = 0;
    this.failNextWith = undefined;
  }
}
