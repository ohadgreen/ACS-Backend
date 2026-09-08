import { Body, Controller, Post } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { requireOperatorId } from '../operators/operators.controller';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PresenceService } from './presence.service';
import { CheckinDto } from './dto/checkin.dto';

@Roles('operator')
@Controller('operators/me')
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Post('checkins')
  checkIn(@CurrentUser() user: AuthenticatedUser, @Body() dto: CheckinDto) {
    return this.presence.checkIn(requireOperatorId(user), dto);
  }
}
