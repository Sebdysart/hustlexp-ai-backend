export const OPERATOR_STEP_UP_MAX_AGE_SECONDS = 10 * 60;

export interface IdentityAssurance {
  readonly authenticatedAtSeconds: number | null;
  readonly tokenExpiresAtSeconds: number | null;
  readonly signInProvider: string | null;
  readonly secondFactor: string | null;
  readonly mfaVerified: boolean;
}

type TokenClaims = Record<string, unknown> & {
  auth_time?: unknown;
  exp?: unknown;
  amr?: unknown;
  firebase?: unknown;
};

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function claimString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Extract only the assurance facts needed by the Operations boundary. The
 * verified token is the authority: browser fields and request headers cannot
 * assert MFA or recency.
 */
export function identityAssuranceFromVerifiedToken(
  decoded: TokenClaims,
): IdentityAssurance {
  const firebase = decoded.firebase && typeof decoded.firebase === 'object'
    ? decoded.firebase as Record<string, unknown>
    : {};
  const secondFactor = claimString(firebase.sign_in_second_factor);
  const authenticationMethods = Array.isArray(decoded.amr)
    ? decoded.amr.filter((method): method is string => typeof method === 'string')
    : [];

  return {
    authenticatedAtSeconds: finiteInteger(decoded.auth_time),
    tokenExpiresAtSeconds: finiteInteger(decoded.exp),
    signInProvider: claimString(firebase.sign_in_provider),
    secondFactor,
    mfaVerified: Boolean(secondFactor) || authenticationMethods.includes('mfa'),
  };
}

export function hasFreshOperatorStepUp(
  assurance: IdentityAssurance | null | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!assurance?.mfaVerified) return false;
  const authenticatedAt = assurance.authenticatedAtSeconds;
  const expiresAt = assurance.tokenExpiresAtSeconds;
  if (authenticatedAt === null || expiresAt === null) return false;
  if (authenticatedAt > nowSeconds + 30 || expiresAt <= nowSeconds) return false;
  return nowSeconds - authenticatedAt <= OPERATOR_STEP_UP_MAX_AGE_SECONDS;
}
