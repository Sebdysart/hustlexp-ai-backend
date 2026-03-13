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
  type TaskFeedRow,
  type FeedFilters,
} from './TaskDiscoveryService.js';
import { WorkerSkillService } from './WorkerSkillService.js';
import { AIClient } from './AIClient.js';
import { TaskSuggestionsSchema, type TaskSuggestionItemParsed } from '../lib/ai-response-schemas.js';
import { scrubPII } from '../lib/pii-scrubber.js';
import { aiLogger } from '../logger.js';

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

export interface TaskSuggestionResult {
  task: TaskFeedRow;
  matching_score: number;
  relevance_score: number;
  distance_miles: number;
  explanation: string;
  /** AI-generated reason why this task is suggested for the user */
  aiReason: string;
  /** AI fit score 0–1 */
  fitScore: number;
}

export const TaskSuggestionAIService = {
  /**
   * Get AI-ranked task suggestions for the current worker.
   * Fetches candidate tasks from the personalized feed, then uses AI to select
   * top N with a short reason per task.
   */
  getSuggestions: async (
    userId: string,
    input: AISuggestionInput = {}
  ): Promise<ServiceResult<TaskSuggestionResult[]>> => {
    const limit = Math.min(input.limit ?? DEFAULT_SUGGESTION_LIMIT, 20);
    const filters: FeedFilters = {
      max_distance_miles: input.max_distance_miles,
      category: input.category,
      min_price: input.min_price,
      max_price: input.max_price,
      sort_by: 'relevance',
    };

    try {
      const feedResult = await TaskDiscoveryService.getFeed(
        userId,
        filters,
        CANDIDATE_POOL_SIZE,
        0
      );

      if (!feedResult.success) {
        return feedResult;
      }

      const feedItems = feedResult.data;
      if (feedItems.length === 0) {
        return { success: true, data: [] };
      }

      const userProfile = await TaskSuggestionAIService.getUserProfileForAI(userId);
      const candidateTasks = feedItems.map((item) => ({
        taskId: item.task.id,
        title: item.task.title,
        category: item.task.category ?? '',
        price: item.task.price,
        location: (item.task as { location?: string }).location ?? '',
        matching_score: item.matching_score,
        distance_miles: item.distance_miles,
      }));

      const prompt = scrubPII(
        `Worker profile: trust_tier=${userProfile.trust_tier}, completed_tasks=${userProfile.completed_tasks}, ` +
          `skills=[${userProfile.skillNames.join(', ')}], preferred_categories=[${userProfile.preferred_categories.join(', ')}].\n\n` +
          `Candidate tasks (pick top ${limit}, return only these taskIds with reason and fitScore 0-1):\n` +
          JSON.stringify(candidateTasks, null, 0)
      );

      if (!AIClient.isConfigured()) {
        return TaskSuggestionAIService.fallbackSuggestions(feedItems, limit);
      }

      const systemPrompt =
        'You are a task recommendation assistant for a local gig marketplace. ' +
        'Given a worker profile and a list of open tasks with matching_score and distance_miles, ' +
        'return a JSON object with key "suggestions": an array of { "taskId": "<uuid>", "reason": "1-2 sentence why this task fits the worker", "fitScore": 0.0-1.0 }. ' +
        'Pick the best tasks for this worker. taskId must be one of the provided task IDs. Return at most the requested number.';

      const result = await AIClient.callJSON<{ suggestions: TaskSuggestionItemParsed[] }>({
        route: 'fast',
        systemPrompt,
        prompt,
        temperature: 0.3,
        maxTokens: 1500,
        schema: TaskSuggestionsSchema,
        timeoutMs: 12000,
        enableCache: false,
      });

      const suggestions = result?.data?.suggestions;
      if (!suggestions || !Array.isArray(suggestions)) {
        return TaskSuggestionAIService.fallbackSuggestions(feedItems, limit);
      }

      const taskMap = new Map(feedItems.map((item) => [item.task.id, item]));
      const results: TaskSuggestionResult[] = [];
      const seen = new Set<string>();

      for (const s of suggestions) {
        if (results.length >= limit) break;
        if (!s.taskId || seen.has(s.taskId)) continue;
        const item = taskMap.get(s.taskId);
        if (!item) continue;
        seen.add(s.taskId);
        const reason = typeof s.reason === 'string' && s.reason.length > 0 ? s.reason : item.explanation;
        const fitScore = typeof s.fitScore === 'number' && s.fitScore >= 0 && s.fitScore <= 1 ? s.fitScore : item.matching_score;
        results.push({
          task: item.task,
          matching_score: item.matching_score,
          relevance_score: item.relevance_score,
          distance_miles: item.distance_miles,
          explanation: item.explanation,
          aiReason: reason.slice(0, 500),
          fitScore,
        });
      }

      if (results.length === 0) {
        return TaskSuggestionAIService.fallbackSuggestions(feedItems, limit);
      }

      return { success: true, data: results };
    } catch (error) {
      log.warn({ err: error, userId }, 'AI task suggestion failed, using fallback');
      const feedResult = await TaskDiscoveryService.getFeed(userId, filters, limit, 0);
      if (!feedResult.success) return feedResult;
      return TaskSuggestionAIService.fallbackSuggestions(feedResult.data, limit);
    }
  },

  getUserProfileForAI: async (userId: string): Promise<{
    trust_tier: number;
    zip_code: string | null;
    preferred_categories: string[];
    completed_tasks: number;
    skillNames: string[];
  }> => {
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
  ): ServiceResult<TaskSuggestionResult[]> => {
    const results: TaskSuggestionResult[] = feedItems.slice(0, limit).map((item) => ({
      task: item.task,
      matching_score: item.matching_score,
      relevance_score: item.relevance_score,
      distance_miles: item.distance_miles,
      explanation: item.explanation,
      aiReason: item.explanation,
      fitScore: item.matching_score,
    }));
    return { success: true, data: results };
  },
};

export default TaskSuggestionAIService;
