import { Module } from '@nestjs/common';
import { AdminLocationsController } from './admin-locations.controller';
import { LocationsRepository } from './locations.repository';
import { LocationsService } from './locations.service';

@Module({
  controllers: [AdminLocationsController],
  providers: [LocationsRepository, LocationsService],
  exports: [LocationsRepository, LocationsService],
})
export class LocationsModule {}
