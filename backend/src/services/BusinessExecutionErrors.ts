import type { ServiceError } from '../types.js';

const BUSINESS_EXECUTION_ERRORS: ReadonlyArray<{
  pattern: RegExp;
  error: ServiceError;
}> = [
  {
    pattern: /HXBUS33/,
    error: {
      code: 'BUSINESS_BIND_BUDGET_EXCEEDED',
      message: 'The current monthly budget no longer has room for this work order.',
    },
  },
  {
    pattern: /HXBUS32/,
    error: {
      code: 'BUSINESS_SPEND_NOT_APPROVED',
      message: 'This spend request is not approved for work-order creation.',
    },
  },
  {
    pattern: /HXBUS(22|31|34)/,
    error: {
      code: 'BUSINESS_WORK_ORDER_SCOPE_INVALID',
      message: 'The approved request does not reconcile to this workspace and task.',
    },
  },
  {
    pattern: /HXBUS36/,
    error: {
      code: 'BUSINESS_PROVIDER_NOT_FOUND',
      message: 'No eligible HustleXP provider account matched that email.',
    },
  },
  {
    pattern: /HXBUS37/,
    error: {
      code: 'BUSINESS_INVOICE_PERIOD_INVALID',
      message: 'The billing snapshot period is invalid.',
    },
  },
  {
    pattern: /HXBUS4/,
    error: {
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'That request key was already used for different details.',
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

export function businessExecutionError(message: string): ServiceError | null {
  return BUSINESS_EXECUTION_ERRORS.find(({ pattern }) => pattern.test(message))?.error ?? null;
}
