import { describe, expect, it, vi } from 'vitest';
import {
  isProviderOsEligibleDraft,
  isProviderOsInviteToken,
  normalizePosterEmail,
} from '../../src/services/ProviderOsPolicy.js';

describe('ProviderOsPolicy', () => {
  it('requires a poster identity and an unclaimed, unconverted draft', () => {
    expect(isProviderOsEligibleDraft({
      status: 'contact_captured', claimedAt: null, taskId: null, posterUserId: 'p1',
    })).toBe(true);
    expect(isProviderOsEligibleDraft({
      status: 'contact_captured', claimedAt: null, taskId: null, posterUserId: null,
    })).toBe(false);
    expect(isProviderOsEligibleDraft({
      status: 'contact_captured', claimedAt: '2026-08-31T00:00:00Z', taskId: null, posterUserId: 'p1',
    })).toBe(false);
    expect(isProviderOsEligibleDraft({
      status: 'contact_captured', claimedAt: null, taskId: 't1', posterUserId: 'p1',
    })).toBe(false);
    expect(isProviderOsEligibleDraft({
      status: 'abandoned', claimedAt: null, taskId: null, posterUserId: 'p1',
    })).toBe(false);
    expect(isProviderOsEligibleDraft({
      status: 'contact_captured', claimedAt: null, taskId: null, posterUserId: 'p1', quoteId: 'q1',
    })).toBe(false);
  });

  it('normalizes client email for relationship lookup', () => {
    expect(normalizePosterEmail('  Poster@HustleXP.app ')).toBe('poster@hustlexp.app');
  });

  it('validates opaque invite tokens', () => {
    expect(isProviderOsInviteToken('a'.repeat(64))).toBe(true);
    expect(isProviderOsInviteToken('short')).toBe(false);
  });
});

vi.mock('../../src/db.js', () => {
  const query = vi.fn();
  return { db: { query, transaction: vi.fn((fn) => fn(query)) } };
});
vi.mock('../../src/services/BusinessClaimService.js', () => ({
  createBusinessQuoteInTransaction: vi.fn(), validateBusinessQuoteContext: vi.fn(),
}));
import { assertProviderOsAccess, entitlementState } from '../../src/services/ProviderOsAccess.js';
import type { QueryFn } from '../../src/db.js';

describe('organization entitlement access', () => {
  const now = Date.parse('2026-09-18T12:00:00Z');
  it.each([
    [undefined, 'inactive'],
    [{ status: 'active', starts_at: new Date(now - 1), expires_at: null }, 'active'],
    [{ status: 'active', starts_at: new Date(now + 1), expires_at: null }, 'scheduled'],
    [{ status: 'active', starts_at: new Date(now - 1), expires_at: new Date(now) }, 'expired'],
    [{ status: 'suspended', starts_at: new Date(now - 1), expires_at: null }, 'suspended'],
    [{ status: 'revoked', starts_at: new Date(now - 1), expires_at: null }, 'revoked'],
  ] as const)('evaluates entitlement %j as %s', (row, expected) => {
    expect(entitlementState(row, now)).toBe(expected);
  });
  it('fails closed when membership in the requested org is missing, regardless of worker mode', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(assertProviderOsAccess({ actorId: 'worker', organizationId: 'other-org', operation: 'READ_WORKSPACE' }, query as QueryFn)).rejects.toThrow('membership');
    expect(query.mock.calls[0][1]).toEqual(['other-org', 'worker']);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each(['active', 'suspended', 'revoked', 'missing', 'expired'])('only permits time-valid active entitlement: %s', async (state) => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 'membership' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'org', status: 'ACTIVE', provider_enabled: true }] })
      .mockResolvedValueOnce({ rows: state === 'missing' ? [] : [{ status: state === 'expired' ? 'active' : state, starts_at: new Date(0), expires_at: state === 'expired' ? new Date(1) : null }] });
    const request = assertProviderOsAccess({ actorId: 'member', organizationId: 'org', operation: 'ASSIGN_CREW' }, query as QueryFn);
    if (state === 'active') await expect(request).resolves.toBeUndefined();
    else await expect(request).rejects.toThrow('not active');
    expect(query.mock.calls[1][1]).toEqual(['org', 'member', 'ASSIGN_CREW']);
  });
});

