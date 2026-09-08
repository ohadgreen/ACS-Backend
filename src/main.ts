import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import type { Env } from './infra/config/env.schema';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<Env, true>);

  app.use(helmet());
  // Behind a TLS-terminating proxy, without this every request appears to come
  // from the load balancer and per-IP rate limits collapse into one global limit.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
