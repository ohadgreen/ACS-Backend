import { Module } from '@nestjs/common';
import { LocationsModule } from '../locations/locations.module';
import { UsersModule } from '../users/users.module';
import { BookingAccessGuard } from './booking-access.guard';
import { BookingsController } from './bookings.controller';
import { BookingsRepository } from './bookings.repository';
import { BookingsService } from './bookings.service';

@Module({
  imports: [LocationsModule, UsersModule],
  controllers: [BookingsController],
  providers: [BookingsRepository, BookingsService, BookingAccessGuard],
  exports: [BookingsRepository, BookingsService],
})
export class BookingsModule {}
