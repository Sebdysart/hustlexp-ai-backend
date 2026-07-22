import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_TASK_BRIDGE_POLICY_VERSION,
  directInviteRecipientBlockers,
  directProviderInviteCopy,
  externalCandidateEligibility,
  externalLinkBlockers,
  externalOfferTermsHash,
  externalShareCopy,
  externalShareReadiness,
  hashExternalShareToken,
  newExternalShareToken,
  validExternalShareToken,
  type ExternalBridgeTaskSnapshot,
} from '../../src/services/ExternalTaskBridgePolicy.js';

const task: ExternalBridgeTaskSnapshot = {
  state: 'OPEN',
  poster_id: '11111111-1111-4111-8111-111111111111',
  title: 'Move a couch',
  description: 'Move one couch down one flight of stairs.',
  category: 'moving',
  scope_hash: 'a'.repeat(64),
  hustler_payout_cents: 8000,
  estimated_duration_minutes: 90,
  rough_location: 'Bellevue area',
  deadline: '2099-07-20T20:00:00.000Z',
  requirements: 'Bring a hand truck',
  risk_level: 'MEDIUM',
  required_tools: ['hand truck'],
  cancellation_policy_version: 'cancel-v1',
  late_cancel_pct: 25,
  cancellation_window_hours: 24,
  trust_tier_required: 2,
};

describe('external task bridge policy', () => {
  it('creates 256-bit raw capabilities and stores only a distinct SHA-256 hash', () => {
    const token = newExternalShareToken();
    expect(validExternalShareToken(token)).toBe(true);
    expect(token).toHaveLength(64);
    expect(hashExternalShareToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashExternalShareToken(token)).not.toBe(token);
  });

  it('fails share creation closed until every public decision field is complete', () => {
    expect(externalShareReadiness(task)).toEqual([]);
    expect(externalShareReadiness({
      ...task,
      scope_hash: null,
      hustler_payout_cents: null,
      estimated_duration_minutes: null,
      rough_location: null,
      cancellation_policy_version: null,
    })).toEqual(expect.arrayContaining([
      'scope_not_ready', 'payout_not_ready', 'duration_not_ready',
      'area_not_ready', 'cancellation_terms_not_ready',
    ]));
  });

  it('invalidates expired, revoked, scope-stale, and payout-stale capabilities', () => {
    const live = { scope_hash: 'a'.repeat(64), payout_cents: 8000, expires_at: '2099-07-20T20:00:00.000Z', revoked_at: null, link_kind: 'OPEN_SHARE' as const, claimed_by_user_id: null };
    expect(externalLinkBlockers(task, live)).toEqual([]);
    expect(externalLinkBlockers(task, { ...live, revoked_at: '2099-01-01T00:00:00.000Z' })).toContain('share_revoked');
    expect(externalLinkBlockers(task, { ...live, expires_at: '2020-01-01T00:00:00.000Z' })).toContain('share_expired');
    expect(externalLinkBlockers(task, { ...live, scope_hash: 'b'.repeat(64) })).toContain('share_stale');
    expect(externalLinkBlockers(task, { ...live, payout_cents: 7999 })).toContain('share_stale');
  });

  it('requires current identity, trust, and supported risk without allowing self-dealing', () => {
    const eligible = {
      id: '22222222-2222-4222-8222-222222222222', trust_tier: 2, trust_hold: false,
      is_verified: true, identity_verification_status: 'VERIFIED',
      identity_verification_environment: 'PRODUCTION',
      identity_verification_expires_at: '2099-01-01T00:00:00.000Z',
    };
    expect(externalCandidateEligibility(task, eligible)).toEqual([]);
    expect(externalCandidateEligibility(task, { ...eligible, is_verified: false })).toContain('identity_verification_required');
    expect(externalCandidateEligibility(task, { ...eligible, trust_hold: true })).toContain('trust_hold');
    expect(externalCandidateEligibility(task, { ...eligible, trust_tier: 1 })).toContain('trust_tier_insufficient');
    expect(externalCandidateEligibility(task, { ...eligible, id: task.poster_id })).toContain('self_dealing');
    expect(externalCandidateEligibility({ ...task, risk_level: 'IN_HOME' }, { ...eligible, trust_tier: 4 })).toContain('risk_not_supported');
  });

  it('binds availability, scope, payout, deadline, and cancellation terms into the offer hash', () => {
    const base = { task, availableFrom: '2099-07-20T17:00:00.000Z', availableUntil: '2099-07-20T19:00:00.000Z' };
    const hash = externalOfferTermsHash(base);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(externalOfferTermsHash(base)).toBe(hash);
    expect(externalOfferTermsHash({ ...base, task: { ...task, hustler_payout_cents: 8001 } })).not.toBe(hash);
    expect(externalOfferTermsHash({ ...base, availableUntil: '2099-07-20T19:30:00.000Z' })).not.toBe(hash);
    expect(EXTERNAL_TASK_BRIDGE_POLICY_VERSION).toBe('hxos-external-task-bridge-v1');
  });

  it('allows one verified direct-invite claimant without reopening the capability to others', () => {
    const link = { link_kind: 'DIRECT_INVITE' as const, claimed_by_user_id: 'worker-1' };
    expect(directInviteRecipientBlockers(link, 'worker-1')).toEqual([]);
    expect(directInviteRecipientBlockers(link, 'worker-2')).toEqual(['direct_invite_claimed']);
    expect(directInviteRecipientBlockers({ ...link, claimed_by_user_id: null }, 'worker-2')).toEqual([]);
  });

  it('builds share copy from rough area and never from an exact address', () => {
    const copy = externalShareCopy(task, '/work/token');
    expect(copy).toContain('Bellevue area');
    expect(copy).toContain('Scope, payout, and timing');
    expect(copy).not.toMatch(/street|address/i);
    const invite = directProviderInviteCopy(task, '/work/token');
    expect(invite).toContain('private HustleXP link');
    expect(invite).toContain('verify eligibility');
    expect(invite).not.toMatch(/street|address/i);
  });
});
