import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import {
  buildMaterialClarificationRevision,
  preparePublicClarification,
  type MaterialClarificationRevision,
} from './TaskClarificationPolicy.js';
import {
  assertActivePreAssignmentTask as activePreAssignmentTask,
  handleClarificationFailure as handleFailure,
  lockClarificationTask as lockTask,
  rejectClarification as reject,
  type ClarificationQuery as Query,
  type ClarificationRevision,
  type ClarificationTask,
  type PublicQuestion,
} from './TaskClarificationData.js';
import { reviewClarificationRevision as reviewRevision } from './TaskClarificationReviewService.js';

async function eligibleOffer(query: Query, taskId: string, workerId: string) {
  const result = await query<{ id: string }>(
    `SELECT d.id
       FROM worker_offer_decisions d
       JOIN tasks t ON t.id = d.task_id
      WHERE d.task_id = $1 AND d.worker_id = $2
        AND d.decision_ready = TRUE AND d.expires_at > NOW()
        AND d.customer_total_cents = t.price
        AND d.payout_cents IS NOT DISTINCT FROM t.hustler_payout_cents
        AND d.scope_hash IS NOT DISTINCT FROM t.scope_hash
      ORDER BY d.created_at DESC LIMIT 1`,
    [taskId, workerId],
  );
  return result.rows[0];
}

async function ask(params: {
  taskId: string;
  workerId: string;
  question: string;
  idempotencyKey: string;
}): Promise<ServiceResult<PublicQuestion>> {
  try {
    const prepared = preparePublicClarification(params.question);
    const question = await db.transaction(async (query) => {
      const task = await lockTask(query, params.taskId);
      activePreAssignmentTask(task);
      if (task.poster_id === params.workerId) reject('FORBIDDEN', 'The Poster cannot ask a candidate question.');
      if (!await eligibleOffer(query, params.taskId, params.workerId)) {
        reject('FORBIDDEN', 'Only a currently eligible candidate can ask this task question.');
      }

      const prior = await query<PublicQuestion & { question_hash: string }>(
        `SELECT * FROM task_public_questions
          WHERE task_id = $1 AND asked_by = $2 AND idempotency_key = $3`,
        [params.taskId, params.workerId, params.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].question_hash !== prepared.hash) {
          reject('CONFLICT', 'This idempotency key was already used for another question.');
        }
        return prior.rows[0];
      }

      const inserted = await query<PublicQuestion>(
        `INSERT INTO task_public_questions (
           task_id, asked_by, question_text, question_hash, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [params.taskId, params.workerId, prepared.text, prepared.hash, params.idempotencyKey],
      );
      await query(
        `UPDATE tasks SET clarification_state = 'QUESTION_OPEN', updated_at = NOW()
          WHERE id = $1`,
        [params.taskId],
      );
      return inserted.rows[0] ?? reject('INTERNAL_ERROR', 'Question was not persisted.');
    });
    return { success: true, data: question };
  } catch (error) {
    return handleFailure(error);
  }
}

async function answer(params: {
  taskId: string;
  questionId: string;
  posterId: string;
  answer: string;
  materialRevision?: MaterialClarificationRevision;
}): Promise<ServiceResult<{ material: boolean; question?: PublicQuestion; revision?: ClarificationRevision }>> {
  try {
    const preparedAnswer = preparePublicClarification(params.answer);
    const revisionInput = params.materialRevision
      ? buildMaterialClarificationRevision(params.materialRevision)
      : undefined;
    const data = await db.transaction(async (query) => {
      const task = await lockTask(query, params.taskId);
      activePreAssignmentTask(task);
      if (task.poster_id !== params.posterId) reject('FORBIDDEN', 'Only the task Poster can answer.');

      const questionResult = await query<PublicQuestion>(
        `SELECT * FROM task_public_questions
          WHERE id = $1 AND task_id = $2 FOR UPDATE`,
        [params.questionId, params.taskId],
      );
      const question = questionResult.rows[0] ?? reject('NOT_FOUND', 'Question not found.');
      if (question.status !== 'OPEN') reject('CONFLICT', 'This question has already been answered.');

      if (!revisionInput) {
        const answered = await query<PublicQuestion>(
          `UPDATE task_public_questions
              SET answer_text = $2, answer_hash = $3, status = 'ANSWERED',
                  material_change = FALSE, answered_by = $4, answered_at = NOW(), updated_at = NOW()
            WHERE id = $1 RETURNING *`,
          [question.id, preparedAnswer.text, preparedAnswer.hash, params.posterId],
        );
        await query(
          `UPDATE tasks t SET clarification_state = CASE
             WHEN EXISTS (SELECT 1 FROM task_public_questions q WHERE q.task_id = t.id AND q.status = 'OPEN')
               THEN 'QUESTION_OPEN' ELSE 'READY' END,
             updated_at = NOW()
           WHERE t.id = $1`,
          [params.taskId],
        );
        return { material: false, question: answered.rows[0] };
      }

      if (!task.active_scope_version_id) {
        reject('INVALID_STATE', 'Material revision requires a versioned task scope.');
      }
      await query(
        `UPDATE task_public_questions
            SET answer_text = $2, answer_hash = $3, status = 'ANSWERED',
                material_change = TRUE, answered_by = $4, answered_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [question.id, preparedAnswer.text, preparedAnswer.hash, params.posterId],
      );
      const inserted = await query<ClarificationRevision>(
        `INSERT INTO task_clarification_revisions (
           task_id, source_question_id, base_scope_version_id, proposed_by,
           proposed_scope_summary, proposed_checklist,
           proposed_customer_total_cents, proposed_hustler_payout_cents,
           proposed_platform_margin_cents
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
         RETURNING *`,
        [
          params.taskId, question.id, task.active_scope_version_id, params.posterId,
          revisionInput.summary, JSON.stringify(revisionInput.checklist),
          revisionInput.customerTotalCents, revisionInput.hustlerPayoutCents,
          revisionInput.platformMarginCents,
        ],
      );
      await query(
        `UPDATE tasks SET clarification_state = 'REVISION_PENDING', updated_at = NOW()
          WHERE id = $1`,
        [params.taskId],
      );
      return {
        material: true,
        revision: inserted.rows[0] ?? reject('INTERNAL_ERROR', 'Revision was not persisted.'),
      };
    });
    return { success: true, data };
  } catch (error) {
    return handleFailure(error);
  }
}

