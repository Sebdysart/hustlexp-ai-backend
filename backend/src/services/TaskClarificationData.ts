import { db } from '../db.js';
import type { ServiceResult } from '../types.js';

export type ClarificationQuery = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ClarificationState = 'READY' | 'QUESTION_OPEN' | 'REVISION_PENDING';

export interface ClarificationTask {
  id: string;
  poster_id: string;
  state: string;
  clarification_state?: ClarificationState;
  active_scope_version_id?: string | null;
  scope_hash?: string | null;
  title?: string;
  description?: string;
  requirements?: string | null;
  price?: number;
  hustler_payout_cents?: number | null;
  platform_margin_cents?: number | null;
  location_display?: string | null;
  created_at?: Date | string;
}

export interface PublicQuestion {
  id: string;
  task_id: string;
  asked_by: string;
  question_text: string;
  answer_text?: string | null;
  status: 'OPEN' | 'ANSWERED';
  material_change?: boolean;
  created_at?: Date | string;
  answered_at?: Date | string | null;
}

export interface ClarificationRevision {
  id: string;
  task_id: string;
  source_question_id: string;
  base_scope_version_id: string;
  proposed_scope_summary: string;
  proposed_checklist: string[];
  proposed_customer_total_cents: number;
  proposed_hustler_payout_cents: number;
  proposed_platform_margin_cents: number;
  status: 'PENDING_POSTER_APPROVAL' | 'APPROVED' | 'REJECTED';
  approved_scope_version_id?: string | null;
}

export interface ScopeVersion {
  id: string;
  version: number;
  scope_hash: string;
}

export class ClarificationFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function clarificationFail<T>(code: string, message: string): ServiceResult<T> {
  return { success: false, error: { code, message } };
}

export function rejectClarification(code: string, message: string): never {
  throw new ClarificationFailure(code, message);
}

export function assertActivePreAssignmentTask(task: ClarificationTask): void {
  if (!['OPEN', 'MATCHING'].includes(task.state)) {
    rejectClarification('INVALID_STATE', 'Public clarification closes when matching ends.');
  }
}

export async function lockClarificationTask(
  query: ClarificationQuery,
  taskId: string,
): Promise<ClarificationTask> {
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`task-clarification:${taskId}`]);
  const taskResult = await query<ClarificationTask>(
    `SELECT id, poster_id, state, clarification_state, active_scope_version_id,
            scope_hash, title, description, requirements, price, hustler_payout_cents,
            platform_margin_cents, rough_location AS location_display, created_at
       FROM tasks WHERE id = $1 FOR UPDATE`,
    [taskId],
  );
  return taskResult.rows[0] ?? rejectClarification('NOT_FOUND', 'Task not found.');
}

export function handleClarificationFailure<T>(error: unknown): ServiceResult<T> {
  if (error instanceof ClarificationFailure) return clarificationFail(error.code, error.message);
  if (error instanceof Error && error.message.includes('public-safe task detail')) {
    return clarificationFail('INVALID_INPUT', error.message);
  }
  if (error instanceof Error && (
    error.message.includes('required')
    || error.message.includes('characters')
    || error.message.includes('checklist')
    || error.message.includes('economics')
  )) {
    return clarificationFail('INVALID_INPUT', error.message);
  }
  return clarificationFail('INTERNAL_ERROR', 'Clarification could not be persisted.');
}
