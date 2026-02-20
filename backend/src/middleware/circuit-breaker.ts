/**
 * Circuit Breaker Pattern v1.0.0
 *
 * Prevents cascading failures from external service outages.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is down, requests fail immediately (no external calls)
 * - HALF_OPEN: Testing if service recovered (limited requests)
 *
 * Usage:
 *   const openaiBreaker = new CircuitBreaker('openai', { failureThreshold: 5 });
 *   const result = await openaiBreaker.execute(() => callOpenAI(prompt));
 *
 * @see ARCHITECTURE.md §2.6 (Resilience)
 */

import { logger } from '../logger';

// ============================================================================
// TYPES
// ============================================================================

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreakerOptions {
  /** Number of failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Time to wait before trying again (ms, default: 30_000 = 30s) */
  resetTimeoutMs?: number;
  /** Max requests allowed in HALF_OPEN state (default: 1) */
  halfOpenMaxRequests?: number;
  /** Optional callback when state changes */
  onStateChange?: (name: string, from: CircuitState, to: CircuitState) => void;
}

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenRequests = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxRequests: number;
  private readonly onStateChange?: (name: string, from: CircuitState, to: CircuitState) => void;
  private readonly log;

  constructor(
    private readonly name: string,
    options: CircuitBreakerOptions = {}
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.halfOpenMaxRequests = options.halfOpenMaxRequests ?? 1;
    this.onStateChange = options.onStateChange;
    this.log = logger.child({ module: `circuit-breaker:${name}` });
  }

  /**
   * Execute a function through the circuit breaker.
   * Throws CircuitOpenError if the circuit is open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we should transition from OPEN to HALF_OPEN
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.resetTimeoutMs) {
        this.transition('HALF_OPEN');
      } else {
        throw new CircuitOpenError(this.name, this.resetTimeoutMs - elapsed);
      }
    }

    // In HALF_OPEN, limit concurrent requests
    if (this.state === 'HALF_OPEN' && this.halfOpenRequests >= this.halfOpenMaxRequests) {
      throw new CircuitOpenError(this.name, this.resetTimeoutMs);
    }

    try {
      if (this.state === 'HALF_OPEN') {
        this.halfOpenRequests++;
      }

      const result = await fn();

      // Success — reset counters
      this.onSuccess();
      return result;
    } catch (error) {
      // Failure — increment counters
      this.onFailure();
      throw error;
    }
  }

  /**
   * Execute with a fallback value when circuit is open.
   * Returns the fallback instead of throwing.
   */
  async executeWithFallback<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await this.execute(fn);
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        this.log.warn({ service: this.name }, `Circuit open, using fallback`);
        return fallback;
      }
      throw error;
    }
  }

  /** Current circuit state */
  getState(): CircuitState {
    return this.state;
  }

  /** Current failure count */
  getFailureCount(): number {
    return this.failureCount;
  }

  /** Manually reset the circuit to CLOSED */
  reset(): void {
    this.transition('CLOSED');
    this.failureCount = 0;
    this.halfOpenRequests = 0;
  }

  // ---------- Internal ----------

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.log.info({ service: this.name }, 'Service recovered, closing circuit');
      this.transition('CLOSED');
    }
    this.failureCount = 0;
    this.halfOpenRequests = 0;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.log.warn({ service: this.name }, 'Service still failing, reopening circuit');
      this.transition('OPEN');
      this.halfOpenRequests = 0;
    } else if (this.failureCount >= this.failureThreshold) {
      this.log.error(
        { service: this.name, failures: this.failureCount },
        `Circuit opened after ${this.failureCount} failures`
      );
      this.transition('OPEN');
    }
  }

  private transition(to: CircuitState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.onStateChange?.(this.name, from, to);
    this.log.info({ from, to }, `Circuit state: ${from} → ${to}`);
  }
}

// ============================================================================
// ERROR
// ============================================================================

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;

  constructor(serviceName: string, retryAfterMs: number) {
    super(`Circuit breaker open for ${serviceName}. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

// ============================================================================
// PRE-BUILT BREAKERS FOR EXTERNAL SERVICES
// ============================================================================

/** OpenAI / GPT-4o breaker — 5 failures = 30s cooldown */
export const openaiBreaker = new CircuitBreaker('openai', {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
});

/** Anthropic / Claude breaker — 5 failures = 30s cooldown */
export const anthropicBreaker = new CircuitBreaker('anthropic', {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
});

/** Groq / LLaMA breaker — 3 failures = 15s cooldown (faster recovery) */
export const groqBreaker = new CircuitBreaker('groq', {
  failureThreshold: 3,
  resetTimeoutMs: 15_000,
});

/** DeepSeek breaker — 5 failures = 60s cooldown (slower API) */
export const deepseekBreaker = new CircuitBreaker('deepseek', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
});

/** Google Cloud Vision breaker */
export const gcpVisionBreaker = new CircuitBreaker('gcp-vision', {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
});

/** AWS Rekognition breaker */
export const awsRekognitionBreaker = new CircuitBreaker('aws-rekognition', {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
});

/** Stripe breaker — 3 failures = 10s cooldown (critical path) */
export const stripeBreaker = new CircuitBreaker('stripe', {
  failureThreshold: 3,
  resetTimeoutMs: 10_000,
});

/** SendGrid breaker — 5 failures = 60s cooldown */
export const sendgridBreaker = new CircuitBreaker('sendgrid', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
});

/** Twilio breaker — 5 failures = 30s cooldown */
export const twilioBreaker = new CircuitBreaker('twilio', {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
});
