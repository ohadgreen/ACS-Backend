import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConflictError, ForbiddenError, ValidationError } from '../../common/errors/domain-error';
import { ErrorCodes } from '../../common/errors/error-codes';
import { isGridAligned } from '../../common/time/grid';
import { businessDayBounds } from '../../common/time/business-day';
import { isUniqueViolation } from '../../infra/db/pg-error';
import { requireEnv, type AppConfig } from '../../infra/config/typed-config';
import { LocationsRepository } from '../locations/locations.repository';
import { UsersRepository } from '../users/users.repository';
import { BookingsRepository } from './bookings.repository';

export interface CreateBookingRequest {
  locationId: string;
  startAt: Date;
  locationSessionTypeId: string;
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly repo: BookingsRepository,
    private readonly locationsRepo: LocationsRepository,
    private readonly usersRepo: UsersRepository,
    @Inject(ConfigService) private readonly config: AppConfig,
  ) {}

  async create(customerId: string, dto: CreateBookingRequest) {
    const customer = await this.usersRepo.findById(customerId);
    if (!customer?.phoneVerifiedAt) {
      throw new ForbiddenError(
        ErrorCodes.PHONE_NOT_VERIFIED,
        'Verify your phone number before booking.',
      );
    }

    const slotMinutes = requireEnv(this.config, 'SLOT_DURATION_MIN');
    if (!isGridAligned(dto.startAt, slotMinutes)) {
      throw new ValidationError(
        ErrorCodes.VALIDATION_FAILED,
        'Start time is not on the slot grid.',
        { field: 'startAt', slotMinutes },
      );
    }

    const leadMin = requireEnv(this.config, 'BOOKING_LEAD_TIME_MIN');
    if (dto.startAt.getTime() < Date.now() + leadMin * 60_000) {
      throw new ValidationError(ErrorCodes.VALIDATION_FAILED, 'That start time is too soon to book.', {
        field: 'startAt',
        leadTimeMinutes: leadMin,
      });
    }

    const sessionType = await this.locationsRepo.findSessionType(dto.locationSessionTypeId);
    if (!sessionType || sessionType.locationId !== dto.locationId || !sessionType.isActive) {
      throw new ValidationError(
        ErrorCodes.SESSION_TYPE_NOT_FOUND,
        'That session type is not offered at this location.',
        { field: 'locationSessionTypeId' },
      );
    }

    // The fairness window is the business day containing the slot, not today:
    // an advance booking must be balanced against that day's load.
    const { start, end } = businessDayBounds(
      dto.startAt,
      requireEnv(this.config, 'BUSINESS_TIMEZONE'),
    );

    try {
      const booking = await this.repo.createBooking({
        locationId: dto.locationId,
        startAt: dto.startAt,
        sessionTypeId: dto.locationSessionTypeId,
        customerId,
        dayStart: start,
        dayEnd: end,
      });

      if (!booking) {
        throw new ConflictError(ErrorCodes.SLOT_UNAVAILABLE, 'That slot is no longer available.', {
          startAt: dto.startAt.toISOString(),
        });
      }
      return booking;
    } catch (cause) {
      // Matched by name: a violation of the slot-side index is a different
      // failure entirely and must not be reported as the customer's fault.
      if (isUniqueViolation(cause, 'customer_one_booking_per_tick')) {
        throw new ConflictError(
          ErrorCodes.CUSTOMER_ALREADY_BOOKED,
          'You already have a booking at that time.',
          { startAt: dto.startAt.toISOString() },
        );
      }
      throw cause;
    }
  }
}
