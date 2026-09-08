import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { CancelBookingDto } from './dto/cancel-booking.dto';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Roles('customer')
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBookingDto) {
    return this.bookings.create(user.userId, dto);
  }

  // Every lifecycle route is 200: they transition an existing booking rather
  // than creating anything. The role guard narrows who may even reach the
  // state machine; the machine then decides whether the actor may do this now.
  @Roles('customer')
  @Post(':id/ack')
  @HttpCode(200)
  ack(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.act(id, 'CUSTOMER_ACK', 'customer', user);
  }

  @Roles('operator')
  @Post(':id/start')
  @HttpCode(200)
  start(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.act(id, 'START', 'operator', user);
  }

  @Roles('operator')
  @Post(':id/end')
  @HttpCode(200)
  end(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.act(id, 'END_SESSION', 'operator', user);
  }

  @Roles('customer', 'operator', 'admin')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelBookingDto,
  ) {
    // Role and ActorKind agree on every value a token can carry; 'system' is
    // the one ActorKind no request can present.
    return this.bookings.act(id, 'CANCEL', user.role, user, dto.reason);
  }

  @Roles('operator')
  @Post(':id/no-show')
  @HttpCode(200)
  noShow(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.act(id, 'MARK_NO_SHOW', 'operator', user);
  }
}
