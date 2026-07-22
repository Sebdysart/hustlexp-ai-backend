import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import {
  assertActivePreAssignmentTask,
  clarificationFail,
  handleClarificationFailure,
  lockClarificationTask,
  rejectClarification,
  type ClarificationQuery,
  type ClarificationRevision,
  type ClarificationTask,
  type ScopeVersion,
} from './TaskClarificationData.js';
import { buildTaskScopeHash } from './TaskServiceShared.js';

export interface ReviewClarificationRevisionParams {
  taskId: string;
  revisionId: string;
  posterId: string;
  decision: 'APPROVED' | 'REJECTED';
  reason: string;
}

type ReviewClarificationRevisionResult = ServiceResult<{
  status: 'APPROVED' | 'REJECTED';
  requiresPaymentReauthorization: boolean;
  revision: ClarificationRevision;
}>;

interface ApprovalContext {
  currentVersion: number;
  escrowId: string;
}

async function pendingRevision(
  query: ClarificationQuery,
  params: ReviewClarificationRevisionParams,
  task: ClarificationTask,
): Promise<ClarificationRevision> {
  const revisionResult = await query<ClarificationRevision>(
    `SELECT * FROM task_clarification_revisions
      WHERE id = $1 AND task_id = $2 FOR UPDATE`,
    [params.revisionId, params.taskId],
  );
  const revision = revisionResult.rows[0]
    ?? rejectClarification('NOT_FOUND', 'Clarification revision not found.');
  if (revision.status !== 'PENDING_POSTER_APPROVAL') {
    rejectClarification('CONFLICT', 'This revision has already been reviewed.');
  }
  if (revision.base_scope_version_id !== task.active_scope_version_id) {
    rejectClarification('CONFLICT', 'This revision targets stale scope.');
  }
  return revision;
}

