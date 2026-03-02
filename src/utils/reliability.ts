/**
 * Reliability utilities for the src/ AI layer.
 *
 * Provides lightweight circuit breaker instances for each AI provider so that
 * - the admin endpoint at /api/admin/health/providers can introspect state
 * - the degraded-mode guard can check whether all breakers are open
 *
 * NOTE: These are distinct from the backend/src/middleware/circuit-breaker.ts
 * breakers which wrap the backend tRPC server.  The src/ layer uses its own
 * circuit breakers around the Groq/OpenAI/DeepSeek calls in orchestrator.ts.
 */

// ---------------------------------------------------------------------------
// Minimal circuit-breaker state (no external deps so tests stay fast)
// ---------------------------------------------------------------------------

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface BreakerStats {
  state: CircuitState;
  failures: number;
  lastFailure: number | null;
}

const _breakers: Record<string, BreakerStats> = {};

/** Lazily initialise a breaker record and return it */
function getOrCreateBreaker(name: string): BreakerStats {
  if (!_breakers[name]) {
    _breakers[name] = { state: 'CLOSED', failures: 0, lastFailure: null };
  }
  return _breakers[name];
}

// How long after the last failure before a HALF_OPEN probe is allowed.
const HALF_OPEN_COOLDOWN_MS = 30_000; // 30 seconds

// Export so callers can register additional AI providers at startup:
// These are the four AI providers tracked by the circuit breakers.
// areAllCircuitsOpen() only checks these intentionally — non-AI providers
// should not contribute to the AI degraded-mode trigger.
export const AI_PROVIDERS = ['openai', 'groq', 'deepseek', 'anthropic'] as const;

// Pre-register the four AI providers the orchestrator uses
AI_PROVIDERS.forEach(p => getOrCreateBreaker(p));

// ---------------------------------------------------------------------------
// HALF_OPEN helper
// ---------------------------------------------------------------------------

/**
 * Check whether a circuit is currently open (blocking requests).
 *
 * If the circuit is OPEN and the HALF_OPEN cooldown has elapsed since the
 * last failure, the circuit transitions to HALF_OPEN so that a single probe
 * request is allowed through.  Returns false in HALF_OPEN state so that the
 * probe proceeds.
 */
function isCircuitOpen(provider: string): boolean {
  const b = _breakers[provider];
  if (!b) return false;
  if (b.state === 'OPEN') {
    // Check if cooldown has elapsed — transition to HALF_OPEN to allow probe
    if (b.lastFailure !== null && Date.now() - b.lastFailure > HALF_OPEN_COOLDOWN_MS) {
      b.state = 'HALF_OPEN';
      return false; // Allow the probe request through
    }
    return true; // Still within cooldown — circuit is open
  }
  return false; // CLOSED or HALF_OPEN → not open
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a failure for a provider.  Opens the circuit after 5 consecutive
 * failures.  Called by routedGenerate / AIClient when a provider call throws.
 */
export function recordFailure(provider: string): void {
  const b = getOrCreateBreaker(provider);
  b.failures += 1;
  b.lastFailure = Date.now();
  if (b.failures >= 5) {
    b.state = 'OPEN';
  }
}

/**
 * Record a success for a provider.  Closes the circuit (whether the call
 * was a normal call or a HALF_OPEN probe).
 */
export function recordSuccess(provider: string): void {
  const b = getOrCreateBreaker(provider);
  b.failures = 0;
  b.state = 'CLOSED'; // Close circuit on success (normal call or HALF_OPEN probe)
}

/**
 * Manually reset a circuit breaker to CLOSED.
 * Used by the admin `/api/admin/health/reset-circuit/:provider` endpoint.
 */
export function resetCircuit(provider: string): void {
  const b = getOrCreateBreaker(provider);
  b.state = 'CLOSED';
  b.failures = 0;
  b.lastFailure = null;
}

/**
 * Get per-provider health summary.
 * Returned by `/api/admin/health/providers`.
 */
export function getProviderHealth(): Record<string, { state: CircuitState; failures: number; lastFailure: string | null }> {
  const out: Record<string, { state: CircuitState; failures: number; lastFailure: string | null }> = {};
  for (const [name, stats] of Object.entries(_breakers)) {
    out[name] = {
      state: stats.state,
      failures: stats.failures,
      lastFailure: stats.lastFailure ? new Date(stats.lastFailure).toISOString() : null,
    };
  }
  return out;
}

/**
 * Get all circuit breaker states.
 * Used by health endpoints to decide whether degraded mode should kick in.
 */
export function getAllCircuitStates(): Record<string, CircuitState> {
  const out: Record<string, CircuitState> = {};
  for (const [name, stats] of Object.entries(_breakers)) {
    out[name] = stats.state;
  }
  return out;
}

/**
 * Returns true when every registered AI-provider circuit is OPEN (i.e. all
 * providers are believed to be down).
 *
 * Uses isCircuitOpen() so that HALF_OPEN probes are allowed through — a
 * provider in HALF_OPEN state is treated as "not fully open" and will not
 * contribute to triggering degraded mode.
 *
 * NOTE: Only AI_PROVIDERS are checked intentionally.  Non-AI circuit
 * breakers (e.g. Stripe, database) must not affect the AI degraded-mode
 * trigger.  Export AI_PROVIDERS above to allow callers to extend the list.
 */
export function areAllCircuitsOpen(): boolean {
  const providers = AI_PROVIDERS.filter(p => _breakers[p]);
  return providers.length > 0 && providers.every(p => isCircuitOpen(p));
}
