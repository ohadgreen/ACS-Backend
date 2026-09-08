import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SMS_PROVIDER, type SmsProvider } from './sms-provider';
import { Sms4FreeProvider } from './sms4free.provider';
import { FakeSmsProvider } from './fake-sms.provider';
import type { Env } from '../../infra/config/env.schema';

/**
 * The single place a vendor is chosen. Adding InforU means one more class and
 * one more case here; nothing that sends SMS changes.
 */
@Global()
@Module({
  providers: [
    {
      provide: SMS_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): SmsProvider => {
        const name = config.get('SMS_PROVIDER', { infer: true });
        switch (name) {
          case 'sms4free':
            return new Sms4FreeProvider(config);
          case 'fake':
            return new FakeSmsProvider();
          default:
            // Fail at boot, not on the first customer's login attempt.
            throw new Error(`Unknown SMS_PROVIDER: ${String(name)}`);
        }
      },
    },
  ],
  exports: [SMS_PROVIDER],
})
export class SmsModule {}
