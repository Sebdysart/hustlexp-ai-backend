/**
 * Error Hierarchy Unit Tests
 *
 * Tests all AppError subclasses and factory methods.
 */
import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  InternalError,
} from '../../src/lib/errors';

describe('AppError base class', () => {
  it('should create error with all properties', () => {
    const error = new AppError('Test error', 'TEST_ERROR', 500, false);
    expect(error.message).toBe('Test error');
    expect(error.statusCode).toBe(500);
    expect(error.code).toBe('TEST_ERROR');
    expect(error.isOperational).toBe(false);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
  });
});

describe('Error subclasses', () => {
  const errorTypes = [
    { Class: ValidationError, status: 400, code: 'VALIDATION_ERROR', operational: true },
    { Class: AuthenticationError, status: 401, code: 'AUTHENTICATION_ERROR', operational: true },
    { Class: AuthorizationError, status: 403, code: 'AUTHORIZATION_ERROR', operational: true },
    { Class: NotFoundError, status: 404, code: 'NOT_FOUND', operational: true },
    { Class: ConflictError, status: 409, code: 'CONFLICT', operational: true },
    { Class: RateLimitError, status: 429, code: 'RATE_LIMIT_EXCEEDED', operational: true },
    { Class: InternalError, status: 500, code: 'INTERNAL_ERROR', operational: false },
  ] as const;

  for (const { Class, status, code, operational } of errorTypes) {
    describe(Class.name, () => {
      it(`should have statusCode ${status}`, () => {
        const error = new Class('test message');
        expect(error.statusCode).toBe(status);
      });

      it(`should have code "${code}"`, () => {
        const error = new Class('test message');
        expect(error.code).toBe(code);
      });

      it(`should have isOperational=${operational}`, () => {
        const error = new Class('test message');
        expect(error.isOperational).toBe(operational);
      });

      it('should set message correctly', () => {
        const error = new Class('custom message');
        expect(error.message).toBe('custom message');
      });

      it('should extend Error and AppError', () => {
        const error = new Class('test');
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(AppError);
        expect(error).toBeInstanceOf(Class);
      });
    });
  }
});

describe('Factory methods', () => {
  it('AppError.validation() returns ValidationError', () => {
    const error = AppError.validation('Invalid input');
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('Invalid input');
  });

  it('AppError.unauthorized() returns AuthenticationError', () => {
    const error = AppError.unauthorized('Bad credentials');
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.statusCode).toBe(401);
  });

  it('AppError.forbidden() returns AuthorizationError', () => {
    const error = AppError.forbidden('Forbidden');
    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error.statusCode).toBe(403);
  });

  it('AppError.notFound() returns NotFoundError', () => {
    const error = AppError.notFound('User', '123');
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.statusCode).toBe(404);
    expect(error.message).toContain('123');
  });

  it('AppError.conflict() returns ConflictError', () => {
    const error = AppError.conflict('Conflict');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.statusCode).toBe(409);
  });

  it('AppError.rateLimited() returns RateLimitError', () => {
    const error = AppError.rateLimited('Too many');
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.statusCode).toBe(429);
  });

  it('AppError.internal() returns InternalError', () => {
    const error = AppError.internal('Server error');
    expect(error).toBeInstanceOf(InternalError);
    expect(error.statusCode).toBe(500);
    expect(error.isOperational).toBe(false);
  });
});
