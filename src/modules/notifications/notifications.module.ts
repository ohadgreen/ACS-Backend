import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requireEnv, type AppConfig } from '../../infra/config/typed-config';
import { DevicesRepository } from './devices.repository';
import { NotificationsService } from './notifications.service';
import { ExpoPushProvider } from './expo-push.provider';
import { FakePushProvider } from './fake-push.provider';
import { PUSH_PROVIDER, type PushProvider } from './push-provider';

/**
 * The single place a push vendor is chosen, mirroring SmsModule. Adding FCM
 * means one more class and one more case here; nothing that sends changes.
 */
@Module({
  providers: [
    DevicesRepository,
    NotificationsService,
    {
      provide: PUSH_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: AppConfig): PushProvider => {
        const name = requireEnv(config, 'PUSH_PROVIDER');
        switch (name) {
          case 'expo':
            return new ExpoPushProvider(config.get('EXPO_ACCESS_TOKEN', { infer: true }));
          case 'fake':
            return new FakePushProvider();
          default:
            // Fail at boot, not on the first notification.
            throw new Error(`Unknown PUSH_PROVIDER: ${String(name)}`);
        }
      },
    },
  ],
  exports: [NotificationsService, DevicesRepository, PUSH_PROVIDER],
})
export class NotificationsModule {}
