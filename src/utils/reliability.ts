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
function getBreaker(name: string): BreakerStats {
  if (!_breakers[name]) {
    _breakers[name] = { state: 'CLOSED', failures: 0, lastFailure: null };
  }
  return _breakers[name];
}

// Pre-register the four AI providers the orchestrator uses
const AI_PROVIDERS = ['openai', 'groq', 'deepseek', 'anthropic'] as const;
AI_PROVIDERS.forEach(p => getBreaker(p));

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a failure for a provider.  Opens the circuit after 5 consecutive
 * failures.  Called by routedGenerate / AIClient when a provider call throws.
 */
export function recordFailure(provider: string): void {
  const b = getBreaker(provider);
  b.failures += 1;
  b.lastFailure = Date.now();
  if (b.failures >= 5) {
    b.state = 'OPEN';
  }
}

/**
 * Record a success for a provider.  Closes the circuit.
 */
export function recordSuccess(provider: string): void {
  const b = getBreaker(provider);
  b.state = 'CLOSED';
  b.failures = 0;
}

/**
 * Manually reset a circuit breaker to CLOSED.
 * Used by the admin `/api/admin/health/reset-circuit/:provider` endpoint.
 */
export function resetCircuit(provider: string): void {
  const b = getBreaker(provider);
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
 */
export function areAllCircuitsOpen(): boolean {
  const aiProviders = AI_PROVIDERS.map(p => _breakers[p]);
  return aiProviders.length > 0 && aiProviders.every(b => b?.state === 'OPEN');
}
