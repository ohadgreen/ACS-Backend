import { describe, expect, it } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import { TokenService } from './token.service';

function build(secret = 'x'.repeat(32), expiresIn: StringValue = '15m') {
  return new TokenService(new JwtService({ secret, signOptions: { expiresIn } }));
}

describe('TokenService', () => {
  it('round-trips the documented claims', () => {
    const svc = build();
    const claims = svc.verifyAccessToken(
      svc.issueAccessToken({ sub: 'user-1', role: 'operator', operatorId: 'op-1', jti: 'jti-1' }),
    );
    expect(claims).toMatchObject({
      sub: 'user-1',
      role: 'operator',
      operatorId: 'op-1',
      jti: 'jti-1',
    });
  });

  it('omits operatorId for non-operator roles', () => {
    const svc = build();
    const claims = svc.verifyAccessToken(
      svc.issueAccessToken({ sub: 'u', role: 'customer', jti: 'j' }),
    );
    expect(claims.operatorId).toBeUndefined();
  });

  it('rejects a token signed with a different secret', () => {
    const token = build('y'.repeat(32)).issueAccessToken({ sub: 'u', role: 'admin', jti: 'j' });
    expect(() => build().verifyAccessToken(token)).toThrow();
  });

  it('rejects an expired token', () => {
    const svc = build('x'.repeat(32), '-1s');
    const token = svc.issueAccessToken({ sub: 'u', role: 'admin', jti: 'j' });
    expect(() => svc.verifyAccessToken(token)).toThrow();
  });

  it('rejects a structurally invalid token', () => {
    expect(() => build().verifyAccessToken('not.a.jwt')).toThrow();
  });
});
