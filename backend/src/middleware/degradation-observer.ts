/**
 * Degradation Observer v1.0.0
 *
 * Runtime middleware that maps circuit breaker state transitions to degradation
 * contract events. Wraps the existing circuit breaker to provide contract-aware
 * state tracking.
 *
 * @see circuit-breaker.ts (underlying mechanism)
 * @see lib/degradation-contracts.ts (policy definitions)
 */

import { getContract, type DegradationState } from '../lib/degradation-contracts.js';

// ============================================================================
// TYPES
// ============================================================================

export interface DegradationEvent {
  service: string;
  previousState: DegradationState;
  newState: DegradationState;
  tier: string;
  timestamp: Date;
}

// ============================================================================
// STATE TRACKING
// ============================================================================

const serviceStates = new Map<string, DegradationState>();

/**
 * Observe a circuit breaker state change and emit a degradation event
 * if the mapped degradation state has changed.
 *
 * Returns null if the state did not change or the service has no contract.
 */
export function observeDegradation(
  service: string,
  circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN',
): DegradationEvent | null {
  const contract = getContract(service);
  if (!contract) return null;

  const previousState = serviceStates.get(service) || 'healthy';
  let newState: DegradationState;

  if (circuitState === 'CLOSED') newState = 'healthy';
  else if (circuitState === 'HALF_OPEN') newState = 'degraded';
  else newState = 'offline';

  if (previousState === newState) return null;

  serviceStates.set(service, newState);

  return {
    service,
    previousState,
    newState,
    tier: contract.tier,
    timestamp: new Date(),
  };
}

/**
 * Get the current degradation state of a service.
 * Returns 'healthy' for unknown/untracked services.
 */
export function getServiceState(service: string): DegradationState {
  return serviceStates.get(service) || 'healthy';
}

/**
 * Get all currently tracked service states.
 */
export function getAllServiceStates(): Record<string, DegradationState> {
  return Object.fromEntries(serviceStates);
}

/**
 * Reset all tracked service states. Useful for testing.
 */
export function resetServiceStates(): void {
  serviceStates.clear();
}
