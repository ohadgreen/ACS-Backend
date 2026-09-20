import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { requireEnv, type AppConfig } from '../config/typed-config';
import { PUSH_QUEUE, PUSH_QUEUE_TOKEN, QUEUE_CONNECTION } from './queue.constants';

@Global()
@Module({
  providers: [
    {
      provide: QUEUE_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: AppConfig) =>
        new IORedis(requireEnv(config, 'REDIS_URL'), {
          // Mandatory for BullMQ, and the reason this cannot share the REDIS
          // provider in infra/redis: that one sets maxRetriesPerRequest to 2,
          // which aborts the long blocking reads BullMQ's workers depend on.
          maxRetriesPerRequest: null,
        }),
    },
    {
      provide: PUSH_QUEUE_TOKEN,
      inject: [QUEUE_CONNECTION, ConfigService],
      useFactory: (connection: IORedis, config: AppConfig) =>
        new Queue(PUSH_QUEUE, { connection, prefix: requireEnv(config, 'QUEUE_PREFIX') }),
    },
  ],
  exports: [QUEUE_CONNECTION, PUSH_QUEUE_TOKEN],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(
    @Inject(PUSH_QUEUE_TOKEN) private readonly pushQueue: Queue,
    @Inject(QUEUE_CONNECTION) private readonly connection: IORedis,
  ) {}

  // Queue before connection: closing the connection first leaves the queue's
  // in-flight commands to fail rather than drain.
  async onApplicationShutdown() {
    await this.pushQueue.close();
    await this.connection.quit();
  }
}
