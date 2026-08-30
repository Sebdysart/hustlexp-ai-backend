/**
 * Central release authority for external generative-AI provider I/O.
 *
 * Universal V1 has no approved provider provenance or reconciliation lane.
 * This production module is intentionally incapable of granting provider I/O.
 * Transport tests must replace this entire module with an isolated Vitest
 * module mock; no API key or environment value can enable it.
 */

export const EXTERNAL_AI_PROVIDER_POLICY_VERSION = 'external-ai-dormant-v1' as const;
export const EXTERNAL_AI_DORMANT_CODE = 'EXTERNAL_AI_DURABLE_SPEND_AUTHORITY_REQUIRED' as const;

export class ExternalAIProviderDormantError extends Error {
  readonly code = EXTERNAL_AI_DORMANT_CODE;
  readonly policyVersion = EXTERNAL_AI_PROVIDER_POLICY_VERSION;

  constructor(surface: string) {
    super(`${EXTERNAL_AI_DORMANT_CODE}:${surface}`);
    this.name = 'ExternalAIProviderDormantError';
  }
}

/** Hard-coded false by release policy. Deliberately ignores all configuration. */
export function isExternalAIProviderConfigured(): boolean {
  return false;
}

/** Always throws in built runtime code. Tests may only replace this module. */
export function assertExternalAIProviderIOAuthorized(surface: string): void {
  throw new ExternalAIProviderDormantError(surface);
}