async function rejectRevision(
  query: ClarificationQuery,
  params: ReviewClarificationRevisionParams,
  revision: ClarificationRevision,
  reason: string,
) {
  const rejected = await query<ClarificationRevision>(
    `UPDATE task_clarification_revisions
        SET status = 'REJECTED', reviewed_by = $2, review_reason = $3,
            reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [revision.id, params.posterId, reason],
  );
  await query(
    `UPDATE tasks t SET clarification_state = CASE
       WHEN EXISTS (SELECT 1 FROM task_public_questions q WHERE q.task_id = t.id AND q.status = 'OPEN')
         THEN 'QUESTION_OPEN' ELSE 'READY' END,
       updated_at = NOW()
     WHERE t.id = $1`,
    [params.taskId],
  );
  return {
    status: 'REJECTED' as const,
    requiresPaymentReauthorization: false,
    revision: rejected.rows[0]
      ?? rejectClarification('INTERNAL_ERROR', 'Revision decision was not persisted.'),
  };
}

async function approvalContext(
  query: ClarificationQuery,
  params: ReviewClarificationRevisionParams,
  task: ClarificationTask,
): Promise<ApprovalContext> {
  const versionResult = await query<{ version: number }>(
    `SELECT version FROM task_scope_versions
      WHERE id = $1 AND task_id = $2 FOR UPDATE`,
    [task.active_scope_version_id, params.taskId],
  );
  const currentVersion = versionResult.rows[0]
    ?? rejectClarification('INVALID_STATE', 'The active scope version is unavailable.');
  const escrowResult = await query<{ id: string; state: string; stripe_payment_intent_id: string | null }>(
    `SELECT id, state, stripe_payment_intent_id FROM escrows
      WHERE task_id = $1 FOR UPDATE`,
    [params.taskId],
  );
  const escrow = escrowResult.rows[0]
    ?? rejectClarification('INVALID_STATE', 'The task escrow is unavailable.');
  if (escrow.state !== 'PENDING' || escrow.stripe_payment_intent_id !== null) {
    rejectClarification(
      'PAYMENT_REAUTHORIZATION_REQUIRED',
      'Cancel the existing payment authorization before approving repriced scope.',
    );
  }
  return { currentVersion: currentVersion.version, escrowId: escrow.id };
}

function approvedScopeHash(task: ClarificationTask, revision: ClarificationRevision): string {
  return buildTaskScopeHash({
    title: task.title ?? '',
    description: task.description ?? '',
    requirements: task.requirements,
    checklist: revision.proposed_checklist,
    customerTotalCents: revision.proposed_customer_total_cents,
    hustlerPayoutCents: revision.proposed_hustler_payout_cents,
  });
}

async function insertApprovedScope(
  query: ClarificationQuery,
  params: ReviewClarificationRevisionParams,
  task: ClarificationTask,
  revision: ClarificationRevision,
  context: ApprovalContext,
): Promise<ScopeVersion> {
  const scopeResult = await query<ScopeVersion>(
    `INSERT INTO task_scope_versions (
       task_id, version, scope_hash, title, description, requirements,
       checklist, customer_total_cents, hustler_payout_cents, source,
       change_summary, created_by, supersedes_version_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9,
               'APPROVED_CHANGE', $10, $11, $12)
     RETURNING id, version, scope_hash`,
    [
      params.taskId, context.currentVersion + 1, approvedScopeHash(task, revision),
      task.title, task.description, task.requirements ?? null,
      JSON.stringify(revision.proposed_checklist), revision.proposed_customer_total_cents,
      revision.proposed_hustler_payout_cents, revision.proposed_scope_summary,
      params.posterId, task.active_scope_version_id,
    ],
  );
  return scopeResult.rows[0] ?? rejectClarification('INTERNAL_ERROR', 'Approved scope was not persisted.');
}

interface PersistApprovedInput {
  params: ReviewClarificationRevisionParams;
  revision: ClarificationRevision;
  scope: ScopeVersion;
  context: ApprovalContext;
  reason: string;
}

async function persistApprovedRevision(query: ClarificationQuery, input: PersistApprovedInput) {
  const { params, revision, scope, context, reason } = input;
  const approved = await query<ClarificationRevision>(
    `UPDATE task_clarification_revisions
        SET status = 'APPROVED', reviewed_by = $2, review_reason = $3,
            approved_scope_version_id = $4, reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [revision.id, params.posterId, reason, scope.id],
  );
  const approvedRevision = approved.rows[0]
    ?? rejectClarification('INTERNAL_ERROR', 'Revision decision was not persisted.');
  await query(
    `UPDATE tasks
        SET price = $2, hustler_payout_cents = $3, platform_margin_cents = $4,
            scope_hash = $5, active_scope_version_id = $6,
            clarification_state = 'READY', updated_at = NOW()
      WHERE id = $1`,
    [
      params.taskId, revision.proposed_customer_total_cents,
      revision.proposed_hustler_payout_cents, revision.proposed_platform_margin_cents,
      scope.scope_hash, scope.id,
    ],
  );
  await query(
    `UPDATE escrows
        SET amount = $2, version = version + 1, updated_at = NOW()
      WHERE id = $1 AND state = 'PENDING' AND stripe_payment_intent_id IS NULL`,
    [context.escrowId, revision.proposed_customer_total_cents],
  );
  return {
    status: 'APPROVED' as const,
    requiresPaymentReauthorization: true,
    revision: approvedRevision,
  };
}

async function approveRevision(
  query: ClarificationQuery,
  params: ReviewClarificationRevisionParams,
  task: ClarificationTask,
  revision: ClarificationRevision,
  reason: string,
) {
  const context = await approvalContext(query, params, task);
  const scope = await insertApprovedScope(query, params, task, revision, context);
  return persistApprovedRevision(query, { params, revision, scope, context, reason });
}

async function reviewTransaction(
  query: ClarificationQuery,
  params: ReviewClarificationRevisionParams,
  reason: string,
) {
  const task = await lockClarificationTask(query, params.taskId);
  assertActivePreAssignmentTask(task);
  if (task.poster_id !== params.posterId) {
    rejectClarification('FORBIDDEN', 'Only the task Poster can review a revision.');
  }
  const revision = await pendingRevision(query, params, task);
  if (params.decision === 'REJECTED') return rejectRevision(query, params, revision, reason);
  return approveRevision(query, params, task, revision, reason);
}

export async function reviewClarificationRevision(
  params: ReviewClarificationRevisionParams,
): Promise<ReviewClarificationRevisionResult> {
  try {
    const reason = params.reason.trim();
    if (reason.length < 10 || reason.length > 1000) {
      return clarificationFail('INVALID_INPUT', 'A review reason between 10 and 1000 characters is required.');
    }
    const data = await db.transaction((query) => reviewTransaction(query, params, reason));
    return { success: true, data };
  } catch (error) {
    return handleClarificationFailure(error);
  }
}
