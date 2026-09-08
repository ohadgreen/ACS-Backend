import { Module } from '@nestjs/common';
import { LocationsModule } from '../locations/locations.module';
import { OperatorsModule } from '../operators/operators.module';
import { PresenceController } from './presence.controller';
import { PresenceRepository } from './presence.repository';
import { PresenceService } from './presence.service';

@Module({
  imports: [LocationsModule, OperatorsModule],
  controllers: [PresenceController],
  providers: [PresenceRepository, PresenceService],
  exports: [PresenceRepository, PresenceService],
})
export class PresenceModule {}
