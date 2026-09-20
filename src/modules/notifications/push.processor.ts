import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { requireEnv, type AppConfig } from '../../infra/config/typed-config';
import {
  PUSH_QUEUE,
  QUEUE_CONNECTION,
  type PushJobData,
} from '../../infra/queue/queue.constants';
import { UsersRepository } from '../users/users.repository';
import { DevicesRepository } from './devices.repository';
import { renderPush, type PushTemplateKey } from './push-templates';
import { PUSH_PROVIDER, PushSendError, type PushProvider } from './push-provider';

@Injectable()
export class PushProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PushProcessor.name);
  private worker: Worker | undefined;

  constructor(
    @Inject(QUEUE_CONNECTION) private readonly connection: IORedis,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
    @Inject(ConfigService) private readonly config: AppConfig,
    private readonly devices: DevicesRepository,
    private readonly users: UsersRepository,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(PUSH_QUEUE, (job) => this.handle(job.data as PushJobData), {
      connection: this.connection,
      prefix: requireEnv(this.config, 'QUEUE_PREFIX'),
      concurrency: requireEnv(this.config, 'WORKER_CONCURRENCY'),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  /**
   * Public so tests can drive the whole path without a live worker loop.
   *
   * Resolution happens here rather than at enqueue time: a job retried after a
   * backoff must not push to a token revoked in the interim.
   */
  async handle(payload: PushJobData): Promise<void> {
    const user = await this.users.findById(payload.userId);
    if (!user) {
      // The account was deleted between enqueue and send. Nothing to do, and
      // retrying will never help.
      return;
    }

    const tokens = await this.devices.listActiveFor(payload.userId);
    // Not an error: the user has not installed the app, or declined permission.
    if (tokens.length === 0) return;

    const content = renderPush(payload.key as PushTemplateKey, user.preferredLocale);
    const results = await this.push.send(
      tokens.map((token) => ({ token, ...content, data: payload.data })),
    );

    const dead = results
      .filter((r) => r.error === 'DEVICE_NOT_REGISTERED')
      .map((r) => r.token);
    if (dead.length > 0) {
      this.logger.log(`revoking ${dead.length} unregistered device token(s)`);
      await this.devices.revokeTokens(dead);
    }

    // INVALID deliberately does not throw: the message is malformed and no
    // number of retries will change that.
    if (results.some((r) => r.error === 'TRANSIENT')) {
      throw new PushSendError(`push transport failed for ${payload.key}`);
    }
  }
}
