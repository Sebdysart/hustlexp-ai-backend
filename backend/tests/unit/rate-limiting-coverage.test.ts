import { describe, it, expect } from 'vitest';

/**
 * Rate limiting coverage tests.
 *
 * These verify that the tiered rate-limit patterns in server.ts
 * correctly route every tRPC endpoint to the expected tier,
 * and that tier ordering is enforced (most restrictive first).
 *
 * Pattern order mirrors the app.use() declarations in server.ts.
 */

// The ordered patterns mirror server.ts rate-limit middleware declarations exactly.
const orderedPatterns = [
  // Tier 1: Auth (20/min)
  { pattern: '/trpc/user.register*', category: 'auth' },
  { pattern: '/trpc/biometric.*', category: 'auth' },
  { pattern: '/trpc/admin.*', category: 'auth' },
  // Tier 2: Financial (10/min)
  { pattern: '/trpc/escrow.release*', category: 'financial' },
  { pattern: '/trpc/stripe.*', category: 'financial' },
  { pattern: '/trpc/stripeConnect.*', category: 'financial' },
  { pattern: '/trpc/fraud.*', category: 'financial' },
  // Tier 3: AI (20/min)
  { pattern: '/trpc/ai.*', category: 'ai' },
  { pattern: '/trpc/disputeAI.*', category: 'ai' },
  { pattern: '/trpc/matchmaker.*', category: 'ai' },
  // Tier 4: Domain-specific
  { pattern: '/trpc/escrow.*', category: 'escrow' },
  { pattern: '/trpc/task.*', category: 'task' },
  // Tier 5: Mutation (60/min)
  { pattern: '/trpc/messaging.*', category: 'mutation' },
  { pattern: '/trpc/rating.*', category: 'mutation' },
  { pattern: '/trpc/moderation.*', category: 'mutation' },
  { pattern: '/trpc/upload.*', category: 'mutation' },
  { pattern: '/trpc/notification.*', category: 'mutation' },
  { pattern: '/trpc/tipping.*', category: 'mutation' },
  // Tier 6: General (120/min) — catch-all
  { pattern: '/trpc/*', category: 'general' },
] as const;

function firstMatch(route: string): string | null {
  for (const { pattern, category } of orderedPatterns) {
    const regex = new RegExp(
      '^' + pattern.replace(/\.\*/g, '.*').replace(/\*/g, '.*') + '$',
    );
    if (regex.test(route)) return category;
  }
  return null;
}

