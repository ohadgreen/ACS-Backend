import { Injectable } from '@nestjs/common';
import { Algorithm, hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/** OWASP-recommended argon2id parameters. */
const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return argonHash(plain, OPTIONS);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argonVerify(hash, plain, OPTIONS);
    } catch {
      // A malformed stored hash must read as "does not match", never as a crash
      // that a caller might mistake for a different failure mode.
      return false;
    }
  }
}
