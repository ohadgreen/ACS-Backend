import { SetMetadata } from '@nestjs/common';
import type { Role } from '../../modules/auth/auth.types';

export const ROLES_KEY = 'auth:roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
