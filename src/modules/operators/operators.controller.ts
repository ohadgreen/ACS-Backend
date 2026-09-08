import { Body, Controller, ForbiddenException, Get, Patch } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { OperatorsService } from './operators.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Roles('operator')
@Controller('operators/me')
export class OperatorsController {
  constructor(private readonly operators: OperatorsService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.operators.getOwnProfile(requireOperatorId(user));
  }

  @Patch()
  update(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.operators.updateOwnProfile(requireOperatorId(user), dto);
  }
}

/**
 * The identity comes from the token, never a path parameter, so these routes
 * have no object-level authorization surface to get wrong. A token with the
 * operator role but no operatorId claim is malformed, not merely unauthorized.
 */
export function requireOperatorId(user: AuthenticatedUser): string {
  if (!user.operatorId) throw new ForbiddenException('Token carries no operator identity.');
  return user.operatorId;
}
