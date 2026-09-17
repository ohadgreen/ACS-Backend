import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpoPushProvider } from './expo-push.provider';

const provider = () => new ExpoPushProvider(undefined);
const message = (token: string) => ({ token, title: 'T', body: 'B' });

const respondWith = (body: unknown, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExpoPushProvider', () => {
  it('maps an ok ticket to success', async () => {
    respondWith({ data: [{ status: 'ok', id: '1' }] });
    expect(await provider().send([message('a')])).toEqual([{ token: 'a', ok: true }]);
  });

  // An uninstalled app is the only error worth acting on: the token is dead
  // forever, and the caller reaps it.
  it('maps DeviceNotRegistered so the caller can reap the token', async () => {
    respondWith({
      data: [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }],
    });
    expect(await provider().send([message('a')])).toEqual([
      { token: 'a', ok: false, error: 'DEVICE_NOT_REGISTERED' },
    ]);
  });

  it('maps a rate-limit ticket to TRANSIENT so the job retries', async () => {
    respondWith({
      data: [{ status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } }],
    });
    expect(await provider().send([message('a')])).toEqual([
      { token: 'a', ok: false, error: 'TRANSIENT' },
    ]);
  });

  it('maps an oversized message to INVALID, which must not be retried', async () => {
    respondWith({
      data: [{ status: 'error', message: 'too big', details: { error: 'MessageTooBig' } }],
    });
    expect(await provider().send([message('a')])).toEqual([
      { token: 'a', ok: false, error: 'INVALID' },
    ]);
  });

  // A partial failure is routine, so the batch must report per message rather
  // than throwing and losing which tokens survived.
  it('reports per message when a batch partially fails', async () => {
    respondWith({
      data: [
        { status: 'ok', id: '1' },
        { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      ],
    });
    expect(await provider().send([message('a'), message('b')])).toEqual([
      { token: 'a', ok: true },
      { token: 'b', ok: false, error: 'DEVICE_NOT_REGISTERED' },
    ]);
  });

  it('treats a non-2xx response as transient for the whole batch', async () => {
    respondWith({ errors: [{ code: 'INTERNAL_SERVER_ERROR' }] }, 500);
    expect(await provider().send([message('a')])).toEqual([
      { token: 'a', ok: false, error: 'TRANSIENT' },
    ]);
  });

  it('treats a network failure as transient rather than throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    expect(await provider().send([message('a')])).toEqual([
      { token: 'a', ok: false, error: 'TRANSIENT' },
    ]);
  });

  it('splits batches larger than Expo accepts', async () => {
    const spy = respondWith({ data: Array.from({ length: 100 }, () => ({ status: 'ok', id: '1' })) });
    const messages = Array.from({ length: 150 }, (_, i) => message(`t${i}`));
    const results = await provider().send(messages);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(150);
  });

  it('sends no request for an empty batch', async () => {
    const spy = respondWith({ data: [] });
    expect(await provider().send([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