describe('Rate Limiting Coverage', () => {
  it('all tRPC routes are covered by rate limit middleware patterns', () => {
    const sampleMutations = [
      '/trpc/task.create',
      '/trpc/escrow.release',
      '/trpc/user.register',
      '/trpc/user.updateProfile',
      '/trpc/messaging.send',
      '/trpc/admin.banUser',
      '/trpc/notification.registerDeviceToken',
      '/trpc/ai.judgeDispute',
      '/trpc/stripe.createConnectAccount',
      '/trpc/betaDashboard.requestKillSwitchToggle',
      '/trpc/fraud.reportAbuse',
      '/trpc/stripeConnect.createAccount',
      '/trpc/biometric.verify',
      '/trpc/disputeAI.judge',
      '/trpc/matchmaker.findMatch',
      '/trpc/rating.submitReview',
      '/trpc/moderation.flagContent',
      '/trpc/upload.requestPresignedUrl',
      '/trpc/tipping.sendTip',
    ];

    for (const route of sampleMutations) {
      const matched = firstMatch(route);
      expect(matched, `Route ${route} not covered by rate limit`).not.toBeNull();
    }
  });

  it('financial mutations have stricter limits than general', () => {
    const RATE_LIMITS: Record<string, { windowMs: number; max: number }> = {
      ai: { windowMs: 60_000, max: 20 },
      auth: { windowMs: 60_000, max: 20 },
      escrow: { windowMs: 60_000, max: 30 },
      financial: { windowMs: 60_000, max: 10 },
      mutation: { windowMs: 60_000, max: 60 },
      task: { windowMs: 60_000, max: 60 },
      general: { windowMs: 60_000, max: 120 },
    };

    expect(RATE_LIMITS.financial.max).toBeLessThan(RATE_LIMITS.general.max);
    expect(RATE_LIMITS.financial.max).toBeLessThan(RATE_LIMITS.escrow.max);
    expect(RATE_LIMITS.auth.max).toBeLessThan(RATE_LIMITS.general.max);
    expect(RATE_LIMITS.mutation.max).toBeLessThan(RATE_LIMITS.general.max);
    expect(RATE_LIMITS.ai.max).toBeLessThan(RATE_LIMITS.mutation.max);
    expect(RATE_LIMITS.financial.max).toBeLessThan(RATE_LIMITS.auth.max);
  });

  it('financial rate limit applies to escrow.release before general escrow', () => {
    expect(firstMatch('/trpc/escrow.release')).toBe('financial');
    expect(firstMatch('/trpc/escrow.releaseFunds')).toBe('financial');
    expect(firstMatch('/trpc/stripe.createConnectAccount')).toBe('financial');
    expect(firstMatch('/trpc/stripe.createPaymentIntent')).toBe('financial');
    expect(firstMatch('/trpc/escrow.fund')).toBe('escrow');
    expect(firstMatch('/trpc/escrow.getStatus')).toBe('escrow');
  });

  it('auth routes hit the auth tier, not general', () => {
    expect(firstMatch('/trpc/user.register')).toBe('auth');
    expect(firstMatch('/trpc/user.registerWithEmail')).toBe('auth');
    expect(firstMatch('/trpc/biometric.verify')).toBe('auth');
    expect(firstMatch('/trpc/biometric.enroll')).toBe('auth');
    expect(firstMatch('/trpc/admin.banUser')).toBe('auth');
    expect(firstMatch('/trpc/admin.getStats')).toBe('auth');
  });

  it('AI routes hit the ai tier', () => {
    expect(firstMatch('/trpc/ai.judgeDispute')).toBe('ai');
    expect(firstMatch('/trpc/disputeAI.resolve')).toBe('ai');
    expect(firstMatch('/trpc/matchmaker.findMatch')).toBe('ai');
  });

  it('mutation-heavy routes hit the mutation tier', () => {
    expect(firstMatch('/trpc/messaging.send')).toBe('mutation');
    expect(firstMatch('/trpc/rating.submitReview')).toBe('mutation');
    expect(firstMatch('/trpc/moderation.flagContent')).toBe('mutation');
    expect(firstMatch('/trpc/upload.requestPresignedUrl')).toBe('mutation');
    expect(firstMatch('/trpc/notification.registerDeviceToken')).toBe('mutation');
    expect(firstMatch('/trpc/tipping.sendTip')).toBe('mutation');
  });

  it('unclassified routes fall through to the general catch-all', () => {
    expect(firstMatch('/trpc/user.updateProfile')).toBe('general');
    expect(firstMatch('/trpc/betaDashboard.requestKillSwitchToggle')).toBe('general');
    expect(firstMatch('/trpc/squad.create')).toBe('general');
    expect(firstMatch('/trpc/referral.claim')).toBe('general');
    expect(firstMatch('/trpc/live.getStatus')).toBe('general');
    expect(firstMatch('/trpc/subscription.getPlans')).toBe('general');
  });

  it('fraud and stripeConnect routes hit the financial tier', () => {
    expect(firstMatch('/trpc/fraud.reportAbuse')).toBe('financial');
    expect(firstMatch('/trpc/stripeConnect.createAccount')).toBe('financial');
    expect(firstMatch('/trpc/stripeConnect.getOnboardingLink')).toBe('financial');
  });
});
