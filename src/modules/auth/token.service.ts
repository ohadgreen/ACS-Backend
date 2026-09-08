import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AccessTokenClaims } from './auth.types';

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  issueAccessToken(claims: AccessTokenClaims): string {
    return this.jwt.sign(claims);
  }

  /**
   * Throws on a bad signature or an expired token; callers map that to 401.
   * There is no blocklist by design — the 15-minute expiry is the revocation
   * window, and refresh is where current status is re-checked.
   */
  verifyAccessToken(token: string): AccessTokenClaims {
    return this.jwt.verify<AccessTokenClaims>(token);
  }
}
