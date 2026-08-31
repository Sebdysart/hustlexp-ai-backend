/**
 * Release-authority public keys are code-owned trust anchors.
 *
 * Deliberately empty during the production hold. A release key may be enrolled
 * only by a protected, independently reviewed source change that records the
 * public key (never a private key). Runtime variables may provide signatures,
 * but cannot add or replace a trusted key.
 */
export const PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS: Readonly<Record<string, string>> =
  Object.freeze({});
