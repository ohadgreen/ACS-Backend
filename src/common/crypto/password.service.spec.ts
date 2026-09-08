import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service';

const svc = new PasswordService();

describe('PasswordService', () => {
  it('produces an argon2id hash', async () => {
    const hash = await svc.hash('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('verifies a correct password', async () => {
    const hash = await svc.hash('s3cret-passphrase');
    expect(await svc.verify(hash, 's3cret-passphrase')).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await svc.hash('s3cret-passphrase');
    expect(await svc.verify(hash, 'wrong')).toBe(false);
  });

  it('salts — the same input hashes differently each time', async () => {
    expect(await svc.hash('same')).not.toBe(await svc.hash('same'));
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    // A corrupt stored hash must read as "does not match", never as a crash a
    // caller might mistake for a different failure mode.
    expect(await svc.verify('not-a-hash', 'anything')).toBe(false);
  });

  it('uses the documented OWASP parameters', async () => {
    const hash = await svc.hash('parameters');
    expect(hash).toContain('m=19456');
    expect(hash).toContain('t=2');
    expect(hash).toContain('p=1');
  });
});
