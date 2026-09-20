import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PUSH_JOB, PUSH_QUEUE_TOKEN } from '../../infra/queue/queue.constants';
import type { PushTemplateKey } from './push-templates';

@Injectable()
export class NotificationsService {
  constructor(@Inject(PUSH_QUEUE_TOKEN) private readonly queue: Queue) {}

  /**
   * `data` is the push payload delivered to the client, not template
   * parameters — neither template interpolates anything, but the app needs the
   * booking id to open the right screen when the notification is tapped.
   *
   * The job carries ids only. Device tokens and locale are resolved in the
   * processor at send time, so a job retried after a backoff cannot push to a
   * token revoked in the meantime.
   */
  async notify(
    userId: string,
    key: PushTemplateKey,
    data: Record<string, string> = {},
  ): Promise<void> {
    await this.queue.add(
      PUSH_JOB,
      { userId, key, data },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );
  }
}
