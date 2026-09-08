import { describe, expect, it } from 'vitest';
import { FakeSmsProvider } from './fake-sms.provider';

describe('FakeSmsProvider', () => {
  it('captures what it was asked to send', async () => {
    const sms = new FakeSmsProvider();
    await sms.send('+972501234567', 'ACS code: 048512. Valid 5 min.');
    expect(sms.sent).toEqual([
      { phone: '+972501234567', message: 'ACS code: 048512. Valid 5 min.' },
    ]);
  });

  it('extracts the code from the last message for that number', async () => {
    const sms = new FakeSmsProvider();
    await sms.send('+972501234567', 'ACS code: 048512. Valid 5 min.');
    await sms.send('+972501234567', 'ACS code: 999001. Valid 5 min.');
    expect(sms.lastCodeFor('+972501234567')).toBe('999001');
  });

  it('finds a code with leading zeros', async () => {
    const sms = new FakeSmsProvider();
    await sms.send('+972501234567', 'ACS code: 000042. Valid 5 min.');
    expect(sms.lastCodeFor('+972501234567')).toBe('000042');
  });

  it('ignores messages sent to other numbers', async () => {
    const sms = new FakeSmsProvider();
    await sms.send('+972500000001', 'ACS code: 111111. Valid 5 min.');
    await sms.send('+972500000002', 'ACS code: 222222. Valid 5 min.');
    expect(sms.lastCodeFor('+972500000001')).toBe('111111');
  });

  it('returns undefined for a number it never sent to', () => {
    expect(new FakeSmsProvider().lastCodeFor('+972509999999')).toBeUndefined();
  });

  it('can be told to fail once, so delivery errors are testable', async () => {
    const sms = new FakeSmsProvider();
    sms.failNext = true;
    await expect(sms.send('+972501234567', 'x')).rejects.toThrow();
    await expect(sms.send('+972501234567', 'x')).resolves.toBeUndefined();
  });
});
