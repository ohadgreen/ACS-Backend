import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-error';
import { ErrorCodes } from '../../common/errors/error-codes';
import { gridTicks, isGridAligned } from '../../common/time/grid';
import { businessDayBounds, isSameBusinessDay } from '../../common/time/business-day';
import { requireEnv, type AppConfig } from '../../infra/config/typed-config';
import { LocationsService } from '../locations/locations.service';
import { OperatorsRepository } from '../operators/operators.repository';
import { CheckinConflict, PresenceRepository } from './presence.repository';

export interface CheckinInput {
  locationId: string;
  availableFrom: Date;
  availableUntil: Date;
  lat: number;
  lng: number;
}

@Injectable()
export class PresenceService {
  constructor(
    private readonly repo: PresenceRepository,
    private readonly locations: LocationsService,
    private readonly operatorsRepo: OperatorsRepository,
    // AppConfig is a type alias, so it carries no metadata for Nest to resolve.
    @Inject(ConfigService) private readonly config: AppConfig,
  ) {}

  async checkIn(operatorId: string, dto: CheckinInput) {
    const operator = await this.operatorsRepo.findById(operatorId);
    if (operator?.approvalStatus !== 'approved') {
      throw new ForbiddenError(
        ErrorCodes.OPERATOR_NOT_APPROVED,
        'Only approved operators can check in.',
        { approvalStatus: operator?.approvalStatus ?? 'missing' },
      );
    }

    await this.locations.requireActive(dto.locationId);

    const slotMinutes = requireEnv(this.config, 'SLOT_DURATION_MIN');
    const timeZone = requireEnv(this.config, 'BUSINESS_TIMEZONE');

    if (
      !isGridAligned(dto.availableFrom, slotMinutes) ||
      !isGridAligned(dto.availableUntil, slotMinutes)
    ) {
      throw new ValidationError(
        ErrorCodes.VALIDATION_FAILED,
        'Window is not aligned to the slot grid.',
        { slotMinutes },
      );
    }
    if (dto.availableUntil <= dto.availableFrom) {
      throw new ValidationError(ErrorCodes.VALIDATION_FAILED, 'Window end must follow its start.', {
        field: 'availableUntil',
      });
    }

    // A window crossing local midnight would produce slots that discovery's
    // today-filter silently hides, so reject it rather than create dead rows.
    const lastTick = new Date(dto.availableUntil.getTime() - slotMinutes * 60_000);
    if (!isSameBusinessDay(dto.availableFrom, lastTick, timeZone)) {
      throw new ValidationError(
        ErrorCodes.WINDOW_CROSSES_BUSINESS_DAY,
        'A check-in window must stay within one business day.',
        { timeZone },
      );
    }

    const tolerance = requireEnv(this.config, 'CHECKIN_LOCATION_TOLERANCE_M');
    if (!(await this.repo.isWithinTolerance(dto.locationId, dto.lat, dto.lng, tolerance))) {
      throw new ValidationError(
        ErrorCodes.NOT_AT_LOCATION,
        'Reported position is too far from the location.',
        { toleranceMeters: tolerance },
      );
    }

    const ticks = gridTicks(dto.availableFrom, dto.availableUntil, slotMinutes);

    try {
      const result = await this.repo.createCheckinWithSlots({ operatorId, ...dto, ticks });
      return {
        checkinId: result.checkinId,
        locationId: dto.locationId,
        availableFrom: dto.availableFrom.toISOString(),
        availableUntil: dto.availableUntil.toISOString(),
        slotsCreated: result.created.length,
      };
    } catch (cause) {
      if (cause instanceof CheckinConflict) {
        throw new ConflictError(
          ErrorCodes.CHECKIN_TICK_CONFLICT,
          'You are already committed at some of these times.',
          { conflicts: cause.conflicts.map((d) => d.toISOString()) },
        );
      }
      throw cause;
    }
  }

  async endCheckin(operatorId: string, checkinId: string) {
    const cancelled = await this.repo.endCheckin(operatorId, checkinId);
    if (cancelled === null) {
      // 404 rather than 403: the caller must not learn that someone else's
      // check-in exists under that id.
      throw new NotFoundError(ErrorCodes.CHECKIN_NOT_FOUND, 'No such check-in.');
    }
    return { checkinId, slotsCancelled: cancelled };
  }

  /**
   * Availability is purely which slot rows exist and are open, so a break needs
   * no new state — it cancels rows. Booked slots block the whole request so a
   * break can never become a backdoor for abandoning a committed customer.
   */
  async takeBreak(operatorId: string, from: Date, to: Date) {
    const slotMinutes = requireEnv(this.config, 'SLOT_DURATION_MIN');
    if (!isGridAligned(from, slotMinutes) || !isGridAligned(to, slotMinutes)) {
      throw new ValidationError(ErrorCodes.VALIDATION_FAILED, 'Break range is not grid-aligned.', {
        slotMinutes,
      });
    }
    if (to <= from) {
      throw new ValidationError(ErrorCodes.VALIDATION_FAILED, 'Break end must follow its start.', {
        field: 'to',
      });
    }

    const booked = await this.repo.bookedSlotsInRange(operatorId, from, to);
    if (booked.length > 0) {
      throw new ConflictError(
        ErrorCodes.BREAK_HAS_BOOKINGS,
        'Cancel the bookings in this range before taking a break.',
        { conflicts: booked.map((b) => b.startAt.toISOString()) },
      );
    }

    const cancelled = await this.repo.cancelOpenSlotsInRange(operatorId, from, to);
    return { slotsCancelled: cancelled };
  }

  /**
   * `date` is a calendar day in the business timezone. Anchoring at noon UTC
   * keeps the lookup on the intended day for every zone offset, rather than
   * landing on the previous day for anything east of UTC.
   */
  async schedule(operatorId: string, date: string | undefined) {
    const timeZone = requireEnv(this.config, 'BUSINESS_TIMEZONE');
    const anchor = date ? new Date(`${date}T12:00:00.000Z`) : new Date();
    if (Number.isNaN(anchor.getTime())) {
      throw new ValidationError(ErrorCodes.VALIDATION_FAILED, 'date must be YYYY-MM-DD.', {
        field: 'date',
      });
    }
    const { start, end } = businessDayBounds(anchor, timeZone);
    const slots = await this.repo.scheduleFor(operatorId, start, end);
    return { date: date ?? null, timeZone, slots };
  }
}
