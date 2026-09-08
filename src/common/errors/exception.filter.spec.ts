import { describe, expect, it, vi } from 'vitest';
import { HttpException, type ArgumentsHost } from '@nestjs/common';
import { z } from 'zod';
import { AllExceptionsFilter } from './exception.filter';
import { ConflictError, NotFoundError } from './domain-error';

function hostFor(requestId = 'req-1') {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ id: requestId }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  it('maps a domain ConflictError to 409 with its code and details', () => {
    const { host, status, json } = hostFor();
    new AllExceptionsFilter().catch(
      new ConflictError('SLOT_UNAVAILABLE', 'That slot is no longer available.', {
        startAt: '2026-09-06T08:00:00Z',
      }),
      host,
    );
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'SLOT_UNAVAILABLE',
        message: 'That slot is no longer available.',
        details: { startAt: '2026-09-06T08:00:00Z' },
        requestId: 'req-1',
      },
    });
  });

  it('maps a domain NotFoundError to 404', () => {
    const { host, status } = hostFor();
    new AllExceptionsFilter().catch(
      new NotFoundError('BOOKING_NOT_FOUND', 'No such booking.'),
      host,
    );
    expect(status).toHaveBeenCalledWith(404);
  });

  it('maps a zod error to 422 with structured issues, never prose', () => {
    const { host, status, json } = hostFor();
    const parsed = z.object({ price: z.number().min(0) }).safeParse({ price: -1 });
    new AllExceptionsFilter().catch(parsed.error, host);

    expect(status).toHaveBeenCalledWith(422);
    const body = json.mock.calls[0]?.[0] as {
      error: { code: string; details: { issues: Array<{ path: string; rule: string }> } };
    };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.issues[0]?.path).toBe('price');
    // The client localizes from `rule`; a server-built sentence could not be
    // translated after the fact.
    expect(body.error.details.issues[0]?.rule).toEqual(expect.any(String));
  });

  it('preserves the status of a Nest HttpException and distinguishes 403', () => {
    const { host, status, json } = hostFor();
    new AllExceptionsFilter().catch(new HttpException('nope', 403), host);
    expect(status).toHaveBeenCalledWith(403);
    expect((json.mock.calls[0]?.[0] as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('maps a 401 HttpException to UNAUTHENTICATED, keeping it distinct from 403', () => {
    const { host, status, json } = hostFor();
    new AllExceptionsFilter().catch(new HttpException('nope', 401), host);
    expect(status).toHaveBeenCalledWith(401);
    expect((json.mock.calls[0]?.[0] as { error: { code: string } }).error.code).toBe(
      'UNAUTHENTICATED',
    );
  });

  it('never leaks internals from an unexpected error', () => {
    const { host, status, json } = hostFor();
    new AllExceptionsFilter().catch(
      new Error('connection string user=admin password=hunter2'),
      host,
    );
    expect(status).toHaveBeenCalledWith(500);
    expect((json.mock.calls[0]?.[0] as { error: { code: string } }).error.code).toBe(
      'INTERNAL_ERROR',
    );
    expect(JSON.stringify(json.mock.calls[0]?.[0])).not.toContain('hunter2');
  });

  it('always carries the request id so a support screenshot maps to a log', () => {
    const { host, json } = hostFor('01J8-abc');
    new AllExceptionsFilter().catch(new Error('boom'), host);
    expect((json.mock.calls[0]?.[0] as { error: { requestId: string } }).error.requestId).toBe(
      '01J8-abc',
    );
  });
});
