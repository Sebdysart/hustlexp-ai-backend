import { describe, it, expect } from 'vitest';
import { TaskRiskClassifier, TaskRisk } from '../../src/services/TaskRiskClassifier.js';
import type { ComplianceResult } from '../../src/services/ComplianceGuardianService.js';

function makeComplianceResult(overrides: Partial<ComplianceResult> = {}): ComplianceResult {
  return {
    score: 5, tier: 'clean', triggeredRules: [], notes: {
      score: 5, tier: 'clean', triggered_rules: [], suggested_alternative: null,
      admin_review_id: null, appeal_status: 'none',
      deception_detected: false, is_genuinely_bizarre: false, ai_signals_computed: false,
    },
    deception_detected: false, is_genuinely_bizarre: false, ai_signals_computed: false,
    ...overrides,
  };
}

describe('TaskRiskClassifier deception tier', () => {
  it('deception_detected=true with ai_signals_computed=true enforces minimum TIER_2', () => {
    const complianceResult = makeComplianceResult({
      deception_detected: true,
      ai_signals_computed: true,
    });

    // outdoor task, no people, no home — would normally be TIER_0/1 from wildcard_bizarre min
    const tier = TaskRiskClassifier.classifyWithTemplate(
      { insideHome: false, peoplePresent: false, petsPresent: false, caregiving: false },
      'wildcard_bizarre',
      [],
      complianceResult,
    );

    expect(tier).toBeGreaterThanOrEqual(TaskRisk.TIER_2);
  });

  it('deception_detected=true but ai_signals_computed=false does NOT force TIER_2', () => {
    const complianceResult = makeComplianceResult({
      deception_detected: true,
      ai_signals_computed: false,  // AI didn't run — don't trust deception signal
    });

    const tier = TaskRiskClassifier.classifyWithTemplate(
      { insideHome: false, peoplePresent: false, petsPresent: false, caregiving: false },
      'wildcard_bizarre',
      [],
      complianceResult,
    );

    // Should be template minimum for wildcard_bizarre (TIER_1), NOT forced to TIER_2
    expect(tier).toBeLessThan(TaskRisk.TIER_2);
  });

  it('care template TIER_3 still wins over deception TIER_2', () => {
    const complianceResult = makeComplianceResult({
      deception_detected: true,
      ai_signals_computed: true,
    });

    const tier = TaskRiskClassifier.classifyWithTemplate(
      { insideHome: false, peoplePresent: false, petsPresent: false, caregiving: false },
      'care',
      [],
      complianceResult,
    );

    expect(tier).toBe(TaskRisk.TIER_3);
  });

  it('no complianceResult passed — behaves identically to before', () => {
    const tier = TaskRiskClassifier.classifyWithTemplate(
      { insideHome: false, peoplePresent: false, petsPresent: false, caregiving: false },
      'wildcard_bizarre',
      [],
    );

    // wildcard_bizarre minimum is TIER_1
    expect(tier).toBe(TaskRisk.TIER_1);
  });

  it('deception_detected=false with ai_signals_computed=true does NOT raise tier', () => {
    const complianceResult = makeComplianceResult({
      deception_detected: false,
      ai_signals_computed: true,
    });

    const tier = TaskRiskClassifier.classifyWithTemplate(
      { insideHome: false, peoplePresent: false, petsPresent: false, caregiving: false },
      'wildcard_bizarre',
      [],
      complianceResult,
    );

    // Still just wildcard_bizarre minimum (TIER_1)
    expect(tier).toBe(TaskRisk.TIER_1);
  });

  it('deception + private_location_flag: both signals applied, result is TIER_2', () => {
    const complianceResult = makeComplianceResult({
      deception_detected: true,
      ai_signals_computed: true,
    });

    // Both deception enforcement and private_location_flag push to TIER_2
    const tier = TaskRiskClassifier.classifyWithTemplate(
      { insideHome: false, peoplePresent: false, petsPresent: false, caregiving: false },
      'wildcard_bizarre',
      ['private_location_flag'],
      complianceResult,
    );

    expect(tier).toBe(TaskRisk.TIER_2);
  });
});
