import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ForbiddenError, NotFoundError } from '../../common/errors/domain-error';
import { ErrorCodes } from '../../common/errors/error-codes';
import { BookingsRepository } from './bookings.repository';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { Booking } from '../../infra/db/schema';

/**
 * Ownership as a declaration on the route, visible in code review — the answer
 * to Broken Object-Level Authorization. A booking is jointly held by a customer
 * and an operator, so neither can be expressed with a `me`-shaped URL; this
 * guard is what stands in for that.
 */
@Injectable()
export class BookingAccessGuard implements CanActivate {
  constructor(private readonly bookings: BookingsRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      params: { id?: string };
      user?: AuthenticatedUser;
      booking?: Booking;
    }>();

    const id = request.params.id;
    const user = request.user;
    if (!id || !user) {
      throw new ForbiddenError(ErrorCodes.FORBIDDEN, 'Missing booking or caller identity.');
    }

    const booking = await this.bookings.findById(id);
    if (!booking) {
      throw new NotFoundError(ErrorCodes.BOOKING_NOT_FOUND, 'No such booking.');
    }

    const permitted =
      user.role === 'admin' ||
      (user.role === 'customer' && booking.customerId === user.userId) ||
      (user.role === 'operator' && booking.operatorId === user.operatorId);

    if (!permitted) {
      throw new ForbiddenError(ErrorCodes.FORBIDDEN, 'You are not a party to this booking.');
    }

    // Cached so the handler does not re-query.
    request.booking = booking;
    return true;
  }
}
