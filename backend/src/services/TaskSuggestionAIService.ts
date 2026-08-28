/**
 * TaskSuggestionAIService — AI-powered task suggestions for workers
 *
 * Uses the existing feed (matching scores) as candidates, then asks the model
 * to pick the best fits and return a short reason per task. Authority: A2 (proposal only).
 *
 * @see TaskDiscoveryService.getFeed
 * @see AIClient
 */

import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import {
  TaskDiscoveryService,
  type TaskFeedItem,
  type FeedFilters,
} from './TaskDiscoveryService.js';
import { WorkerSkillService } from './WorkerSkillService.js';
import { AIClient } from './AIClient.js';
import { aiObservation } from './AIObservabilityPolicy.js';
import { TaskSuggestionsSchema, type TaskSuggestionItemParsed } from '../lib/ai-response-schemas.js';
import { scrubPII } from '../lib/pii-scrubber.js';
import { aiLogger } from '../logger.js';
import { recordTaskSuggestions } from './TaskSuggestionRecommendationService.js';
import type { TaskSuggestionDraft, TaskSuggestionResult } from './TaskSuggestionTypes.js';

const log = aiLogger.child({ service: 'TaskSuggestionAIService' });

const DEFAULT_SUGGESTION_LIMIT = 10;
const CANDIDATE_POOL_SIZE = 25;

export interface AISuggestionInput {
  limit?: number;
  max_distance_miles?: number;
  category?: string;
  min_price?: number;
  max_price?: number;
}

type UserProfileForAI = {
  trust_tier: number;
  zip_code: string | null;
  preferred_categories: string[];
  completed_tasks: number;
  skillNames: string[];
};

export type { TaskSuggestionDraft, TaskSuggestionResult } from './TaskSuggestionTypes.js';

async function recordedFallback(
  userId: string,
  feedItems: TaskFeedItem[],
  limit: number,
  request: unknown,
): Promise<ServiceResult<TaskSuggestionResult[]>> {
  const fallback = TaskSuggestionAIService.fallbackSuggestions(feedItems, limit);
  if (!fallback.success) return fallback;
  return recordTaskSuggestions({
    userId,
    suggestions: fallback.data,
    source: 'DETERMINISTIC',
    modelVersion: null,
    aiObservationId: null,
    request,
  });
}

function feedFilters(input: AISuggestionInput): FeedFilters {
  return {
    max_distance_miles: input.max_distance_miles,
    category: input.category,
    min_price: input.min_price,
    max_price: input.max_price,
    sort_by: 'relevance',
  };
}

function suggestionPrompt(
  profile: UserProfileForAI,
  feedItems: TaskFeedItem[],
  limit: number,
): string {
  const candidateTasks = feedItems.map((item) => ({
    taskId: item.task.id,
    title: item.task.title,
    category: item.task.category ?? '',
    price: item.task.price,
    location: (item.task as { location?: string }).location ?? '',
    matching_score: item.matching_score,
    distance_miles: item.distance_miles,
  }));
  return scrubPII(
    `Worker profile: trust_tier=${profile.trust_tier}, completed_tasks=${profile.completed_tasks}, ` +
      `skills=[${profile.skillNames.join(', ')}], preferred_categories=[${profile.preferred_categories.join(', ')}].\n\n` +
      `Candidate tasks (pick top ${limit}, return only these taskIds with reason and fitScore 0-1):\n` +
      JSON.stringify(candidateTasks, null, 0),
  );
}

function suggestionReason(suggestion: TaskSuggestionItemParsed, item: TaskFeedItem): string {
  return typeof suggestion.reason === 'string' && suggestion.reason.length > 0
    ? suggestion.reason
    : item.explanation;
}

function suggestionFit(suggestion: TaskSuggestionItemParsed, item: TaskFeedItem): number {
  return typeof suggestion.fitScore === 'number'
    && suggestion.fitScore >= 0
    && suggestion.fitScore <= 1
    ? suggestion.fitScore
    : item.matching_score;
}

function selectAISuggestions(
  suggestions: TaskSuggestionItemParsed[],
  feedItems: TaskFeedItem[],
  limit: number,
): TaskSuggestionDraft[] {
  const taskMap = new Map(feedItems.map((item) => [item.task.id, item]));
  const results: TaskSuggestionDraft[] = [];
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    if (results.length >= limit) break;
    if (!suggestion.taskId || seen.has(suggestion.taskId)) continue;
    const item = taskMap.get(suggestion.taskId);
    if (!item) continue;
    seen.add(suggestion.taskId);
    results.push({
      task: item.task,
      matching_score: item.matching_score,
      relevance_score: item.relevance_score,
      distance_miles: item.distance_miles,
      explanation: item.explanation,
      aiReason: suggestionReason(suggestion, item).slice(0, 500),
      fitScore: suggestionFit(suggestion, item),
      offerDecision: item.offer_decision,
    });
  }
  return results;
}

function reportedModelVersion(result: { provider?: string; model?: string }): string {
  return `${result.provider ?? 'provider-unreported'}:${result.model ?? 'model-unreported'}`;
}

