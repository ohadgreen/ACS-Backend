import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  // An application context, not an HTTP app: the worker listens on no port.
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  // Without this, onApplicationShutdown never fires on SIGTERM and a redeploy
  // leaves in-flight jobs stalled until their locks expire. Harmless for a
  // push; not harmless for the transcodes arriving in sub-project #4.
  app.enableShutdownHooks();
}

void bootstrap();
