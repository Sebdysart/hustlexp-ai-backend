import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn((cb: (scope: { setExtra: ReturnType<typeof vi.fn> }) => void) => cb({ setExtra: vi.fn() })),
}));

describe('Sentry integration', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.SENTRY_DSN;
  });

  it('does not throw when SENTRY_DSN is missing', async () => {
    const { initSentry } = await import('../../src/lib/sentry');
    expect(() => initSentry()).not.toThrow();
  });

  it('initSentry is a no-op — initialization is handled by src/sentry.ts at module load', async () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/123';
    const Sentry = await import('@sentry/node');
    const { initSentry } = await import('../../src/lib/sentry');
    // initSentry() must not throw; actual Sentry.init is called by ../sentry.ts
    expect(() => initSentry()).not.toThrow();
    // Sentry.init is NOT called by the no-op wrapper
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('captureError calls Sentry.captureException', async () => {
    const Sentry = await import('@sentry/node');
    const { captureError } = await import('../../src/lib/sentry');
    const err = new Error('test');
    captureError(err);
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
  });

  it('captureError with context calls withScope', async () => {
    const Sentry = await import('@sentry/node');
    const { captureError } = await import('../../src/lib/sentry');
    captureError(new Error('test'), { userId: 'u123' });
    expect(Sentry.withScope).toHaveBeenCalled();
  });
});
