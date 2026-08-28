/**
 * Degradation Contracts Unit Tests
 *
 * Validates contract configuration integrity: all pipeline stages have
 * contracts, tier constraints are enforced, and query functions return
 * correct results.
 */
import { describe, it, expect } from 'vitest';
import {
  PIPELINE_CONTRACTS,
  RUNTIME_CONTRACTS,
  getContract,
  isCritical,
  canDegrade,
  type DegradationTier,
} from '../../src/lib/degradation-contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_CONTRACTS = { ...PIPELINE_CONTRACTS, ...RUNTIME_CONTRACTS };
const VALID_TIERS: DegradationTier[] = ['critical', 'standard', 'advisory'];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DegradationContracts', () => {
  // 1. All expected pipeline stages have contracts
  describe('pipeline stage coverage', () => {
    const expectedStages = [
      'typecheck', 'lint', 'unit_tests', 'invariant_tests',
      'knowledge_graph', 'holodeck', 'tdad', 'cost_tracking',
    ];

    it.each(expectedStages)('has a contract for "%s"', (stage) => {
      expect(PIPELINE_CONTRACTS[stage]).toBeDefined();
      expect(PIPELINE_CONTRACTS[stage].service).toBe(stage);
    });
  });

  // 2. All expected runtime services have contracts
  describe('runtime service coverage', () => {
    const expectedServices = ['openai', 'stripe', 'database', 'groq', 'deepseek'];

    it.each(expectedServices)('has a contract for "%s"', (service) => {
      expect(RUNTIME_CONTRACTS[service]).toBeDefined();
      expect(RUNTIME_CONTRACTS[service].service).toBe(service);
    });
  });

  // 3. Critical services have alertThreshold <= 2
  describe('critical tier constraints', () => {
    const criticalServices = Object.values(ALL_CONTRACTS).filter(
      (c) => c.tier === 'critical',
    );

    it('has at least one critical service', () => {
      expect(criticalServices.length).toBeGreaterThan(0);
    });

    it.each(criticalServices.map((c) => [c.service, c]))(
      '"%s" has alertThreshold <= 2',
      (_name, contract) => {
        expect(contract.alertThreshold).toBeLessThanOrEqual(2);
      },
    );
  });

  // 4. Critical services have maxDegradedDurationMs = 0
  describe('critical services cannot degrade', () => {
    const criticalServices = Object.values(ALL_CONTRACTS).filter(
      (c) => c.tier === 'critical',
    );

    it.each(criticalServices.map((c) => [c.service, c]))(
      '"%s" has maxDegradedDurationMs = 0',
      (_name, contract) => {
        expect(contract.maxDegradedDurationMs).toBe(0);
      },
    );
  });

  // 5. getContract returns correct contract
  describe('getContract', () => {
    it('returns pipeline contract by name', () => {
      const contract = getContract('typecheck');
      expect(contract).toBeDefined();
      expect(contract!.service).toBe('typecheck');
      expect(contract!.tier).toBe('critical');
    });

    it('returns runtime contract by name', () => {
      const contract = getContract('openai');
      expect(contract).toBeDefined();
      expect(contract!.service).toBe('openai');
      expect(contract!.tier).toBe('standard');
    });

    it('returns undefined for unknown service', () => {
      expect(getContract('nonexistent')).toBeUndefined();
    });
  });

  // 6. isCritical returns true for critical services
  describe('isCritical', () => {
    const criticalNames = [
      'typecheck', 'lint', 'unit_tests', 'invariant_tests',
      'stripe', 'database',
    ];

    it.each(criticalNames)('returns true for "%s"', (name) => {
      expect(isCritical(name)).toBe(true);
    });

    it('returns false for non-critical service', () => {
      expect(isCritical('knowledge_graph')).toBe(false);
      expect(isCritical('groq')).toBe(false);
    });

    it('returns false for unknown service', () => {
      expect(isCritical('nonexistent')).toBe(false);
    });
  });

  // 7. canDegrade returns true for non-critical services
  describe('canDegrade', () => {
    const degradableNames = ['knowledge_graph', 'holodeck', 'groq', 'deepseek', 'openai'];

    it.each(degradableNames)('returns true for "%s"', (name) => {
      expect(canDegrade(name)).toBe(true);
    });

    it('returns false for critical services', () => {
      expect(canDegrade('typecheck')).toBe(false);
      expect(canDegrade('stripe')).toBe(false);
      expect(canDegrade('database')).toBe(false);
    });

    it('returns true for unknown service (no contract = not critical)', () => {
      expect(canDegrade('nonexistent')).toBe(true);
    });
  });

  // 8. No unknown tiers
  describe('tier validation', () => {
    const allServices = Object.values(ALL_CONTRACTS);

    it.each(allServices.map((c) => [c.service, c]))(
      '"%s" has a valid tier',
      (_name, contract) => {
        expect(VALID_TIERS).toContain(contract.tier);
      },
    );
  });

  // 9. All contracts have required fields populated
  describe('contract completeness', () => {
    const allServices = Object.values(ALL_CONTRACTS);

    it.each(allServices.map((c) => [c.service, c]))(
      '"%s" has all required fields',
      (_name, contract) => {
        expect(contract.service).toBeTruthy();
        expect(contract.description).toBeTruthy();
        expect(contract.healthyBehavior).toBeTruthy();
        expect(contract.degradedBehavior).toBeTruthy();
        expect(contract.offlineBehavior).toBeTruthy();
        expect(typeof contract.alertThreshold).toBe('number');
        expect(typeof contract.maxDegradedDurationMs).toBe('number');
        expect(contract.alertThreshold).toBeGreaterThan(0);
        expect(contract.maxDegradedDurationMs).toBeGreaterThanOrEqual(0);
      },
    );
  });
});
