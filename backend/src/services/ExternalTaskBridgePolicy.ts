import { createHash, randomBytes } from 'node:crypto';

export const EXTERNAL_TASK_BRIDGE_POLICY_VERSION = 'hxos-external-task-bridge-v1';
export const EXTERNAL_SHARE_CHANNELS = [
  'nextdoor', 'facebook', 'whatsapp', 'email', 'text', 'copy', 'other',
] as const;
export const DIRECT_INVITE_CHANNELS = ['email', 'text', 'copy', 'other'] as const;
export const EXTERNAL_LINK_KINDS = ['OPEN_SHARE', 'DIRECT_INVITE'] as const;

export type ExternalShareChannel = (typeof EXTERNAL_SHARE_CHANNELS)[number];
export type DirectInviteChannel = (typeof DIRECT_INVITE_CHANNELS)[number];
export type ExternalLinkKind = (typeof EXTERNAL_LINK_KINDS)[number];

export interface ExternalBridgeTaskSnapshot {
  state: string;
  poster_id: string;
  title: string;
  description: string;
  category: string | null;
  scope_hash: string | null;
  hustler_payout_cents: number | null;
  estimated_duration_minutes: number | null;
  rough_location: string | null;
  deadline: string | Date | null;
  requirements: string | null;
  risk_level: string | null;
  required_tools: string[] | null;
  cancellation_policy_version: string | null;
  late_cancel_pct: number | null;
  cancellation_window_hours: number | null;
  trust_tier_required: number | null;
}

export interface ExternalBridgeUserSnapshot {
  id: string;
  trust_tier: number;
  trust_hold: boolean;
  is_verified: boolean;
  identity_verification_status: string | null;
  identity_verification_environment: string | null;
  identity_verification_expires_at: string | Date | null;
}

export interface ExternalBridgeLinkSnapshot {
  scope_hash: string;
  payout_cents: number;
  expires_at: string | Date;
  revoked_at: string | Date | null;
  link_kind: ExternalLinkKind;
  claimed_by_user_id: string | null;
}

export type ExternalBridgeBlocker =
  | 'task_unavailable'
  | 'share_expired'
  | 'share_revoked'
  | 'share_stale'
  | 'scope_not_ready'
  | 'payout_not_ready'
  | 'duration_not_ready'
  | 'area_not_ready'
  | 'cancellation_terms_not_ready'
  | 'deadline_passed'
  | 'self_dealing'
  | 'identity_verification_required'
  | 'trust_hold'
  | 'trust_tier_insufficient'
  | 'risk_not_supported'
  | 'direct_invite_claimed';

const REQUIRED_TIER_BY_RISK: Record<string, number | null> = {
  LOW: 2,
  MEDIUM: 2,
  HIGH: 3,
  IN_HOME: null,
};

export function newExternalShareToken(): string {
  return randomBytes(32).toString('hex');
}

export function validExternalShareToken(token: string): boolean {
  return /^[a-f0-9]{64}$/i.test(token);
}

export function hashExternalShareToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function externalSharePath(token: string): string {
  return `/work/${token}`;
}

function validScopeHash(value: string | null): value is string {
  return Boolean(value && /^[a-f0-9]{64}$/i.test(value));
}

function positiveInteger(value: number | null): value is number {
  return Number.isInteger(value) && (value ?? 0) > 0;
}

function dateMs(value: string | Date | null): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function externalShareReadiness(
  task: ExternalBridgeTaskSnapshot,
  now = new Date(),
): ExternalBridgeBlocker[] {
  const blockers: ExternalBridgeBlocker[] = [];
  if (task.state !== 'OPEN') blockers.push('task_unavailable');
  if (!validScopeHash(task.scope_hash)) blockers.push('scope_not_ready');
  if (!positiveInteger(task.hustler_payout_cents)) blockers.push('payout_not_ready');
  if (!positiveInteger(task.estimated_duration_minutes)) blockers.push('duration_not_ready');
  if (!task.rough_location?.trim()) blockers.push('area_not_ready');
  if (
    !task.cancellation_policy_version
    || task.late_cancel_pct === null
    || task.cancellation_window_hours === null
  ) blockers.push('cancellation_terms_not_ready');
  const deadline = dateMs(task.deadline);
  if (deadline !== null && deadline <= now.getTime()) blockers.push('deadline_passed');
  return blockers;
}

