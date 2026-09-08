import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { UnauthorizedError } from '../errors/domain-error';
import { ErrorCodes } from '../errors/error-codes';
import { TokenService } from '../../modules/auth/token.service';
import type { AuthenticatedUser } from '../../modules/auth/auth.types';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: AuthenticatedUser;
    }>();

    const header = request.headers.authorization;
    const raw =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!raw) {
      throw new UnauthorizedError(ErrorCodes.UNAUTHENTICATED, 'Missing bearer token.');
    }

    try {
      const claims = this.tokens.verifyAccessToken(raw);
      request.user = { userId: claims.sub, role: claims.role, operatorId: claims.operatorId };
    } catch {
      // Deliberately uniform: a malformed, forged, and expired token are all
      // just "not authenticated" from the client's point of view.
      throw new UnauthorizedError(ErrorCodes.UNAUTHENTICATED, 'Invalid or expired token.');
    }

    return true;
  }
}
