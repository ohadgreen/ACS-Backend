import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from './env.schema';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Throws at boot on a missing or invalid variable, rather than at first
      // use somewhere deep in a request.
      validate: (raw) => envSchema.parse(raw),
    }),
  ],
})
export class AppConfigModule {}
