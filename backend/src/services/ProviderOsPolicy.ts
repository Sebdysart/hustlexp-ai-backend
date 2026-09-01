/** Eligible Provider OS draft statuses: real request, not yet a claimed/converted task. */
export const PROVIDER_OS_ELIGIBLE_DRAFT_STATUSES = [
  'draft',
  'anonymous_task_draft',
  'contact_captured',
  'account_claimed',
  'quote_ready',
  'quote_send_ready',
] as const;

export type ProviderOsEligibleDraftStatus = (typeof PROVIDER_OS_ELIGIBLE_DRAFT_STATUSES)[number];

export function isProviderOsEligibleDraft(input: {
  status: string | null | undefined;
  claimedAt: string | Date | null | undefined;
  taskId: string | null | undefined;
  posterUserId: string | null | undefined;
}): boolean {
  if (!input.posterUserId) return false;
  if (input.taskId) return false;
  if (input.claimedAt) return false;
  if (!input.status || input.status === 'abandoned') return false;
  return (PROVIDER_OS_ELIGIBLE_DRAFT_STATUSES as readonly string[]).includes(input.status);
}

export function normalizePosterEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Opaque invite token: 64 hex chars. Only the SHA-256 hash is stored. */
export const PROVIDER_OS_INVITE_TOKEN_RE = /^[0-9a-f]{64}$/i;

export const PROVIDER_OS_INVITE_TTL_DAYS = 30;

export function isProviderOsInviteToken(token: string): boolean {
  return PROVIDER_OS_INVITE_TOKEN_RE.test(token.trim());
}
