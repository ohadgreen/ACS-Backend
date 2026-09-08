import { createZodValidationPipe } from 'nestjs-zod';
import { ZodError } from 'zod';
import { ValidationError } from '../errors/domain-error';
import { ErrorCodes } from '../errors/error-codes';

/**
 * nestjs-zod's default pipe raises its own ZodValidationException, which is a
 * 400 and would bypass the 422 contract. Converting to our own ValidationError
 * here keeps every failure inside the one envelope, and keeps the exception
 * filter free of any knowledge of the validation library.
 *
 * `details.issues` carries structured parameters — path plus rule — so the
 * client can build a localized sentence. A server-composed message could not
 * be translated after the fact.
 */
export const ZodValidationPipe = createZodValidationPipe({
  // nestjs-zod types this parameter as `unknown`, so narrow rather than assert:
  // anything that is not a ZodError would otherwise produce empty `issues`.
  createValidationException: (error: unknown) =>
    new ValidationError(ErrorCodes.VALIDATION_FAILED, 'Request validation failed.', {
      issues:
        error instanceof ZodError
          ? error.issues.map((issue) => ({ path: issue.path.join('.'), rule: issue.code }))
          : [],
    }),
});
