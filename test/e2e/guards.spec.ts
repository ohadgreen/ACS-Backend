import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { JwtAuthGuard } from '../../src/common/auth/jwt-auth.guard';
import { RolesGuard } from '../../src/common/auth/roles.guard';
import { Public } from '../../src/common/auth/public.decorator';
import { Roles } from '../../src/common/auth/roles.decorator';
import { CurrentUser } from '../../src/common/auth/current-user.decorator';
import { TokenService } from '../../src/modules/auth/token.service';
import type { AuthenticatedUser, Role } from '../../src/modules/auth/auth.types';
import { AllExceptionsFilter } from '../../src/common/errors/exception.filter';

@Controller('probe')
class ProbeController {
  @Public()
  @Get('open')
  open() {
    return { ok: true };
  }

  @Get('protected')
  protectedRoute(@CurrentUser() user: AuthenticatedUser) {
    return { userId: user.userId, role: user.role };
  }

  @Roles('admin')
  @Get('admin-only')
  adminOnly() {
    return { ok: true };
  }

  @Roles('operator')
  @Get('operator-claims')
  operatorClaims(@CurrentUser() user: AuthenticatedUser) {
    return { operatorId: user.operatorId };
  }
}

const SECRET = 'x'.repeat(32);
let app: INestApplication;
let tokens: TokenService;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    providers: [
      {
        provide: JwtService,
        useValue: new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } }),
      },
      TokenService,
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: RolesGuard },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  tokens = moduleRef.get(TokenService);
});

afterAll(async () => {
  await app.close();
});

const bearer = (role: Role, sub = 'u1', operatorId?: string) =>
  `Bearer ${tokens.issueAccessToken({ sub, role, operatorId, jti: 'j1' })}`;

describe('auth guards', () => {
  it('allows an unauthenticated request to a @Public route', async () => {
    await request(app.getHttpServer()).get('/probe/open').expect(200);
  });

  it('protects an undecorated route by default — 401 without a token', async () => {
    const res = await request(app.getHttpServer()).get('/probe/protected').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a malformed token with 401', async () => {
    await request(app.getHttpServer())
      .get('/probe/protected')
      .set('Authorization', 'Bearer garbage')
      .expect(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const foreign = new TokenService(
      new JwtService({ secret: 'y'.repeat(32), signOptions: { expiresIn: '15m' } }),
    );
    await request(app.getHttpServer())
      .get('/probe/protected')
      .set(
        'Authorization',
        `Bearer ${foreign.issueAccessToken({ sub: 'u', role: 'admin', jti: 'j' })}`,
      )
      .expect(401);
  });

  it('rejects an Authorization header without the Bearer scheme', async () => {
    await request(app.getHttpServer())
      .get('/probe/protected')
      .set('Authorization', tokens.issueAccessToken({ sub: 'u', role: 'admin', jti: 'j' }))
      .expect(401);
  });

  it('populates @CurrentUser from the token', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/protected')
      .set('Authorization', bearer('customer', 'user-42'))
      .expect(200);
    expect(res.body).toEqual({ userId: 'user-42', role: 'customer' });
  });

  it('carries operatorId through to @CurrentUser', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/operator-claims')
      .set('Authorization', bearer('operator', 'user-9', 'op-9'))
      .expect(200);
    expect(res.body).toEqual({ operatorId: 'op-9' });
  });

  it('returns 403 — not 401 — for an authenticated user with the wrong role', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/admin-only')
      .set('Authorization', bearer('customer'))
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows the correct role', async () => {
    await request(app.getHttpServer())
      .get('/probe/admin-only')
      .set('Authorization', bearer('admin'))
      .expect(200);
  });
});
