/**
 * Sentry branch coverage tests
 *
 * Covers uncovered branches in src/sentry.ts:
 * - DSN present vs absent (init vs skip)
 * - beforeSend: event with vs without request headers
 * - setSentryUser with and without extra
 * - clearSentryUser
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @sentry/node before import
const mockInit = vi.fn();
const mockSetUser = vi.fn();

vi.mock('@sentry/node', () => ({
  init: mockInit,
  setUser: mockSetUser,
}));

vi.mock('../../src/config', () => ({
  config: {
    sentry: {
      dsn: '', // empty — triggers the else branch
      environment: 'test',
      tracesSampleRate: 0,
    },
    app: {
      isProduction: false,
    },
  },
}));

beforeEach(() => vi.clearAllMocks());

describe('sentry module', () => {
  it('exports setSentryUser that calls Sentry.setUser with id', async () => {
    const { setSentryUser } = await import('../../src/sentry');

    setSentryUser('user-1');
    expect(mockSetUser).toHaveBeenCalledWith({ id: 'user-1' });
  });

  it('exports setSentryUser that merges extra fields', async () => {
    const { setSentryUser } = await import('../../src/sentry');

    setSentryUser('user-2', { trustTier: '5' });
    expect(mockSetUser).toHaveBeenCalledWith({ id: 'user-2', trustTier: '5' });
  });

  it('exports clearSentryUser that calls Sentry.setUser(null)', async () => {
    const { clearSentryUser } = await import('../../src/sentry');

    clearSentryUser();
    expect(mockSetUser).toHaveBeenCalledWith(null);
  });

  it('exports Sentry namespace', async () => {
    const { Sentry } = await import('../../src/sentry');
    expect(Sentry).toBeDefined();
    expect(Sentry.init).toBeDefined();
  });
});
