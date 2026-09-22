import { z } from 'zod';

// Matches the Stage-1 policy and credential-type database constraints. Matching
// between policy, type, and submitted credential remains exact.
export const SERVICE_JURISDICTION_PATTERN = /^US-[A-Z]{2}(-[A-Z0-9_-]+)?$/;
export const serviceJurisdictionSchema = z.string().trim().regex(SERVICE_JURISDICTION_PATTERN);

export function isServiceJurisdiction(value: string | null): value is string {
  return value !== null && SERVICE_JURISDICTION_PATTERN.test(value);
}
