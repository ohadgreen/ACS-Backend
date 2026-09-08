import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from './env.schema';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Under test, ignore .env entirely. Otherwise a developer's local file
      // silently overrides the values the test harness sets, and suites end up
      // running against the development database.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      // Throws at boot on a missing or invalid variable, rather than at first
      // use somewhere deep in a request.
      validate: (raw) => envSchema.parse(raw),
    }),
  ],
})
export class AppConfigModule {}
