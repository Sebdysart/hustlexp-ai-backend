/**
 * Degradation Observer Unit Tests
 *
 * Tests circuit breaker state → degradation state mapping, event emission,
 * and service state tracking.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  observeDegradation,
  getServiceState,
  getAllServiceStates,
  resetServiceStates,
} from '../../src/middleware/degradation-observer';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetServiceStates();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DegradationObserver', () => {
  // 1. CLOSED maps to healthy state
  describe('CLOSED → healthy', () => {
    it('maps CLOSED circuit state to healthy degradation state', () => {
      // First set to degraded so we can observe the transition
      observeDegradation('openai', 'HALF_OPEN');
      const event = observeDegradation('openai', 'CLOSED');

      expect(event).not.toBeNull();
      expect(event!.newState).toBe('healthy');
      expect(getServiceState('openai')).toBe('healthy');
    });
  });

  // 2. OPEN maps to offline state
  describe('OPEN → offline', () => {
    it('maps OPEN circuit state to offline degradation state', () => {
      const event = observeDegradation('openai', 'OPEN');

      expect(event).not.toBeNull();
      expect(event!.newState).toBe('offline');
      expect(getServiceState('openai')).toBe('offline');
    });
  });

  // 3. HALF_OPEN maps to degraded state
  describe('HALF_OPEN → degraded', () => {
    it('maps HALF_OPEN circuit state to degraded degradation state', () => {
      const event = observeDegradation('openai', 'HALF_OPEN');

      expect(event).not.toBeNull();
      expect(event!.newState).toBe('degraded');
      expect(getServiceState('openai')).toBe('degraded');
    });
  });

  // 4. State change emits event with correct fields
  describe('event emission', () => {
    it('emits event with service, previousState, newState, tier, and timestamp', () => {
      const event = observeDegradation('openai', 'OPEN');

      expect(event).not.toBeNull();
      expect(event!.service).toBe('openai');
      expect(event!.previousState).toBe('healthy');
      expect(event!.newState).toBe('offline');
      expect(event!.tier).toBe('standard');
      expect(event!.timestamp).toBeInstanceOf(Date);
    });

    it('tracks previous state across transitions', () => {
      observeDegradation('stripe', 'OPEN');
      const event = observeDegradation('stripe', 'HALF_OPEN');

      expect(event).not.toBeNull();
      expect(event!.previousState).toBe('offline');
      expect(event!.newState).toBe('degraded');
    });
  });

  // 5. No event when state unchanged
  describe('no-op on same state', () => {
    it('returns null when circuit state maps to same degradation state', () => {
      observeDegradation('openai', 'OPEN');
      const event = observeDegradation('openai', 'OPEN');

      expect(event).toBeNull();
    });

    it('returns null for initial CLOSED (healthy → healthy)', () => {
      // Default state is healthy, CLOSED also maps to healthy
      const event = observeDegradation('openai', 'CLOSED');
      expect(event).toBeNull();
    });
  });

  // 6. Unknown service returns null
  describe('unknown service', () => {
    it('returns null for service without a contract', () => {
      const event = observeDegradation('nonexistent-service', 'OPEN');
      expect(event).toBeNull();
    });
  });

  // 7. getServiceState returns correct state
  describe('getServiceState', () => {
    it('returns healthy for untracked service', () => {
      expect(getServiceState('openai')).toBe('healthy');
    });

    it('returns current state after transition', () => {
      observeDegradation('groq', 'OPEN');
      expect(getServiceState('groq')).toBe('offline');

      observeDegradation('groq', 'HALF_OPEN');
      expect(getServiceState('groq')).toBe('degraded');

      observeDegradation('groq', 'CLOSED');
      expect(getServiceState('groq')).toBe('healthy');
    });
  });

  // 8. getAllServiceStates returns all tracked services
  describe('getAllServiceStates', () => {
    it('returns empty object when no services tracked', () => {
      expect(getAllServiceStates()).toEqual({});
    });

    it('returns all tracked services with their states', () => {
      observeDegradation('openai', 'OPEN');
      observeDegradation('groq', 'HALF_OPEN');
      observeDegradation('stripe', 'OPEN');

      const states = getAllServiceStates();
      expect(states).toEqual({
        openai: 'offline',
        groq: 'degraded',
        stripe: 'offline',
      });
    });
  });

  // 9. Tier is correctly reported from contract
  describe('tier reporting', () => {
    it('reports critical tier for stripe', () => {
      const event = observeDegradation('stripe', 'OPEN');
      expect(event!.tier).toBe('critical');
    });

    it('reports advisory tier for groq', () => {
      const event = observeDegradation('groq', 'OPEN');
      expect(event!.tier).toBe('advisory');
    });

    it('reports standard tier for openai', () => {
      const event = observeDegradation('openai', 'OPEN');
      expect(event!.tier).toBe('standard');
    });
  });

  // 10. resetServiceStates clears all state
  describe('resetServiceStates', () => {
    it('clears all tracked states', () => {
      observeDegradation('openai', 'OPEN');
      observeDegradation('groq', 'HALF_OPEN');

      resetServiceStates();

      expect(getAllServiceStates()).toEqual({});
      expect(getServiceState('openai')).toBe('healthy');
      expect(getServiceState('groq')).toBe('healthy');
    });
  });
});
