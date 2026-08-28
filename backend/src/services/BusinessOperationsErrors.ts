import { logger } from '../logger.js';
import type { ServiceError, ServiceResult } from '../types.js';

const log = logger.child({ service: 'BusinessOperationsService' });

const BUSINESS_OPERATIONS_ERRORS: ReadonlyArray<{
  pattern: RegExp;
  error: ServiceError;
}> = [
  {
    pattern: /HXBUS4/,
    error: {
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'That request key was already used for different details.',
    },
  },
  {
    pattern: /HXBUS21/,
    error: {
      code: 'BUSINESS_CLIENT_MODE_REQUIRED',
      message: 'Client mode must be active for this workspace.',
    },
  },
  {
    pattern: /HXBUS(22|28|29|30)/,
    error: {
      code: 'BUSINESS_SCOPE_INVALID',
      message: 'That record does not belong to this workspace.',
    },
  },
  {
    pattern: /HXBUS25/,
    error: {
      code: 'BUSINESS_APPROVAL_NOT_PENDING',
      message: 'This request is no longer awaiting approval.',
    },
  },
  {
    pattern: /HXBUS26/,
    error: {
      code: 'BUSINESS_SELF_APPROVAL_DENIED',
      message: 'A requester cannot approve their own spend.',
    },
  },
  {
    pattern: /HXBUS27/,
    error: {
      code: 'BUSINESS_SERVICE_NOT_FOUND',
      message: 'That business service was not found.',
    },
  },
  {
    pattern: /HXBUS2(?:\D|$)/,
    error: {
      code: 'BUSINESS_PERMISSION_DENIED',
      message: 'This business action is not permitted.',
    },
  },
];

export function operationFailure(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): ServiceResult<never> {
  const message = error instanceof Error ? error.message : '';
  const mappedError = BUSINESS_OPERATIONS_ERRORS
    .find(({ pattern }) => pattern.test(message))?.error;
  if (mappedError) return { success: false, error: mappedError };
  log.error({ err: message || 'unknown' }, fallbackMessage);
  return { success: false, error: { code: fallbackCode, message: fallbackMessage } };
}
