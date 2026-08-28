export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    code: string,
    statusCode: number,
    isOperational: boolean = true
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }

  static validation(message: string): ValidationError {
    return new ValidationError(message);
  }

  static unauthorized(message: string): AuthenticationError {
    return new AuthenticationError(message);
  }

  static forbidden(message: string): AuthorizationError {
    return new AuthorizationError(message);
  }

  static notFound(resource: string, id: string): NotFoundError {
    return new NotFoundError(`${resource} with id '${id}' not found`);
  }

  static conflict(message: string): ConflictError {
    return new ConflictError(message);
  }

  static rateLimited(message: string = 'Rate limit exceeded'): RateLimitError {
    return new RateLimitError(message);
  }

  static internal(message: string = 'Internal server error'): InternalError {
    return new InternalError(message);
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    code: string = 'VALIDATION_ERROR',
    statusCode: number = 400
  ) {
    super(message, code, statusCode, true);
  }
}

export class AuthenticationError extends AppError {
  constructor(
    message: string,
    code: string = 'AUTHENTICATION_ERROR',
    statusCode: number = 401
  ) {
    super(message, code, statusCode, true);
  }
}

export class AuthorizationError extends AppError {
  constructor(
    message: string,
    code: string = 'AUTHORIZATION_ERROR',
    statusCode: number = 403
  ) {
    super(message, code, statusCode, true);
  }
}

export class NotFoundError extends AppError {
  constructor(
    message: string,
    code: string = 'NOT_FOUND',
    statusCode: number = 404
  ) {
    super(message, code, statusCode, true);
  }
}

export class ConflictError extends AppError {
  constructor(
    message: string,
    code: string = 'CONFLICT',
    statusCode: number = 409
  ) {
    super(message, code, statusCode, true);
  }
}

export class RateLimitError extends AppError {
  constructor(
    message: string,
    code: string = 'RATE_LIMIT_EXCEEDED',
    statusCode: number = 429
  ) {
    super(message, code, statusCode, true);
  }
}

export class InternalError extends AppError {
  constructor(
    message: string,
    code: string = 'INTERNAL_ERROR',
    statusCode: number = 500,
    isOperational: boolean = false
  ) {
    super(message, code, statusCode, isOperational);
  }
}
