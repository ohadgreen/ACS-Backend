import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ZodError } from 'zod';
import { DomainError } from './domain-error';
import { ErrorCodes } from './error-codes';

interface Envelope {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    requestId: string;
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    // pino-http assigns req.id; see logger.module.ts genReqId.
    const requestId = http.getRequest<{ id?: string }>().id ?? 'unknown';
    const { status, body } = this.render(exception, requestId);

    if (status >= 500) {
      this.logger.error({ requestId, err: exception }, 'unhandled exception');
    }

    http
      .getResponse<{ status(code: number): { json(b: Envelope): void } }>()
      .status(status)
      .json(body);
  }

  private render(exception: unknown, requestId: string): { status: number; body: Envelope } {
    if (exception instanceof DomainError) {
      return {
        status: exception.status,
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            details: exception.details,
            requestId,
          },
        },
      };
    }

    if (exception instanceof ZodError) {
      return {
        status: 422,
        body: {
          error: {
            code: ErrorCodes.VALIDATION_FAILED,
            message: 'Request validation failed.',
            // Structured parameters, never prose — the client localizes.
            details: {
              issues: exception.issues.map((i) => ({
                path: i.path.join('.'),
                rule: i.code,
              })),
            },
            requestId,
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        body: {
          error: {
            code: httpCodeFor(status),
            message: exception.message,
            details: {},
            requestId,
          },
        },
      };
    }

    // Nothing about an unexpected failure reaches the client; the stack goes to
    // the log under the same requestId.
    return {
      status: 500,
      body: {
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'An unexpected error occurred.',
          details: {},
          requestId,
        },
      },
    };
  }
}

/** 401 and 403 stay distinct so client error handling stays sane. */
function httpCodeFor(status: number): string {
  if (status === 401) return ErrorCodes.UNAUTHENTICATED;
  if (status === 403) return ErrorCodes.FORBIDDEN;
  if (status === 422) return ErrorCodes.VALIDATION_FAILED;
  if (status === 429) return ErrorCodes.RATE_LIMITED;
  return 'HTTP_ERROR';
}
