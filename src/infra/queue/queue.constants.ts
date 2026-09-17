export const PUSH_QUEUE = 'push';
export const SCHEDULER_QUEUE = 'scheduler';

export const PUSH_JOB = 'send-push';
export const TICK_JOB = 'tick';

/**
 * Stable id for the repeatable tick. Keyed by id, upsertJobScheduler replaces
 * its own schedule when the interval changes — with the older
 * queue.add({ repeat }) API, changing SCHEDULER_TICK_SEC would leave the
 * previous schedule registered and the tick would silently run twice.
 */
export const TICK_SCHEDULER_ID = 'readiness-tick';

export const QUEUE_CONNECTION = Symbol('QUEUE_CONNECTION');
export const PUSH_QUEUE_TOKEN = Symbol('PUSH_QUEUE_TOKEN');

export interface PushJobData {
  userId: string;
  key: string;
  data: Record<string, string>;
}
