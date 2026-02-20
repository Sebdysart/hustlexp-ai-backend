import type { ErrorHandler, Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { TRPCError } from '@trpc/server';
import * as Sentry from '@sentry/node';
import { logger } from '../../logger';
import {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
} from './index';

export function createHonoErrorHandler(): ErrorHandler {
  return (err, c) => {
    if (err instanceof AppError) {
      const { code, message, statusCode } = err;
      const logMethod = statusCode >= 500 ? 'error' : 'warn';
      logger[logMethod]({ err, statusCode }, `AppError: ${code}`);

      if (statusCode >= 500) {
        try {
          Sentry.captureException(err);
        } catch {
          // Sentry unavailable, ignore
        }
      }

      return c.json({ error: { code, message, statusCode } }, statusCode as ContentfulStatusCode);
    }

    logger.error({ err }, 'Unhandled error');
    try {
      Sentry.captureException(err);
    } catch {
      // Sentry unavailable, ignore
    }

    return c.json(
      { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal Server Error', statusCode: 500 } },
      500
    );
  };
}

export function createTRPCErrorFormatter(): (error: Error) => TRPCError {
  return (error) => {
    if (error instanceof AppError) {
      const { code, message, statusCode } = error;
      const logMethod = statusCode >= 500 ? 'error' : 'warn';
      logger[logMethod]({ err: error, statusCode }, `AppError in tRPC: ${code}`);

      if (statusCode >= 500) {
        try {
          Sentry.captureException(error);
        } catch {
          // Sentry unavailable, ignore
        }
      }

      let trpcCode: TRPCError['code'];

      if (error instanceof ValidationError) {
        trpcCode = 'BAD_REQUEST';
      } else if (error instanceof AuthenticationError) {
        trpcCode = 'UNAUTHORIZED';
      } else if (error instanceof AuthorizationError) {
        trpcCode = 'FORBIDDEN';
      } else if (error instanceof NotFoundError) {
        trpcCode = 'NOT_FOUND';
      } else if (error instanceof ConflictError) {
        trpcCode = 'CONFLICT';
      } else if (error instanceof RateLimitError) {
        trpcCode = 'TOO_MANY_REQUESTS';
      } else {
        trpcCode = 'INTERNAL_SERVER_ERROR';
      }

      return new TRPCError({ code: trpcCode, message, cause: error });
    }

    logger.error({ err: error }, 'Unhandled error in tRPC');
    try {
      Sentry.captureException(error);
    } catch {
      // Sentry unavailable, ignore
    }

    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal Server Error',
      cause: error,
    });
  };
}
