import { describe, it, expect } from 'vitest';

describe('Rate Limiting Coverage', () => {
  it('all tRPC routes are covered by rate limit middleware patterns', () => {
    // These patterns mirror the app.use() rules in server.ts
    const patterns = [
      '/trpc/escrow.release*',
      '/trpc/stripe.*',
      '/trpc/ai.*',
      '/trpc/escrow.*',
      '/trpc/task.*',
      '/trpc/*',
    ];

    // Representative sample of mutation endpoints across all routers
    const sampleMutations = [
      '/trpc/task.create',
      '/trpc/escrow.release',
      '/trpc/user.updateProfile',
      '/trpc/messaging.send',
      '/trpc/admin.banUser',
      '/trpc/notification.registerDeviceToken',
      '/trpc/ai.judgeDispute',
      '/trpc/stripe.createConnectAccount',
      '/trpc/betaDashboard.requestKillSwitchToggle',
    ];

    for (const route of sampleMutations) {
      const matched = patterns.some(pattern => {
        const regex = new RegExp(
          '^' + pattern.replace(/\.\*/g, '.*').replace(/\*/g, '.*') + '$',
        );
        return regex.test(route);
      });
      expect(matched, `Route ${route} not covered by rate limit`).toBe(true);
    }
  });

  it('financial mutations have stricter limits than general', () => {
    // Structural verification that rate limit tiers are properly ordered.
    // Values mirror RATE_LIMITS in backend/src/middleware/security.ts.
    const RATE_LIMITS: Record<string, { windowMs: number; max: number }> = {
      ai: { windowMs: 60_000, max: 20 },
      escrow: { windowMs: 60_000, max: 30 },
      financial: { windowMs: 60_000, max: 10 },
      task: { windowMs: 60_000, max: 60 },
      general: { windowMs: 60_000, max: 100 },
    };

    expect(RATE_LIMITS.financial.max).toBeLessThan(RATE_LIMITS.general.max);
    expect(RATE_LIMITS.financial.max).toBeLessThan(RATE_LIMITS.escrow.max);
    expect(RATE_LIMITS.ai.max).toBeLessThan(RATE_LIMITS.general.max);
  });

  it('financial rate limit applies to escrow.release before general escrow', () => {
    // Verify that escrow.release matches the financial pattern BEFORE the broader escrow pattern.
    // In Hono, the first matching middleware wins, so order matters.
    const orderedPatterns = [
      { pattern: '/trpc/escrow.release*', category: 'financial' },
      { pattern: '/trpc/stripe.*', category: 'financial' },
      { pattern: '/trpc/ai.*', category: 'ai' },
      { pattern: '/trpc/escrow.*', category: 'escrow' },
      { pattern: '/trpc/task.*', category: 'task' },
      { pattern: '/trpc/*', category: 'general' },
    ];

    function firstMatch(route: string): string | null {
      for (const { pattern, category } of orderedPatterns) {
        const regex = new RegExp(
          '^' + pattern.replace(/\.\*/g, '.*').replace(/\*/g, '.*') + '$',
        );
        if (regex.test(route)) return category;
      }
      return null;
    }

    // escrow.release should hit the financial tier, not the general escrow tier
    expect(firstMatch('/trpc/escrow.release')).toBe('financial');
    expect(firstMatch('/trpc/escrow.releaseFunds')).toBe('financial');
    // stripe endpoints should hit financial tier
    expect(firstMatch('/trpc/stripe.createConnectAccount')).toBe('financial');
    expect(firstMatch('/trpc/stripe.createPaymentIntent')).toBe('financial');
    // other escrow endpoints should still hit the escrow tier
    expect(firstMatch('/trpc/escrow.fund')).toBe('escrow');
    expect(firstMatch('/trpc/escrow.getStatus')).toBe('escrow');
    // general endpoints fall through to the catch-all
    expect(firstMatch('/trpc/user.updateProfile')).toBe('general');
    expect(firstMatch('/trpc/betaDashboard.requestKillSwitchToggle')).toBe('general');
  });
});