async function getContext(params: { taskId: string; viewerId: string }): Promise<ServiceResult<{
  viewerRole: 'POSTER' | 'ELIGIBLE_CANDIDATE';
  task: ClarificationTask;
  questions: PublicQuestion[];
  pendingRevision: ClarificationRevision | null;
}>> {
  try {
    const taskResult = await db.query<ClarificationTask>(
      `SELECT id, poster_id, state, clarification_state, active_scope_version_id,
              scope_hash, title, description, requirements, price, hustler_payout_cents,
              platform_margin_cents, rough_location AS location_display, created_at
         FROM tasks WHERE id = $1`,
      [params.taskId],
    );
    const task = taskResult.rows[0] ?? reject('NOT_FOUND', 'Task not found.');
    activePreAssignmentTask(task);
    let viewerRole: 'POSTER' | 'ELIGIBLE_CANDIDATE' = 'POSTER';
    if (task.poster_id !== params.viewerId) {
      const offer = await db.query<{ id: string }>(
        `SELECT d.id FROM worker_offer_decisions d
          WHERE d.task_id = $1 AND d.worker_id = $2
            AND d.decision_ready = TRUE AND d.expires_at > NOW()
            AND d.customer_total_cents = $3
            AND d.payout_cents IS NOT DISTINCT FROM $4
            AND d.scope_hash IS NOT DISTINCT FROM $5
          ORDER BY d.created_at DESC LIMIT 1`,
        [params.taskId, params.viewerId, task.price, task.hustler_payout_cents, task.scope_hash],
      );
      if (!offer.rows[0]) reject('FORBIDDEN', 'This clarification thread is limited to eligible candidates.');
      viewerRole = 'ELIGIBLE_CANDIDATE';
    }
    const [questions, revisions] = await Promise.all([
      db.query<PublicQuestion>(
        `SELECT id, task_id, asked_by, question_text, answer_text, status,
                material_change, created_at, answered_at
           FROM task_public_questions WHERE task_id = $1 ORDER BY created_at ASC`,
        [params.taskId],
      ),
      db.query<ClarificationRevision>(
        `SELECT * FROM task_clarification_revisions
          WHERE task_id = $1 AND status = 'PENDING_POSTER_APPROVAL'
          ORDER BY created_at DESC LIMIT 1`,
        [params.taskId],
      ),
    ]);
    return {
      success: true,
      data: { viewerRole, task, questions: questions.rows, pendingRevision: revisions.rows[0] ?? null },
    };
  } catch (error) {
    return handleFailure(error);
  }
}

export const TaskClarificationService = { ask, answer, reviewRevision, getContext };
