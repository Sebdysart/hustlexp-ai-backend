import { createHash } from 'node:crypto';

export const RECOMMENDATION_POLICY_VERSION = 'hxos-task-suggestion-v1';

export type RecommendationConfidenceBand =
  | 'STRONG_SIGNAL'
  | 'LIKELY'
  | 'SUGGESTION'
  | 'UNKNOWN';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function recommendationRequestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function confidenceBand(score: number | null | undefined): RecommendationConfidenceBand {
  if (!Number.isFinite(score)) return 'UNKNOWN';
  if ((score ?? 0) >= 0.85) return 'STRONG_SIGNAL';
  if ((score ?? 0) >= 0.6) return 'LIKELY';
  return 'SUGGESTION';
}

export function taskSuggestionControls() {
  return {
    open: true,
    edit: false,
    dismiss: true,
    snooze: true,
    why: true,
    autoExecute: false,
  } as const;
}
