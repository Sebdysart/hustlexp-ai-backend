import { describe, expect, it } from 'vitest';
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
  });

  it('normalizes client email for relationship lookup', () => {
    expect(normalizePosterEmail('  Poster@HustleXP.app ')).toBe('poster@hustlexp.app');
  });

  it('validates opaque invite tokens', () => {
    expect(isProviderOsInviteToken('a'.repeat(64))).toBe(true);
    expect(isProviderOsInviteToken('short')).toBe(false);
  });
});
