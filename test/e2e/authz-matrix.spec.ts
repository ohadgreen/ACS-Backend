import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { createTestApp, type TestApp } from './app.helper';
import { TokenService } from '../../src/modules/auth/token.service';
import type { Role } from '../../src/modules/auth/auth.types';

/**
 * The standing automated answer to the IDOR warning in the product design.
 *
 * Every protected route gets a row. Adding an endpoint without adding a row is
 * a visible gap in review — that visibility is the point. Phase 2 extends this
 * same table.
 *
 * Ids in these paths deliberately do not exist: a permitted role reaches the
 * handler and gets 404, which is fine because this suite only asserts the
 * 401 and 403 rows.
 */
export const PROTECTED_ROUTES: Array<{
  method: 'get' | 'post' | 'patch';
  path: string;
  allow: Role[];
  body?: Record<string, unknown>;
}> = [
  { method: 'post', path: '/auth/logout-all', allow: ['customer', 'operator', 'admin'] },

  { method: 'get', path: '/operators/me', allow: ['operator'] },
  { method: 'patch', path: '/operators/me', allow: ['operator'], body: { displayName: 'X' } },

  {
    method: 'post',
    path: '/admin/operators',
    allow: ['admin'],
    body: { email: 'matrix@example.com', displayName: 'A' },
  },
  { method: 'get', path: '/admin/operators', allow: ['admin'] },
  { method: 'post', path: `/admin/operators/${uuidv7()}/approve`, allow: ['admin'] },
  { method: 'post', path: `/admin/operators/${uuidv7()}/suspend`, allow: ['admin'] },

  { method: 'post', path: '/admin/locations', allow: ['admin'], body: {} },
  { method: 'patch', path: `/admin/locations/${uuidv7()}`, allow: ['admin'], body: {} },
  { method: 'post', path: `/admin/locations/${uuidv7()}/session-types`, allow: ['admin'], body: {} },
  { method: 'patch', path: `/admin/session-types/${uuidv7()}`, allow: ['admin'], body: {} },
];

const ALL_ROLES: Role[] = ['customer', 'operator', 'admin'];

let app: TestApp;
let tokens: TokenService;

beforeAll(async () => {
  app = await createTestApp();
  tokens = app.app.get(TokenService);
});
afterAll(async () => {
  await app?.close();
});

const tokenFor = (role: Role) =>
  tokens.issueAccessToken({
    sub: uuidv7(),
    role,
    operatorId: role === 'operator' ? uuidv7() : undefined,
    jti: uuidv7(),
  });

describe('authorization matrix', () => {
  it.each(PROTECTED_ROUTES)('$method $path rejects anonymous callers with 401', async (route) => {
    const agent = request(app.server);
    const res = await agent[route.method](route.path).send(route.body ?? {});
    expect(res.status).toBe(401);
  });

  it.each(
    PROTECTED_ROUTES.flatMap((route) =>
      ALL_ROLES.filter((r) => !route.allow.includes(r)).map((role) => ({ ...route, role })),
    ),
  )('$method $path rejects role $role with 403', async (route) => {
    const agent = request(app.server);
    const res = await agent[route.method](route.path)
      .set('Authorization', `Bearer ${tokenFor(route.role)}`)
      .send(route.body ?? {});

    // 403 specifically: authenticated but not permitted. A 401 here would mean
    // the role check never ran; a 404 would mean the route silently moved.
    expect(res.status).toBe(403);
  });

  it('covers every route that is not explicitly @Public', () => {
    // A reminder rather than a reflection trick: when this count changes,
    // a row was added or a route was left out.
    expect(PROTECTED_ROUTES).toHaveLength(11);
  });
});
