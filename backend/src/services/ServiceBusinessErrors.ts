import { logger } from '../logger.js';
import type { ServiceError, ServiceResult } from '../types.js';

const log = logger.child({ service: 'ServiceBusinessExecutionService' });

const SERVICE_BUSINESS_ERRORS: ReadonlyArray<{ pattern: RegExp; error: ServiceError }> = [
  { pattern: /HXBUS4/, error: {
    code: 'IDEMPOTENCY_CONFLICT',
    message: 'That request key was already used for different details.',
  } },
  { pattern: /HXBUS2(?:\D|$)/, error: {
    code: 'BUSINESS_PERMISSION_DENIED',
    message: 'This Service Business action is not permitted.',
  } },
  { pattern: /HXSB2/, error: {
    code: 'BUSINESS_PROVIDER_VERIFICATION_REQUIRED',
    message: 'Verify and activate provider mode before receiving work.',
  } },
  { pattern: /HXSB3/, error: {
    code: 'BUSINESS_PAYOUT_ADMIN_REQUIRED',
    message: 'An active business owner or administrator must control the payout destination.',
  } },
  { pattern: /HXSB4/, error: {
    code: 'BUSINESS_PAYOUT_NOT_READY',
    message: 'Complete provider-backed payout onboarding before accepting work.',
  } },
  { pattern: /HXSB5/, error: {
    code: 'SERVICE_BUSINESS_RESPONSE_INVALID',
    message: 'That response is not supported for this opportunity.',
  } },
  { pattern: /HXSB6/, error: {
    code: 'OPPORTUNITY_NOT_AVAILABLE',
    message: 'This opportunity is no longer available to this business.',
  } },
  { pattern: /HXSB7/, error: {
    code: 'SERVICE_BUSINESS_INELIGIBLE',
    message: 'Resolve the organization, crew, credential, capacity, or payout blockers before accepting.',
  } },
  { pattern: /HXSB8/, error: {
    code: 'ASSIGNMENT_CONFLICT',
    message: 'Another eligible provider accepted this work first.',
  } },
  { pattern: /HXSB(?:9|10|11)/, error: {
    code: 'SERVICE_BUSINESS_BINDING_INVALID',
    message: 'The accepted provider assignment no longer matches the canonical task.',
  } },
  { pattern: /HXSB12/, error: {
    code: 'BUSINESS_PAYOUT_NOT_READY',
    message: 'The active service no longer has current provider-backed payout evidence.',
  } },
];

export function serviceBusinessFailure<T>(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): ServiceResult<T> {
  const message = error instanceof Error ? error.message : '';
  const mapped = SERVICE_BUSINESS_ERRORS.find(({ pattern }) => pattern.test(message))?.error;
  if (mapped) return { success: false, error: mapped };
  log.error({ err: message || 'unknown' }, fallbackMessage);
  return { success: false, error: { code: fallbackCode, message: fallbackMessage } };
}
