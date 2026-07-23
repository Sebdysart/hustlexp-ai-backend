import type { RecommendationConfidenceBand } from './RecommendationPolicy.js';
import type { RecommendationControls, RecommendationSource } from './RecommendationTypes.js';
import type { TaskFeedRow } from './TaskDiscoveryTypes.js';
import type { WorkerOfferDecision } from './WorkerOfferDecisionPolicy.js';

export interface TaskSuggestionDraft {
  task: TaskFeedRow;
  matching_score: number;
  relevance_score: number;
  distance_miles: number;
  explanation: string;
  aiReason: string;
  fitScore: number;
  offerDecision: WorkerOfferDecision;
}

export interface TaskSuggestionResult extends TaskSuggestionDraft {
  recommendationId: string;
  recommendationSource: RecommendationSource;
  confidenceBand: RecommendationConfidenceBand;
  policyVersion: string;
  modelVersion: string | null;
  evidenceClasses: string[];
  expectedBenefit: string;
  downside: string;
  controls: RecommendationControls;
}