import { db } from '../../src/db.js';
import { acceptProviderOsInvite, previewProviderOsInvite } from '../../src/services/ProviderOsService.js';

describe('organization invitation consent and revocation', () => {
  function fixture(state = 'active', relationship = 'new', inviteExists = true) {
    vi.mocked(db.query).mockReset();
    vi.mocked(db.transaction).mockClear();
    vi.mocked(db.query).mockImplementation(async (sql) => {
      if (sql.includes('FROM provider_os_invites i')) return { rows: inviteExists ? [{
        id: 'invite', provider_organization_id: 'token-org', created_by_user_id: 'creator',
        intended_email: 'customer@example.com', expires_at: new Date(Date.now() + 100000), provider_name: 'Business',
      }] : [] } as never;
      if (sql.includes('FROM business_organizations')) return { rows: [{ id: 'token-org', status: 'ACTIVE', provider_enabled: true }] } as never;
      if (sql.includes('FROM provider_os_entitlements')) return { rows: [{ status: state, starts_at: new Date(0), expires_at: null }] } as never;
      if (sql.includes('FROM users')) return { rows: [{ id: 'customer', full_name: 'Customer', email: 'customer@example.com' }] } as never;
      if (sql.includes('INSERT INTO provider_os_relationships')) return { rows: relationship === 'new' ? [{ id: 'relationship', onboarded_at: new Date(0) }] : [] } as never;
      if (sql.includes('FROM provider_os_relationships')) return { rows: [{ id: 'relationship', onboarded_at: new Date(0), status: relationship }] } as never;
      return { rows: [] } as never;
    });
  }
  const input = { token: 'a'.repeat(64), actorId: 'customer', actorEmail: 'customer@example.com' };
  it('preview never creates a relationship', async () => {
    fixture();
    await previewProviderOsInvite(input.token);
    expect(vi.mocked(db.query).mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });
  it('acceptance binds the token org and commits relationship, accounting and audit in one transaction', async () => {
    fixture();
    const result = await acceptProviderOsInvite(input);
    expect(result.success).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const insert = vi.mocked(db.query).mock.calls.find(([sql]) => sql.includes('INSERT INTO provider_os_relationships'));
    expect(insert?.[1]).toEqual(['token-org', 'customer', 'creator']);
    expect(vi.mocked(db.query).mock.calls.some(([sql]) => sql.includes('accepted_count = accepted_count + 1'))).toBe(true);
    expect(vi.mocked(db.query).mock.calls.some(([sql]) => sql.includes('business_audit_events'))).toBe(true);
  });
  it('replayed acceptance does not increment accounting', async () => {
    fixture('active', 'active');
    expect((await acceptProviderOsInvite(input)).success).toBe(true);
    expect(vi.mocked(db.query).mock.calls.some(([sql]) => sql.includes('UPDATE provider_os_invites'))).toBe(false);
  });
  it('does not reactivate a revoked relationship', async () => {
    fixture('active', 'revoked');
    expect((await acceptProviderOsInvite(input)).success).toBe(false);
    expect(vi.mocked(db.query).mock.calls.some(([sql]) => sql.includes('UPDATE provider_os_relationships'))).toBe(false);
    expect(vi.mocked(db.query).mock.calls.some(([sql]) => sql.includes('UPDATE provider_os_invites'))).toBe(false);
  });
  it.each(['suspended', 'revoked'])('rejects preview and acceptance when entitlement is %s', async (state) => {
    fixture(state);
    await expect(previewProviderOsInvite(input.token)).rejects.toThrow();
    await expect(acceptProviderOsInvite(input)).rejects.toThrow();
    expect(vi.mocked(db.query).mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });
  it('rejects unavailable tokens and SQL excludes expired or closed invitations', async () => {
    fixture('active', 'new', false);
    await expect(acceptProviderOsInvite(input)).rejects.toThrow('unavailable');
    const sql = vi.mocked(db.query).mock.calls[0][0];
    expect(sql).toContain("i.status = 'open'");
    expect(sql).toContain('i.expires_at > NOW()');
  });
});
