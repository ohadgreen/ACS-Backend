/**
 * Domain code throws these. Only the exception filter knows about HTTP, so
 * services never import HTTP concerns.
 *
 * `code` is the client contract. `message` is English developer-facing text for
 * logs and is never surfaced to end users. `details` carries structured
 * parameters — never prose — so clients can interpolate localized sentences.
 */
export abstract class DomainError extends Error {
  abstract readonly status: number;

  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  readonly status = 422;
}
export class UnauthorizedError extends DomainError {
  readonly status = 401;
}
export class ForbiddenError extends DomainError {
  readonly status = 403;
}
export class NotFoundError extends DomainError {
  readonly status = 404;
}
export class ConflictError extends DomainError {
  readonly status = 409;
}
export class TooManyRequestsError extends DomainError {
  readonly status = 429;
}
