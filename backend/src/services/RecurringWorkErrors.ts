import type { ServiceResult } from '../types.js';

export function recurringInvalid(
  message: string,
  code = 'INVALID_RECURRING_TEMPLATE',
): ServiceResult<never> {
  return { success: false, error: { code, message } };
}
