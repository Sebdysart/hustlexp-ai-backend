import type { RecommendationConfidenceBand } from './RecommendationPolicy.js';

export type RecommendationSubject = 'TASK' | 'PRICE' | 'SCHEDULE' | 'ROUTE' | 'PROOF' | 'SAFETY';
export type RecommendationClass =
  | 'INFORMATIONAL'
  | 'CORRECTIVE'
  | 'ECONOMIC'
  | 'SCHEDULING'
  | 'SAFETY'
  | 'ROUTE'
  | 'QUALITY';
export type RecommendationSource = 'AI' | 'DETERMINISTIC' | 'POLICY';
export type RecommendationEventType =
  | 'OPENED'
  | 'EDITED'
  | 'DISMISSED'
  | 'SNOOZED'
  | 'IGNORED'
  | 'OVERRIDDEN'
  | 'APPEALED';
export type RecommendationOutcomeType =
  | 'TASK_OPENED'
  | 'TASK_APPLIED'
  | 'TASK_ACCEPTED'
  | 'TASK_COMPLETED'
  | 'TASK_SETTLED'
  | 'TASK_CANCELLED'
  | 'TASK_DISPUTED'
  | 'RECOMMENDATION_EXPIRED';

export interface RecommendationControls {
  open: boolean;
  edit: boolean;
  dismiss: boolean;
  snooze: boolean;
  why: boolean;
  autoExecute: false;
}

export interface RecommendationRecordInput {
  recipientUserId: string;
  subjectType: RecommendationSubject;
  subjectId: string;
  recommendationClass: RecommendationClass;
  sourceType: RecommendationSource;
  recommendationText: string;
  reason: string;
  evidenceClasses: readonly string[];
  expectedBenefit: string;
  downside: string;
  confidenceBand: RecommendationConfidenceBand;
  modelVersion: string | null;
  policyVersion: string;
  scopeAffected: string;
  userControls: RecommendationControls;
  aiObservationId: string | null;
  idempotencyKey: string;
  expiresAt: string;
}
