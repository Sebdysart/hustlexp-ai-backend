/**
 * CircuitBreaker Unit Tests
 *
 * Tests all 3 state transitions, failure counting, timeout recovery,
 * fallback execution, reset, and CircuitOpenError properties.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../../src/middleware/circuit-breaker';

vi.mock('../../src/logger', () => ({
  logger: {
    child: vi.fn(() => ({
      warn: vi.fn(), error: vi.fn(), info: vi.fn(),
    })),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createBreaker(opts: {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenMaxRequests?: number;
  onStateChange?: (name: string, from: string, to: string) => void;
} = {}) {
  return new CircuitBreaker('test-svc', {
    failureThreshold: opts.failureThreshold ?? 3,
    resetTimeoutMs: opts.resetTimeoutMs ?? 5_000,
    halfOpenMaxRequests: opts.halfOpenMaxRequests ?? 1,
    onStateChange: opts.onStateChange,
  });
}

/** Trip the breaker by causing N failures. */
async function tripBreaker(breaker: CircuitBreaker, n = 3) {
  for (let i = 0; i < n; i++) {
    await breaker.execute(() => Promise.reject(new Error(`fail-${i}`))).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Initial state is CLOSED
  describe('initial state', () => {
    it('starts in CLOSED state with 0 failures', () => {
      const breaker = createBreaker();
      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  // 2. CLOSED: passes through successful calls
  describe('CLOSED state', () => {
    it('passes through successful calls', async () => {
      const breaker = createBreaker();
      const result = await breaker.execute(() => Promise.resolve('ok'));
      expect(result).toBe('ok');
      expect(breaker.getState()).toBe('CLOSED');
    });

    it('resets failure count on success', async () => {
      const breaker = createBreaker({ failureThreshold: 5 });
      await breaker.execute(() => Promise.reject(new Error('f'))).catch(() => {});
      await breaker.execute(() => Promise.reject(new Error('f'))).catch(() => {});
      expect(breaker.getFailureCount()).toBe(2);

      await breaker.execute(() => Promise.resolve('ok'));
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  // 3. CLOSED -> OPEN after N failures
  describe('CLOSED -> OPEN transition', () => {
    it('opens after failureThreshold consecutive failures', async () => {
      const breaker = createBreaker({ failureThreshold: 3 });
      await tripBreaker(breaker, 3);
      expect(breaker.getState()).toBe('OPEN');
      expect(breaker.getFailureCount()).toBe(3);
    });
  });

  // 4. OPEN: throws CircuitOpenError without calling fn
  describe('OPEN state', () => {
    it('throws CircuitOpenError without calling the function', async () => {
      const breaker = createBreaker();
      await tripBreaker(breaker);
      expect(breaker.getState()).toBe('OPEN');

      const fn = vi.fn(() => Promise.resolve('nope'));
      await expect(breaker.execute(fn)).rejects.toThrow(CircuitOpenError);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  // 5. OPEN -> HALF_OPEN after resetTimeoutMs
  describe('OPEN -> HALF_OPEN transition', () => {
    it('transitions to HALF_OPEN after timeout and allows call', async () => {
      const breaker = createBreaker({ resetTimeoutMs: 5_000 });
      await tripBreaker(breaker);

      vi.advanceTimersByTime(5_000);
      const result = await breaker.execute(() => Promise.resolve('recovered'));
      expect(result).toBe('recovered');
      expect(breaker.getState()).toBe('CLOSED'); // success -> CLOSED
    });

    it('still throws if timeout has not elapsed', async () => {
      const breaker = createBreaker({ resetTimeoutMs: 5_000 });
      await tripBreaker(breaker);

      vi.advanceTimersByTime(3_000);
      await expect(breaker.execute(() => Promise.resolve('nope'))).rejects.toThrow(CircuitOpenError);
      expect(breaker.getState()).toBe('OPEN');
    });
  });

  // 6. HALF_OPEN -> CLOSED on success
  describe('HALF_OPEN -> CLOSED transition', () => {
    it('closes circuit on successful call in HALF_OPEN', async () => {
      const breaker = createBreaker({ resetTimeoutMs: 5_000 });
      await tripBreaker(breaker);
      vi.advanceTimersByTime(5_000);

      await breaker.execute(() => Promise.resolve('ok'));
      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  // 7. HALF_OPEN -> OPEN on failure
  describe('HALF_OPEN -> OPEN transition', () => {
    it('reopens circuit on failure in HALF_OPEN', async () => {
      const breaker = createBreaker({ resetTimeoutMs: 5_000 });
      await tripBreaker(breaker);
      vi.advanceTimersByTime(5_000);

      await breaker.execute(() => Promise.reject(new Error('still broken'))).catch(() => {});
      expect(breaker.getState()).toBe('OPEN');
    });
  });

  // 8. HALF_OPEN max requests
  describe('HALF_OPEN max requests', () => {
    it('throws CircuitOpenError when halfOpenMaxRequests exceeded', async () => {
      const breaker = createBreaker({ resetTimeoutMs: 5_000, halfOpenMaxRequests: 1 });
      await tripBreaker(breaker);
      vi.advanceTimersByTime(5_000);

      // First call occupies the slot (never resolves)
      const firstCall = breaker.execute(() => new Promise<string>(() => {}));
      // Second call should be rejected
      await expect(breaker.execute(() => Promise.resolve('second'))).rejects.toThrow(CircuitOpenError);

      void firstCall; // cleanup
    });
  });

  // 9. executeWithFallback
  describe('executeWithFallback', () => {
    it('returns fallback when circuit is open', async () => {
      const breaker = createBreaker();
      await tripBreaker(breaker);

      const result = await breaker.executeWithFallback(
        () => Promise.resolve('nope'), 'fallback-value'
      );
      expect(result).toBe('fallback-value');
    });

    it('rethrows non-CircuitOpenError', async () => {
      const breaker = createBreaker();
      await expect(
        breaker.executeWithFallback(() => Promise.reject(new Error('real error')), 'fallback')
      ).rejects.toThrow('real error');
    });
  });

  // 10. onStateChange callback
  describe('onStateChange callback', () => {
    it('invokes callback on state transitions', async () => {
      const onStateChange = vi.fn();
      const breaker = createBreaker({ failureThreshold: 2, onStateChange });

      await breaker.execute(() => Promise.reject(new Error('f1'))).catch(() => {});
      await breaker.execute(() => Promise.reject(new Error('f2'))).catch(() => {});
      expect(onStateChange).toHaveBeenCalledWith('test-svc', 'CLOSED', 'OPEN');
    });

    it('tracks full lifecycle: CLOSED -> OPEN -> HALF_OPEN -> CLOSED', async () => {
      const onStateChange = vi.fn();
      const breaker = createBreaker({ failureThreshold: 2, resetTimeoutMs: 5_000, onStateChange });

      await breaker.execute(() => Promise.reject(new Error('f1'))).catch(() => {});
      await breaker.execute(() => Promise.reject(new Error('f2'))).catch(() => {});

      vi.advanceTimersByTime(5_000);
      await breaker.execute(() => Promise.resolve('ok'));

      expect(onStateChange).toHaveBeenCalledWith('test-svc', 'CLOSED', 'OPEN');
      expect(onStateChange).toHaveBeenCalledWith('test-svc', 'OPEN', 'HALF_OPEN');
      expect(onStateChange).toHaveBeenCalledWith('test-svc', 'HALF_OPEN', 'CLOSED');
      expect(onStateChange).toHaveBeenCalledTimes(3);
    });
  });

  // 11. reset()
  describe('reset()', () => {
    it('forces circuit to CLOSED and clears failure count', async () => {
      const breaker = createBreaker();
      await tripBreaker(breaker);
      expect(breaker.getState()).toBe('OPEN');

      breaker.reset();
      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.getFailureCount()).toBe(0);
    });

    it('allows normal operation after reset', async () => {
      const breaker = createBreaker();
      await tripBreaker(breaker);
      breaker.reset();

      const result = await breaker.execute(() => Promise.resolve('after-reset'));
      expect(result).toBe('after-reset');
    });
  });

  // 12. CircuitOpenError properties
  describe('CircuitOpenError', () => {
    it('has correct name and retryAfterMs', () => {
      const error = new CircuitOpenError('my-svc', 12345);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('CircuitOpenError');
      expect(error.retryAfterMs).toBe(12345);
      expect(error.message).toContain('my-svc');
    });

    it('carries remaining timeout when thrown from OPEN state', async () => {
      const breaker = createBreaker({ resetTimeoutMs: 5_000 });
      await tripBreaker(breaker);

      vi.advanceTimersByTime(2_000);

      try {
        await breaker.execute(() => Promise.resolve('nope'));
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CircuitOpenError);
        const coe = err as CircuitOpenError;
        expect(coe.retryAfterMs).toBeLessThanOrEqual(3_000);
        expect(coe.retryAfterMs).toBeGreaterThan(0);
      }
    });
  });
});
