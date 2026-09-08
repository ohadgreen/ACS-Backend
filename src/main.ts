import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/errors/exception.filter';
import { ZodValidationPipe } from './common/validation/zod-validation.pipe';
import type { Env } from './infra/config/env.schema';

async function bootstrap() {
  // Typed as NestExpressApplication so app.set() is a real method rather than
  // reaching through getHttpAdapter().getInstance() into `any`.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<Env, true>);

  app.useLogger(app.get(PinoLogger));
  app.use(helmet());
  // Behind a TLS-terminating proxy, without this every request appears to come
  // from the load balancer and per-IP rate limits collapse into one global limit.
  app.set('trust proxy', 1);

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(new ZodValidationPipe());

  // Generated from the zod DTOs, so the React Native clients get a contract
  // that cannot drift from what the server actually validates.
  const openApi = new DocumentBuilder()
    .setTitle('ACS Backend')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, cleanupOpenApiDoc(SwaggerModule.createDocument(app, openApi)));

  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
