import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { RATING_WINDOW_DAYS } from './RatingTypes.js';

type Query = Parameters<Parameters<typeof db.transaction>[0]>[0];
const log = logger.child({ service: 'RatingService' });

interface AutoRatingTask {
  id: string;
  poster_id: string;
  worker_id: string | null;
  completed_at: Date;
}

interface AssignedAutoRatingTask extends AutoRatingTask {
  worker_id: string;
}

function assignedTask(task: AutoRatingTask): task is AssignedAutoRatingTask {
  return Boolean(task.worker_id);
}

async function processTaskAutoRating(query: Query, task: AssignedAutoRatingTask): Promise<number> {
  await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rating:${task.id}`]);
  const inserted = await query(
    `INSERT INTO task_ratings (
      task_id, rater_id, ratee_id, stars, comment, tags, is_public, is_blind, is_auto_rated
    )
    SELECT $1::uuid, $2::uuid, $3::uuid, 5, 'No rating submitted (auto-rated)', ARRAY[]::TEXT[], true, false, true
      FROM tasks WHERE id = $1::uuid AND state = 'COMPLETED'
    UNION ALL
    SELECT $1::uuid, $4::uuid, $2::uuid, 5, 'No rating submitted (auto-rated)', ARRAY[]::TEXT[], true, false, true
      FROM tasks WHERE id = $1::uuid AND state = 'COMPLETED'
    ON CONFLICT DO NOTHING`,
    [task.id, task.poster_id, task.worker_id, task.worker_id],
  );
  await query(
    `UPDATE task_ratings SET is_public = true, is_blind = false, updated_at = NOW()
     WHERE task_id = $1
       AND is_blind = true
       AND is_public = false
       AND task_id IN (
         SELECT task_id FROM task_ratings GROUP BY task_id HAVING COUNT(*) = 2
       )`,
    [task.id],
  );
  return inserted.rowCount ?? 0;
}

async function unratedTasks(): Promise<AssignedAutoRatingTask[]> {
  const result = await db.query<AutoRatingTask>(
    `SELECT t.id, t.poster_id, t.worker_id, t.completed_at
     FROM tasks t
     WHERE t.state = 'COMPLETED'
       AND t.completed_at < NOW() - ($1 * INTERVAL '1 day')
       AND t.worker_id IS NOT NULL
       AND (
         NOT EXISTS (
           SELECT 1 FROM task_ratings r1
           WHERE r1.task_id = t.id AND r1.rater_id = t.poster_id AND r1.ratee_id = t.worker_id
         )
         OR NOT EXISTS (
           SELECT 1 FROM task_ratings r2
           WHERE r2.task_id = t.id AND r2.rater_id = t.worker_id AND r2.ratee_id = t.poster_id
         )
       )
     LIMIT 500`,
    [RATING_WINDOW_DAYS],
  );
  return result.rows.filter(assignedTask);
}

export async function processAutoRatings(): Promise<ServiceResult<{ autoRated: number }>> {
  try {
    const tasks = await unratedTasks();
    if (tasks.length === 0) return { success: true, data: { autoRated: 0 } };
    let autoRated = 0;
    for (const task of tasks) {
      try {
        autoRated += await db.transaction((query) => processTaskAutoRating(query, task));
      } catch {
        // One failed task must not prevent the bounded backlog from progressing.
      }
    }
    return { success: true, data: { autoRated } };
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'RatingService DB error');
    return {
      success: false,
      error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' },
    };
  }
}
