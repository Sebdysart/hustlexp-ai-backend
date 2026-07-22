import type { ServiceResult } from '../types.js';
import {
  confidenceBand,
  RECOMMENDATION_POLICY_VERSION,
  recommendationRequestHash,
  taskSuggestionControls,
} from './RecommendationPolicy.js';
import { RecommendationService } from './RecommendationService.js';
import type { RecommendationSource } from './RecommendationTypes.js';
import type {
  TaskSuggestionDraft,
  TaskSuggestionResult,
} from './TaskSuggestionTypes.js';

const EVIDENCE_CLASSES = [
  'VERIFIED_SKILLS',
  'DISTANCE',
  'MATCH_SCORE',
  'TRUST_TIER',
  'COMPLETED_TASKS',
] as const;

function requestWindow(input: unknown): string {
  const day = new Date().toISOString().slice(0, 10);
  return recommendationRequestHash({ input, day }).slice(0, 40);
}

export async function recordTaskSuggestions(input: {
  userId: string;
  suggestions: TaskSuggestionDraft[];
  source: RecommendationSource;
  modelVersion: string | null;
  aiObservationId: string | null;
  request: unknown;
}): Promise<ServiceResult<TaskSuggestionResult[]>> {
  const controls = taskSuggestionControls();
  const window = requestWindow(input.request);
  const recorded = await RecommendationService.recordDisplayedBatch(
    input.suggestions.map((suggestion) => ({
      recipientUserId: input.userId,
      subjectType: 'TASK' as const,
      subjectId: suggestion.task.id,
      recommendationClass: 'ECONOMIC' as const,
      sourceType: input.source,
      recommendationText: `Review ${suggestion.task.title || 'this opportunity'}.`,
      reason: suggestion.aiReason,
      evidenceClasses: EVIDENCE_CLASSES,
      expectedBenefit: 'Find qualified work within your selected capability and travel range.',
      downside: 'Fit is an estimate; review exact payout, travel, scope, tools, timing, and risk.',
      confidenceBand: confidenceBand(suggestion.fitScore),
      modelVersion: input.modelVersion,
      policyVersion: RECOMMENDATION_POLICY_VERSION,
      scopeAffected: 'task_discovery_order',
      userControls: controls,
      aiObservationId: input.aiObservationId,
      idempotencyKey: `task-suggestion:${window}:${suggestion.task.id}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })),
  );
  if (!recorded.success) return recorded;
  const ids = new Map(recorded.data.map((item) => [item.subjectId, item.recommendationId]));
  return { success: true, data: input.suggestions.map((suggestion) => ({
    ...suggestion,
    recommendationId: ids.get(suggestion.task.id)!,
    recommendationSource: input.source,
    confidenceBand: confidenceBand(suggestion.fitScore),
    policyVersion: RECOMMENDATION_POLICY_VERSION,
    modelVersion: input.modelVersion,
    evidenceClasses: [...EVIDENCE_CLASSES],
    expectedBenefit: 'Find qualified work within your selected capability and travel range.',
    downside: 'Fit is an estimate; review exact payout, travel, scope, tools, timing, and risk.',
    controls,
  })) };
}
