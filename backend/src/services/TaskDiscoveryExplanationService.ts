import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { scrubPII } from '../lib/pii-scrubber.js';
import { AIClient } from './AIClient.js';
import { aiObservation } from './AIObservabilityPolicy.js';
import { generateExplanation } from './TaskDiscoveryScoring.js';
import { calculateMatchingScore } from './TaskDiscoveryScoreService.js';
import type { ExplanationContext } from './TaskDiscoveryTypes.js';

interface ExplanationTask {
  title: string;
  category: string;
  price: number;
  description: string;
}

async function aiExplanation(
  taskId: string,
  hustlerId: string,
  task: ExplanationTask,
  context: ExplanationContext,
  expertise: string[],
): Promise<string> {
  try {
    const result = await AIClient.call({
      observability: aiObservation('AI-DISCOVERY-EXPLANATION', {
        actorUserId: hustlerId,
        affectedObjectType: 'TASK',
        affectedObjectId: taskId,
      }),
      route: 'safety',
      temperature: 0.7,
      timeoutMs: 3000,
      systemPrompt: 'You are a task matching assistant for a gig marketplace. Generate a brief, encouraging 1-2 sentence explanation of why this task is a good match for this hustler. Be concise, specific, and motivating. No markdown. No filler.',
      prompt: scrubPII(
        `Task: "${task.title}" (${task.category}, $${task.price})\n`
        + `Match score: ${(context.matching_score * 100).toFixed(0)}%\n`
        + `Distance: ${context.distance_miles.toFixed(1)} miles\n`
        + `Hustler expertise: ${expertise.length > 0 ? expertise.join(', ') : 'general'}`,
      ),
    });
    const text = result.content?.trim();
    return text && text.length > 10 ? text : generateExplanation(context);
  } catch {
    return generateExplanation(context);
  }
}

export async function getExplanation(
  taskId: string,
  hustlerId: string,
): Promise<ServiceResult<string>> {
  try {
    const score = await calculateMatchingScore(taskId, hustlerId);
    if (!score.success) return score;
    const taskResult = await db.query<ExplanationTask>(
      `SELECT COALESCE(title, '') as title, COALESCE(category, '') as category,
              COALESCE(price, 0) as price, COALESCE(description, '') as description
       FROM tasks WHERE id = $1`,
      [taskId],
    );
    const task = taskResult.rows[0];
    const expertiseResult = await db.query<{ expertise_id: string }>(
      `SELECT expertise_id FROM user_expertise WHERE user_id = $1 AND status = 'active' LIMIT 3`,
      [hustlerId],
    );
    const context: ExplanationContext = {
      matching_score: score.data.matchingScore,
      distance_miles: score.data.distanceMiles,
      category: task?.category || '',
      price: task?.price || 0,
    };
    const explanation = AIClient.isConfigured() && task
      ? await aiExplanation(taskId, hustlerId, task, context, expertiseResult.rows.map((row) => row.expertise_id))
      : generateExplanation(context);
    return { success: true, data: explanation };
  } catch (error) {
    console.error('[TaskDiscoveryService] DB error:', error);
    return { success: false, error: { code: 'DB_ERROR', message: 'Database error' } };
  }
}
