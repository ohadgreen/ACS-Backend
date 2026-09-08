import { describe, expect, it } from 'vitest';
import { generateOpaqueToken, hashToken } from './opaque-token';

describe('opaque tokens', () => {
  it('generates 256 bits as url-safe base64', () => {
    expect(generateOpaqueToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generates a distinct value every call', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateOpaqueToken()));
    expect(seen.size).toBe(200);
  });

  it('hashes deterministically to 64 hex characters', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different tokens', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('never returns the token itself', () => {
    const token = generateOpaqueToken();
    expect(hashToken(token)).not.toBe(token);
  });
});
