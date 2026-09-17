import { beforeEach, describe, expect, it } from 'vitest';
import { FakePushProvider } from './fake-push.provider';

const message = (token: string) => ({ token, title: 'T', body: 'B' });

describe('FakePushProvider', () => {
  let provider: FakePushProvider;
  beforeEach(() => {
    provider = new FakePushProvider();
  });

  it('records every message and reports success', async () => {
    const results = await provider.send([message('a'), message('b')]);
    expect(provider.sent).toHaveLength(2);
    expect(results).toEqual([
      { token: 'a', ok: true },
      { token: 'b', ok: true },
    ]);
  });

  it('fails one send when armed, then recovers', async () => {
    provider.failNextWith = 'TRANSIENT';
    const first = await provider.send([message('a')]);
    expect(first[0]).toEqual({ token: 'a', ok: false, error: 'TRANSIENT' });

    const second = await provider.send([message('a')]);
    expect(second[0]).toEqual({ token: 'a', ok: true });
  });

  it('does not record messages from a failed send', async () => {
    provider.failNextWith = 'DEVICE_NOT_REGISTERED';
    await provider.send([message('a')]);
    expect(provider.sent).toEqual([]);
  });

  it('clears recorded messages on reset', async () => {
    await provider.send([message('a')]);
    provider.reset();
    expect(provider.sent).toEqual([]);
  });

  it('returns an empty result set for an empty batch', async () => {
    expect(await provider.send([])).toEqual([]);
  });
});