export function externalLinkBlockers(
  task: ExternalBridgeTaskSnapshot,
  link: ExternalBridgeLinkSnapshot,
  now = new Date(),
): ExternalBridgeBlocker[] {
  const blockers = externalShareReadiness(task, now);
  if (link.revoked_at) blockers.push('share_revoked');
  const expiry = dateMs(link.expires_at);
  if (expiry === null || expiry <= now.getTime()) blockers.push('share_expired');
  if (link.scope_hash !== task.scope_hash || link.payout_cents !== task.hustler_payout_cents) {
    blockers.push('share_stale');
  }
  return [...new Set(blockers)];
}

export function externalCandidateEligibility(
  task: ExternalBridgeTaskSnapshot,
  user: ExternalBridgeUserSnapshot,
  now = new Date(),
): ExternalBridgeBlocker[] {
  const blockers = externalShareReadiness(task, now);
  if (task.poster_id === user.id) blockers.push('self_dealing');
  const identityExpiry = dateMs(user.identity_verification_expires_at);
  if (
    !user.is_verified
    || user.identity_verification_status !== 'VERIFIED'
    || user.identity_verification_environment !== 'PRODUCTION'
    || identityExpiry === null
    || identityExpiry <= now.getTime()
  ) blockers.push('identity_verification_required');
  if (user.trust_hold) blockers.push('trust_hold');
  const risk = task.risk_level ?? 'LOW';
  const riskTier = REQUIRED_TIER_BY_RISK[risk];
  if (riskTier === null || riskTier === undefined) blockers.push('risk_not_supported');
  const requiredTier = Math.max(task.trust_tier_required ?? 1, riskTier ?? Number.MAX_SAFE_INTEGER);
  if (user.trust_tier < requiredTier) blockers.push('trust_tier_insufficient');
  return [...new Set(blockers)];
}

export function directInviteRecipientBlockers(
  link: Pick<ExternalBridgeLinkSnapshot, 'link_kind' | 'claimed_by_user_id'>,
  userId: string | null,
): ExternalBridgeBlocker[] {
  if (
    link.link_kind === 'DIRECT_INVITE'
    && link.claimed_by_user_id
    && link.claimed_by_user_id !== userId
  ) return ['direct_invite_claimed'];
  return [];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${stableJson(source[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function externalOfferTermsHash(input: {
  task: ExternalBridgeTaskSnapshot;
  availableFrom: string;
  availableUntil: string;
}): string {
  const payload = {
    policyVersion: EXTERNAL_TASK_BRIDGE_POLICY_VERSION,
    scopeHash: input.task.scope_hash,
    payoutCents: input.task.hustler_payout_cents,
    durationMinutes: input.task.estimated_duration_minutes,
    deadline: input.task.deadline ? new Date(input.task.deadline).toISOString() : null,
    cancellation: {
      policyVersion: input.task.cancellation_policy_version,
      lateCancelPercent: input.task.late_cancel_pct,
      windowHours: input.task.cancellation_window_hours,
    },
    availableFrom: new Date(input.availableFrom).toISOString(),
    availableUntil: new Date(input.availableUntil).toISOString(),
  };
  return createHash('sha256').update(stableJson(payload), 'utf8').digest('hex');
}

export function externalShareCopy(task: ExternalBridgeTaskSnapshot, path: string): string {
  const timing = task.deadline
    ? ` by ${new Date(task.deadline).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`
    : '';
  return `Need help with ${task.title.trim()} in ${task.rough_location!.trim()}${timing}. Scope, payout, and timing: ${path}`;
}

export function directProviderInviteCopy(task: ExternalBridgeTaskSnapshot, path: string): string {
  return `I found someone for ${task.title.trim()} in ${task.rough_location!.trim()}. Use this private HustleXP link to verify eligibility, review the exact scope and payout, and respond: ${path}`;
}
