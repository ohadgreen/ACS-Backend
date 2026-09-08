/**
 * Drizzle wraps driver errors, so the Postgres SQLSTATE and the violated
 * constraint name live on `error.cause` rather than on the error itself — and
 * the depth is not guaranteed. Walk the chain instead of reaching for one
 * fixed level, or a drizzle upgrade silently turns every 409 into a 500.
 */
export interface PgErrorShape {
  code?: string;
  constraint?: string;
}

/** unique_violation. */
export const UNIQUE_VIOLATION = '23505';

function chain(cause: unknown): PgErrorShape[] {
  const found: PgErrorShape[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    found.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return found;
}

/**
 * `constraint` is optional but worth passing: matching the name proves WHICH
 * rule fired, so an unrelated unique index cannot be mistaken for the one the
 * caller means to translate into a domain error.
 */
export function isUniqueViolation(cause: unknown, constraint?: string): boolean {
  return chain(cause).some(
    (err) =>
      err.code === UNIQUE_VIOLATION &&
      (constraint === undefined || err.constraint === constraint),
  );
}

export function violatedConstraint(cause: unknown): string | undefined {
  return chain(cause).find((err) => err.constraint !== undefined)?.constraint;
}
