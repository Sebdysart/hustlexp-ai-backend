import { describe, it, expect } from 'vitest';
import { Result, AppError, appErrorToStatus } from './result.js';

describe('Result<T,E>', () => {
  it('Result.ok wraps a value', () => {
    const r = Result.ok(42);
    expect(r._tag).toBe('ok');
    expect(Result.isOk(r)).toBe(true);
    expect(Result.isFail(r)).toBe(false);
  });

  it('Result.fail wraps an error', () => {
    const r = Result.fail(AppError.notFound('Task not found'));
    expect(r._tag).toBe('fail');
    expect(Result.isFail(r)).toBe(true);
  });

  it('Result.map transforms success value', () => {
    const r = Result.map(Result.ok(10), (n) => n * 2);
    expect(Result.isOk(r) && r.value).toBe(20);
  });

  it('Result.map passes through failure', () => {
    const err = AppError.internal('oops');
    const r = Result.map(Result.fail(err), (n: number) => n * 2);
    expect(Result.isFail(r) && r.error).toEqual(err);
  });

  it('Result.chain sequences operations', () => {
    const r = Result.chain(Result.ok(5), (n) => Result.ok(n + 1));
    expect(Result.isOk(r) && r.value).toBe(6);
  });

  it('Result.chain short-circuits on failure', () => {
    const err = AppError.validation('bad input');
    const r = Result.chain(Result.fail<number, AppError>(err), (n) => Result.ok(n + 1));
    expect(Result.isFail(r) && r.error.code).toBe('VALIDATION_ERROR');
  });

  it('Result.unwrap throws on Fail', () => {
    expect(() => Result.unwrap(Result.fail(AppError.internal('x')))).toThrow();
  });

  it('appErrorToStatus maps codes to HTTP status', () => {
    expect(appErrorToStatus(AppError.notFound('x'))).toBe(404);
    expect(appErrorToStatus(AppError.unauthorized('x'))).toBe(401);
    expect(appErrorToStatus(AppError.paymentFailed('x'))).toBe(402);
    expect(appErrorToStatus(AppError.rateLimited('x'))).toBe(429);
  });
});
