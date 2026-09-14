import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { requireOperatorId } from '../operators/operators.controller';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PresenceService } from './presence.service';
import { CheckinDto } from './dto/checkin.dto';
import { BreakDto } from './dto/break.dto';

@ApiBearerAuth()
@Roles('operator')
@Controller('operators/me')
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Post('checkins')
  checkIn(@CurrentUser() user: AuthenticatedUser, @Body() dto: CheckinDto) {
    return this.presence.checkIn(requireOperatorId(user), dto);
  }

  // 200, not 201: ending a check-in and taking a break create nothing.
  @Post('checkins/:id/end')
  @HttpCode(200)
  end(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.presence.endCheckin(requireOperatorId(user), id);
  }

  @Post('breaks')
  @HttpCode(200)
  takeBreak(@CurrentUser() user: AuthenticatedUser, @Body() dto: BreakDto) {
    return this.presence.takeBreak(requireOperatorId(user), dto.from, dto.to);
  }

  @Get('schedule')
  schedule(@CurrentUser() user: AuthenticatedUser, @Query('date') date?: string) {
    return this.presence.schedule(requireOperatorId(user), date);
  }
}
