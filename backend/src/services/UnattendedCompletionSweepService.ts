import { db } from '../db.js';
import { TaskCompletionService } from './TaskCompletionService.js';

interface DueTaskRow {
  id: string;
}

export interface UnattendedCompletionSweepResult {
  inspected: number;
  completed: number;
  blocked: number;
  results: Array<{ taskId: string; status: 'completed' | 'blocked'; code?: string }>;
}

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 50, 100));
}

async function completeDue(limit: number = 50): Promise<UnattendedCompletionSweepResult> {
  const candidates = await db.query<DueTaskRow>(
    `SELECT t.id
       FROM tasks t
      WHERE t.state = 'PROOF_SUBMITTED'
        AND t.completion_message_delivered_at IS NOT NULL
        AND t.completion_message_delivered_at <= NOW() - INTERVAL '24 hours'
        AND t.price <= 50000
        AND (
          SELECT p.state FROM proofs p
           WHERE p.task_id = t.id
           ORDER BY p.created_at DESC
           LIMIT 1
        ) = 'ACCEPTED'
        AND EXISTS (
          SELECT 1 FROM escrows e
           WHERE e.task_id = t.id AND e.state = 'FUNDED'
        )
        AND NOT EXISTS (
          SELECT 1 FROM disputes d
           WHERE d.task_id = t.id
             AND d.state IN ('OPEN', 'EVIDENCE_REQUESTED', 'ESCALATED')
        )
      ORDER BY t.completion_message_delivered_at ASC, t.id ASC
      LIMIT $1`,
    [boundedLimit(limit)],
  );

  const results: UnattendedCompletionSweepResult['results'] = [];
  for (const candidate of candidates.rows) {
    const completion = await TaskCompletionService.complete(candidate.id, undefined, {
      mode: 'UNATTENDED',
      idempotencyKey: `unattended-complete:${candidate.id}`,
    });
    if (completion.success) {
      results.push({ taskId: candidate.id, status: 'completed' });
      continue;
    }
    if (completion.error.code === 'DB_ERROR') {
      throw new Error(`Unattended completion failed for ${candidate.id}: ${completion.error.code}`);
    }
    results.push({ taskId: candidate.id, status: 'blocked', code: completion.error.code });
  }

  return {
    inspected: candidates.rows.length,
    completed: results.filter(result => result.status === 'completed').length,
    blocked: results.filter(result => result.status === 'blocked').length,
    results,
  };
}

export const UnattendedCompletionSweepService = { completeDue };

export default UnattendedCompletionSweepService;
