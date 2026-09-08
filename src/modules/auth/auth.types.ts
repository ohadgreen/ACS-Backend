export type Role = 'customer' | 'operator' | 'admin';

export interface AccessTokenClaims {
  sub: string;
  role: Role;
  operatorId?: string;
  jti: string;
}

/** Attached to the request by JwtAuthGuard and read by @CurrentUser. */
export interface AuthenticatedUser {
  userId: string;
  role: Role;
  operatorId?: string;
}
