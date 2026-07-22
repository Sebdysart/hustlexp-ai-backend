import { db } from '../db.js';
import type { ServiceResult } from '../types.js';

export const PRIVATE_IDENTITY_POLICY_VERSION = 'hxos-private-identity-v1';

export type IdentityVerificationStatus =
  | 'UNVERIFIED'
  | 'PENDING'
  | 'PROCESSING'
  | 'REVIEW_REQUIRED'
  | 'VERIFIED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REVOKED'
  | 'UNAVAILABLE'
  | 'LEGACY_UNATTESTED';

export interface PrivateIdentityVerificationStatus {
  status: IdentityVerificationStatus;
  verified: boolean;
  environment: 'PRODUCTION' | 'CONTROLLED_TEST' | null;
  testOnly: boolean;
  policyVersion: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  providerLabel: string | null;
  canAcceptProductionWork: boolean;
  nextAction:
    | 'START_VERIFICATION'
    | 'WAIT_FOR_PROVIDER'
    | 'CONTACT_SUPPORT'
    | 'REVERIFY'
    | 'NONE';
  privacyNotice: string;
}

interface StatusRow {
  identity_verification_status: IdentityVerificationStatus;
  is_verified: boolean;
  identity_verification_environment: 'PRODUCTION' | 'CONTROLLED_TEST' | null;
  identity_verification_policy_version: string | null;
  verified_at: Date | string | null;
  identity_verification_expires_at: Date | string | null;
  provider: string | null;
  provider_environment: 'PRODUCTION' | 'CONTROLLED_TEST' | null;
  is_test: boolean | null;
  case_status: IdentityVerificationStatus | null;
  consent_revoked_at: Date | string | null;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function nextAction(status: IdentityVerificationStatus): PrivateIdentityVerificationStatus['nextAction'] {
  if (status === 'PENDING' || status === 'PROCESSING') return 'WAIT_FOR_PROVIDER';
  if (status === 'REVIEW_REQUIRED') return 'CONTACT_SUPPORT';
  if (status === 'VERIFIED') return 'NONE';
  if (status === 'EXPIRED' || status === 'REVOKED' || status === 'FAILED') return 'REVERIFY';
  return 'START_VERIFICATION';
}

function providerLabel(row: StatusRow): string | null {
  if (!row.provider) return null;
  if (row.provider_environment === 'CONTROLLED_TEST' || row.is_test) {
    return 'HustleXP controlled TEST';
  }
  return 'Private identity provider';
}

export async function getPrivateIdentityVerificationStatus(
  userId: string,
  now = new Date(),
): Promise<ServiceResult<PrivateIdentityVerificationStatus>> {
  try {
    const result = await db.query<StatusRow>(
      `SELECT user_account.identity_verification_status,
              COALESCE(user_account.is_verified,FALSE) AS is_verified,
              user_account.identity_verification_environment,
              user_account.identity_verification_policy_version,
              user_account.verified_at,
              user_account.identity_verification_expires_at,
              identity_case.provider,
              identity_case.provider_environment,
              identity_case.is_test,
              identity_case.status AS case_status,
              identity_consent.revoked_at AS consent_revoked_at
         FROM users user_account
         LEFT JOIN identity_verification_cases identity_case
           ON identity_case.id=user_account.identity_verification_case_id
          AND identity_case.user_id=user_account.id
         LEFT JOIN identity_verification_consents identity_consent
           ON identity_consent.id=identity_case.consent_id
          AND identity_consent.user_id=user_account.id
        WHERE user_account.id=$1
        LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) {
      return { success: false, error: { code: 'NOT_FOUND', message: 'Identity status not found.' } };
    }

    const expiry = iso(row.identity_verification_expires_at);
    const expired = expiry !== null && new Date(expiry).getTime() <= now.getTime();
    const consentRevoked = row.consent_revoked_at !== null;
    const attributable = row.case_status === 'VERIFIED'
      && row.identity_verification_status === 'VERIFIED'
      && row.is_verified === true
      && !expired
      && !consentRevoked;
    const effectiveStatus: IdentityVerificationStatus = consentRevoked
      ? 'REVOKED'
      : expired && row.identity_verification_status === 'VERIFIED'
        ? 'EXPIRED'
        : row.identity_verification_status;
    const environment = row.identity_verification_environment;
    const verified = attributable && environment !== null;

    return {
      success: true,
      data: {
        status: effectiveStatus,
        verified,
        environment,
        testOnly: environment === 'CONTROLLED_TEST' || row.is_test === true,
        policyVersion: row.identity_verification_policy_version,
        verifiedAt: verified ? iso(row.verified_at) : null,
        expiresAt: expiry,
        providerLabel: providerLabel(row),
        canAcceptProductionWork: verified && environment === 'PRODUCTION' && row.is_test !== true,
        nextAction: nextAction(effectiveStatus),
        privacyNotice: 'HustleXP stores provider status, policy, expiry, and tamper-evident hashes—not identity documents, selfies, or raw provider payloads.',
      },
    };
  } catch {
    return {
      success: false,
      error: { code: 'DB_ERROR', message: 'Identity verification status is temporarily unavailable.' },
    };
  }
}
