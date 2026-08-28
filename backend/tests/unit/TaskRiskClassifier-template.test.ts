import { describe, it, expect } from 'vitest';
import { TaskRiskClassifier, TaskRisk } from '../../src/services/TaskRiskClassifier.js';

describe('TaskRiskClassifier — template-aware', () => {
  it('care template always returns TIER_3', () => {
    const risk = TaskRiskClassifier.classifyWithTemplate(
      { insideHome: false, peoplePresent: false, petsPresent: false, caregiving: false },
      'care'
    );
    expect(risk).toBe(TaskRisk.TIER_3);
  });

  it('wildcard_bizarre with private_location_flag bumps to TIER_2', () => {
    const risk = TaskRiskClassifier.classifyWithTemplate(
      { insideHome: false, peoplePresent: false, petsPresent: false, caregiving: false },
      'wildcard_bizarre',
      ['private_location_flag']
    );
    expect(risk).toBe(TaskRisk.TIER_2);
  });

  it('content_creator at private home → TIER_2', () => {
    const risk = TaskRiskClassifier.classifyWithTemplate(
      { insideHome: true, peoplePresent: false, petsPresent: false, caregiving: false },
      'content_creator'
    );
    expect(risk).toBe(TaskRisk.TIER_2);
  });

  it('flags can only increase tier, never decrease', () => {
    // standard_physical default is TIER_0, but caregiving flag bumps it to TIER_3
    const risk = TaskRiskClassifier.classifyWithTemplate(
      { insideHome: false, peoplePresent: true, petsPresent: false, caregiving: false },
      'standard_physical'
    );
    expect(risk).toBe(TaskRisk.TIER_3);
  });

  it('original classifyTaskRisk still works unchanged', () => {
    const risk = TaskRiskClassifier.classifyTaskRisk({
      insideHome: false, peoplePresent: false, petsPresent: false, caregiving: false,
    });
    expect(risk).toBe(TaskRisk.TIER_0);
  });
});
