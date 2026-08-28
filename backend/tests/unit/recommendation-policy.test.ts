import { describe, expect, it } from 'vitest';
import {
  RECOMMENDATION_POLICY_VERSION,
  confidenceBand,
  recommendationRequestHash,
  taskSuggestionControls,
} from '../../src/services/RecommendationPolicy.js';

describe('HX/OS Recommendation policy', () => {
  it('uses qualitative confidence bands without unsupported precision', () => {
    expect(confidenceBand(0.9)).toBe('STRONG_SIGNAL');
    expect(confidenceBand(0.7)).toBe('LIKELY');
    expect(confidenceBand(0.2)).toBe('SUGGESTION');
    expect(confidenceBand(null)).toBe('UNKNOWN');
    expect(confidenceBand(Number.NaN)).toBe('UNKNOWN');
  });

  it('provides reversible worker-owned controls and no hidden acceptance', () => {
    expect(RECOMMENDATION_POLICY_VERSION).toBe('hxos-task-suggestion-v1');
    expect(taskSuggestionControls()).toEqual({
      open: true,
      edit: false,
      dismiss: true,
      snooze: true,
      why: true,
      autoExecute: false,
    });
  });

  it('hashes the exact authoritative payload deterministically', () => {
    const input = { recipientUserId: 'u1', subjectId: 't1', reason: 'Nearby fit' };
    expect(recommendationRequestHash(input)).toMatch(/^[a-f0-9]{64}$/);
    expect(recommendationRequestHash(input)).toBe(recommendationRequestHash({ ...input }));
    expect(recommendationRequestHash(input)).not.toBe(
      recommendationRequestHash({ ...input, reason: 'Different' }),
    );
  });
});
