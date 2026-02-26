/**
 * Result<T, E> — Railway-Oriented Error Handling
 *
 * Services return Result instead of throwing. Errors become part of the type signature.
 * Use Result.ok() for success, Result.fail() for expected errors.
 * Unexpected errors (programmer bugs) still throw — that's intentional.
 */

// ─── Core Result type ─────────────────────────────────────────────────────

export type Ok<T>   = { readonly _tag: 'ok';   readonly value: T };
export type Fail<E> = { readonly _tag: 'fail';  readonly error: E };
export type Result<T, E> = Ok<T> | Fail<E>;

// ─── Constructors ─────────────────────────────────────────────────────────

export const Result = {
  ok:   <T>(value: T): Ok<T>     => ({ _tag: 'ok',   value }),
  fail: <E>(error: E): Fail<E>   => ({ _tag: 'fail', error }),
  isOk:   <T, E>(r: Result<T, E>): r is Ok<T>   => r._tag === 'ok',
  isFail: <T, E>(r: Result<T, E>): r is Fail<E> => r._tag === 'fail',

  /** Unwrap value or throw — use only at top-level route handlers */
  unwrap: <T, E>(r: Result<T, E>): T => {
    if (r._tag === 'ok') return r.value;
    throw new Error(`Result.unwrap called on Fail: ${JSON.stringify(r.error)}`);
  },

  /** Map over success value */
  map: <T, U, E>(r: Result<T, E>, fn: (v: T) => U): Result<U, E> =>
    r._tag === 'ok' ? Result.ok(fn(r.value)) : r,

  /** Chain Results (flatMap) */
  chain: <T, U, E>(r: Result<T, E>, fn: (v: T) => Result<U, E>): Result<U, E> =>
    r._tag === 'ok' ? fn(r.value) : r,

  /** Async chain */
  chainAsync: async <T, U, E>(
    r: Result<T, E>,
    fn: (v: T) => Promise<Result<U, E>>,
  ): Promise<Result<U, E>> =>
    r._tag === 'ok' ? fn(r.value) : Promise.resolve(r),
} as const;

// ─── AppError — typed error union ─────────────────────────────────────────

export type AppErrorCode =
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'PAYMENT_FAILED'
  | 'AI_UNAVAILABLE'
  | 'DATABASE_ERROR'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface AppError {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export const AppError = {
  notFound:       (message: string, details?: Record<string, unknown>): AppError =>
    ({ code: 'NOT_FOUND', message, details }),
  unauthorized:   (message: string): AppError =>
    ({ code: 'UNAUTHORIZED', message }),
  forbidden:      (message: string): AppError =>
    ({ code: 'FORBIDDEN', message }),
  validation:     (message: string, details?: Record<string, unknown>): AppError =>
    ({ code: 'VALIDATION_ERROR', message, details }),
  conflict:       (message: string): AppError =>
    ({ code: 'CONFLICT', message }),
  paymentFailed:  (message: string, details?: Record<string, unknown>): AppError =>
    ({ code: 'PAYMENT_FAILED', message, details }),
  aiUnavailable:  (message: string): AppError =>
    ({ code: 'AI_UNAVAILABLE', message }),
  database:       (message: string): AppError =>
    ({ code: 'DATABASE_ERROR', message }),
  rateLimited:    (message: string): AppError =>
    ({ code: 'RATE_LIMITED', message }),
  internal:       (message: string): AppError =>
    ({ code: 'INTERNAL_ERROR', message }),
} as const;

/** Convert AppError to HTTP status code */
export function appErrorToStatus(error: AppError): number {
  switch (error.code) {
    case 'NOT_FOUND':         return 404;
    case 'UNAUTHORIZED':      return 401;
    case 'FORBIDDEN':         return 403;
    case 'VALIDATION_ERROR':  return 400;
    case 'CONFLICT':          return 409;
    case 'PAYMENT_FAILED':    return 402;
    case 'AI_UNAVAILABLE':    return 503;
    case 'DATABASE_ERROR':    return 500;
    case 'RATE_LIMITED':      return 429;
    case 'INTERNAL_ERROR':    return 500;
    default: {
      // Exhaustive check — TypeScript will error here if a new AppErrorCode is added
      // without updating this switch. This prevents silent HTTP 500s.
      const _exhaustive: never = error.code;
      return 500;
    }
  }
}
