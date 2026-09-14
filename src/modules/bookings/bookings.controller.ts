import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { requireOperatorId } from '../operators/operators.controller';
import type { AuthenticatedUser } from '../auth/auth.types';
import { BookingsService } from './bookings.service';
import { BookingAccessGuard } from './booking-access.guard';
import { CreateBookingDto } from './dto/create-booking.dto';
import { CancelBookingDto } from './dto/cancel-booking.dto';

@ApiBearerAuth()
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Roles('customer')
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBookingDto) {
    return this.bookings.create(user.userId, dto);
  }

  // Scoped to the caller's own party, so there is no id to get wrong. An
  // admin is deliberately excluded: an unfiltered dump of every booking is a
  // different endpoint with different pagination needs.
  @Roles('customer', 'operator')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return user.role === 'operator'
      ? this.bookings.listForOperator(requireOperatorId(user))
      : this.bookings.listForCustomer(user.userId);
  }

  @Roles('customer', 'operator', 'admin')
  @UseGuards(BookingAccessGuard)
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.getById(id);
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
