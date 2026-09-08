import { createHash, randomBytes } from 'node:crypto';

/**
 * 256 bits of opaque random. Refresh and setup tokens are deliberately not
 * JWTs: they must be revocable, which means the server has to hold a record.
 */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only the hash is ever persisted, so a database leak yields no usable token.
 * SHA-256 is right here — unlike a password, the input is already 256 bits of
 * uniform randomness, so there is nothing for a slow hash to protect against.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
