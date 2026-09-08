import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/errors/exception.filter';
import { ZodValidationPipe } from '../../src/common/validation/zod-validation.pipe';

export interface TestApp {
  app: INestApplication;
  server: Server;
  close(): Promise<void>;
}

export interface CreateTestAppOptions {
  overrides?: Array<{ token: unknown; value: unknown }>;
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  // The environment is supplied by vitest.integration.config.ts, which loads
  // before ConfigModule.forRoot() validates it.

  let builder = Test.createTestingModule({ imports: [AppModule] });
  for (const override of options.overrides ?? []) {
    builder = builder.overrideProvider(override.token).useValue(override.value);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();

  return {
    app,
    server: app.getHttpServer() as Server,
    close: () => app.close(),
  };
}
