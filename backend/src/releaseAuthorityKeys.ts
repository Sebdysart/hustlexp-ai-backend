/**
 * Release-authority public keys are code-owned trust anchors.
 *
 * A release key is enrolled only through a protected, independently reviewed
 * source change that records the public key (never a private key). Runtime
 * variables may provide signatures, but cannot add or replace a trusted key.
 *
 * Enrollment authenticates exact nonproduction release manifests only. It does
 * not enable production deployment, customer-money creation, hard assignment,
 * settlement, or payout; those capabilities remain independently frozen.
 */
export const PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS: Readonly<Record<string, string>> =
  Object.freeze({
    'hustlexp-release-2026-v1': [
      '-----BEGIN PUBLIC KEY-----',
      'MCowBQYDK2VwAyEAnI57Xv7M8QqfQM6VeJTcR3xx3Ux9oRjAhE0JocxlEGQ=',
      '-----END PUBLIC KEY-----',
      '',
    ].join('\n'),
  });
