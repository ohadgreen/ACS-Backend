import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from 'uuidv7';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { AppConfigModule } from '../../src/infra/config/config.module';
import { DrizzleModule } from '../../src/infra/db/drizzle.module';
import { users } from '../../src/infra/db/schema';
import { UsersModule } from '../../src/modules/users/users.module';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { NotificationsWorkerModule } from '../../src/modules/notifications/notifications.worker.module';
import { QueueModule } from '../../src/infra/queue/queue.module';
import { PUSH_QUEUE_TOKEN } from '../../src/infra/queue/queue.constants';
import { PushProcessor } from '../../src/modules/notifications/push.processor';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { DevicesRepository } from '../../src/modules/notifications/devices.repository';
import { PUSH_PROVIDER } from '../../src/modules/notifications/push-provider';
import type { FakePushProvider } from '../../src/modules/notifications/fake-push.provider';
import { getTestDb } from './db.helper';

const db = getTestDb();

let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
let processor: PushProcessor;
let devices: DevicesRepository;
let push: FakePushProvider;
let notifications: NotificationsService;
let queue: Queue;

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule,
      DrizzleModule,
      QueueModule,
      UsersModule,
      NotificationsModule,
      NotificationsWorkerModule,
    ],
  }).compile();

  processor = moduleRef.get(PushProcessor);
  devices = moduleRef.get(DevicesRepository);
  push = moduleRef.get<FakePushProvider>(PUSH_PROVIDER);
  notifications = moduleRef.get(NotificationsService);
  queue = moduleRef.get<Queue>(PUSH_QUEUE_TOKEN);
});

afterAll(async () => {
  await moduleRef?.close();
});

async function makeCustomer(locale: string) {
  const id = uuidv7();
  await db
    .insert(users)
    .values({ id, role: 'customer', phone: `+9725${Date.now() % 100000000}`, preferredLocale: locale });
  return id;
}

beforeEach(() => {
  push.reset();
});

describe('push processor', () => {
  it('renders in the user preferred locale and sends to every active device', async () => {
    const userId = await makeCustomer('he');
    await devices.register(userId, 'tok-a', 'ios');
    await devices.register(userId, 'tok-b', 'android');

    await processor.handle({ userId, key: 'SESSION_STARTING', data: { bookingId: 'b1' } });

    expect(push.sent).toHaveLength(2);
    expect(push.sent.map((m) => m.token).sort()).toEqual(['tok-a', 'tok-b']);
    expect(push.sent[0]!.title).toBe('הצילום שלך מתחיל עכשיו');
    // Carried through so tapping the notification opens the right booking.
    expect(push.sent[0]!.data).toEqual({ bookingId: 'b1' });
  });

  it('renders English for an English user', async () => {
    const userId = await makeCustomer('en');
    await devices.register(userId, 'tok-en', 'ios');

    await processor.handle({ userId, key: 'SESSION_STARTING', data: {} });

    expect(push.sent[0]!.title).toBe('Your session starts now');
  });

  // Not an error: the user has not installed the app or declined permission.
  it('completes without sending when the user has no devices', async () => {
    const userId = await makeCustomer('he');
    await expect(
      processor.handle({ userId, key: 'SESSION_STARTING', data: {} }),
    ).resolves.toBeUndefined();
    expect(push.sent).toEqual([]);
  });

  it('completes quietly for a user that no longer exists', async () => {
    await expect(
      processor.handle({ userId: uuidv7(), key: 'SESSION_STARTING', data: {} }),
    ).resolves.toBeUndefined();
  });

  // Without reaping, dead tokens accumulate permanently and every later send
  // does provably wasted work.
  it('revokes a token the transport reports as unregistered', async () => {
    const userId = await makeCustomer('he');
    await devices.register(userId, 'tok-dead', 'ios');
    push.failNextWith = 'DEVICE_NOT_REGISTERED';

    await processor.handle({ userId, key: 'SESSION_STARTING', data: {} });

    expect(await devices.listActiveFor(userId)).toEqual([]);
  });

  it('does not send to a reaped token on the next notification', async () => {
    const userId = await makeCustomer('he');
    await devices.register(userId, 'tok-dead', 'ios');
    push.failNextWith = 'DEVICE_NOT_REGISTERED';
    await processor.handle({ userId, key: 'SESSION_STARTING', data: {} });

    push.reset();
    await processor.handle({ userId, key: 'SESSION_STARTING', data: {} });
    expect(push.sent).toEqual([]);
  });

  it('throws on a transient failure so BullMQ retries', async () => {
    const userId = await makeCustomer('he');
    await devices.register(userId, 'tok-flaky', 'ios');
    push.failNextWith = 'TRANSIENT';

    await expect(processor.handle({ userId, key: 'SESSION_STARTING', data: {} })).rejects.toThrow();
    // A transient failure says nothing about the token, so it must survive.
    expect(await devices.listActiveFor(userId)).toEqual(['tok-flaky']);
  });

  it('does not throw on an invalid message, which retrying cannot fix', async () => {
    const userId = await makeCustomer('he');
    await devices.register(userId, 'tok-invalid', 'ios');
    push.failNextWith = 'INVALID';

    await expect(
      processor.handle({ userId, key: 'SESSION_STARTING', data: {} }),
    ).resolves.toBeUndefined();
    // A malformed message says nothing about whether the device is alive.
    expect(await devices.listActiveFor(userId)).toEqual(['tok-invalid']);
  });
});

describe('notification producer', () => {
  it('enqueues a payload that carries ids only, not tokens or locale', async () => {
    const userId = uuidv7();

    await notifications.notify(userId, 'SESSION_STARTING', { bookingId: 'b1' });

    const [job] = await queue.getWaiting();
    expect(job!.data).toEqual({ userId, key: 'SESSION_STARTING', data: { bookingId: 'b1' } });
    // The regression this guards: resolving tokens/locale at enqueue time
    // instead of at send time, which would push to a token revoked in the
    // interim after a retry backoff.
    expect(job!.data).not.toHaveProperty('token');
    expect(job!.data).not.toHaveProperty('tokens');
    expect(job!.data).not.toHaveProperty('locale');
  });

  it('sets retry options so a TRANSIENT failure actually gets retried', async () => {
    const userId = uuidv7();

    await notifications.notify(userId, 'SESSION_STARTING', {});

    const [job] = await queue.getWaiting();
    expect(job!.opts.attempts).toBe(5);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 2000 });
  });
});
