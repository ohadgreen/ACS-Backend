import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger as PinoLogger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/errors/exception.filter';
import { ZodValidationPipe } from './common/validation/zod-validation.pipe';
import type { Env } from './infra/config/env.schema';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<Env, true>);

  app.useLogger(app.get(PinoLogger));
  app.use(helmet());
  // Behind a TLS-terminating proxy, without this every request appears to come
  // from the load balancer and per-IP rate limits collapse into one global limit.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(new ZodValidationPipe());

  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
