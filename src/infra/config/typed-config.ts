import type { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/**
 * Note: this is a type alias, so it carries no runtime value. A constructor
 * parameter typed as AppConfig needs an explicit @Inject(ConfigService) —
 * emitDecoratorMetadata has nothing to record for an alias, and Nest would
 * see undefined.
 */
export type AppConfig = ConfigService<Env, true>;

/**
 * ConfigService.get() widens to `T | undefined` even when the schema
 * guarantees a value, which forces either a cast or a redundant fallback at
 * every call site. The env schema has already run by the time anything asks,
 * so a missing key here is a programming error, not a configuration one —
 * hence the throw rather than a default that would silently diverge from
 * env.schema.ts.
 */
export function requireEnv<K extends keyof Env>(config: AppConfig, key: K): Env[K] {
  const value = config.get(key, { infer: true }) as Env[K] | undefined;
  if (value === undefined) {
    throw new Error(`Missing validated configuration key: ${String(key)}`);
  }
  return value;
}
