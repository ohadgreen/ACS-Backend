import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { ForbiddenError } from '../errors/domain-error';
import { ErrorCodes } from '../errors/error-codes';
import type { AuthenticatedUser, Role } from '../../modules/auth/auth.types';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>().user;
    // Authenticated but wrong role is 403, never 401 — the distinction keeps
    // client error handling sane.
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenError(ErrorCodes.FORBIDDEN, 'Insufficient role for this endpoint.');
    }
    return true;
  }
}
