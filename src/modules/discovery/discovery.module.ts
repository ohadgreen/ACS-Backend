import { Module } from '@nestjs/common';
import { LocationsModule } from '../locations/locations.module';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryRepository } from './discovery.repository';
import { DiscoveryService } from './discovery.service';

@Module({
  imports: [LocationsModule],
  controllers: [DiscoveryController],
  providers: [DiscoveryRepository, DiscoveryService],
  exports: [DiscoveryRepository],
})
export class DiscoveryModule {}