async function loadSuggestions(
  userId: string,
  input: AISuggestionInput,
  filters: FeedFilters,
  limit: number,
): Promise<ServiceResult<TaskSuggestionResult[]>> {
  const feedResult = await TaskDiscoveryService.getFeed(userId, filters, CANDIDATE_POOL_SIZE, 0);
  if (!feedResult.success) return feedResult;
  const feedItems = feedResult.data;
  if (feedItems.length === 0) return { success: true, data: [] };

  const profile = await TaskSuggestionAIService.getUserProfileForAI(userId);
  const prompt = suggestionPrompt(profile, feedItems, limit);
  if (!AIClient.isConfigured()) return recordedFallback(userId, feedItems, limit, input);

  const result = await AIClient.callJSON<{ suggestions: TaskSuggestionItemParsed[] }>({
    observability: aiObservation('AI-TASK-SUGGESTION-PROPOSAL', {
      actorUserId: userId,
      affectedObjectType: 'USER_OPPORTUNITY_FEED',
      affectedObjectId: userId,
    }),
    route: 'fast',
    systemPrompt:
      'You are a task recommendation assistant for a local gig marketplace. ' +
      'Given a worker profile and a list of open tasks with matching_score and distance_miles, ' +
      'return a JSON object with key "suggestions": an array of { "taskId": "<uuid>", "reason": "1-2 sentence why this task fits the worker", "fitScore": 0.0-1.0 }. ' +
      'Pick the best tasks for this worker. taskId must be one of the provided task IDs. Return at most the requested number.',
    prompt,
    temperature: 0.3,
    maxTokens: 1500,
    schema: TaskSuggestionsSchema,
    timeoutMs: 12000,
    enableCache: false,
  });
  const suggestions = result?.data?.suggestions;
  if (!Array.isArray(suggestions)) return recordedFallback(userId, feedItems, limit, input);
  const selected = selectAISuggestions(suggestions, feedItems, limit);
  if (selected.length === 0) return recordedFallback(userId, feedItems, limit, input);
  if (!result.observation || result.observation.surfaceId !== 'AI-TASK-SUGGESTION-PROPOSAL') {
    return { success: false, error: {
      code: 'AI_OBSERVABILITY_REQUIRED',
      message: 'AI suggestions were withheld because their observation receipt was unavailable.',
    } };
  }
  return recordTaskSuggestions({
    userId,
    suggestions: selected,
    source: 'AI',
    modelVersion: reportedModelVersion(result),
    aiObservationId: result.observation.observationId,
    request: input,
  });
}

async function getSuggestions(
  userId: string,
  input: AISuggestionInput = {},
): Promise<ServiceResult<TaskSuggestionResult[]>> {
  const limit = Math.min(input.limit ?? DEFAULT_SUGGESTION_LIMIT, 20);
  const filters = feedFilters(input);
  try {
    return await loadSuggestions(userId, input, filters, limit);
  } catch (error) {
    log.warn({ err: error, userId }, 'AI task suggestion failed, using fallback');
    const feedResult = await TaskDiscoveryService.getFeed(userId, filters, limit, 0);
    if (!feedResult.success) return feedResult;
    return recordedFallback(userId, feedResult.data, limit, input);
  }
}

export const TaskSuggestionAIService = {
  /**
   * Get AI-ranked task suggestions for the current worker.
   * Fetches candidate tasks from the personalized feed, then uses AI to select
   * top N with a short reason per task.
   */
  getSuggestions,

  getUserProfileForAI: async (userId: string): Promise<UserProfileForAI> => {
    const defaults = {
      trust_tier: 1,
      zip_code: null as string | null,
      preferred_categories: [] as string[],
      completed_tasks: 0,
      skillNames: [] as string[],
    };

    try {
      const [userRow, skillsResult] = await Promise.all([
        db.query<{
          trust_tier: number;
          zip_code?: string | null;
          preferred_categories?: string[];
          completed: string;
        }>(
          `SELECT
             COALESCE(u.trust_tier, 1)::int as trust_tier,
             (SELECT COUNT(*)::text FROM tasks WHERE worker_id = $1 AND state = 'COMPLETED') as completed
           FROM users u WHERE u.id = $1`,
          [userId]
        ),
        WorkerSkillService.getWorkerSkills(userId),
      ]);

      const row = userRow.rows[0];
      const skillNames = skillsResult.success ? skillsResult.data.map((ws) => (ws as { skill?: { name?: string }; skill_id: string }).skill?.name ?? (ws as { skill_id: string }).skill_id).filter(Boolean) : [];

      return {
        trust_tier: row?.trust_tier ?? defaults.trust_tier,
        zip_code: (row as { zip_code?: string | null })?.zip_code ?? defaults.zip_code,
        preferred_categories: Array.isArray((row as { preferred_categories?: string[] })?.preferred_categories) ? (row as { preferred_categories: string[] }).preferred_categories : defaults.preferred_categories,
        completed_tasks: parseInt(row?.completed ?? '0', 10),
        skillNames,
      };
    } catch {
      return defaults;
    }
  },

  fallbackSuggestions: (
    feedItems: TaskFeedItem[],
    limit: number
  ): ServiceResult<TaskSuggestionDraft[]> => {
    const results: TaskSuggestionDraft[] = feedItems.slice(0, limit).map((item) => ({
      task: item.task,
      matching_score: item.matching_score,
      relevance_score: item.relevance_score,
      distance_miles: item.distance_miles,
      explanation: item.explanation,
      aiReason: item.explanation,
      fitScore: item.matching_score,
      offerDecision: item.offer_decision,
    }));
    return { success: true, data: results };
  },
};

export default TaskSuggestionAIService;
