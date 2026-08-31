import { TRPCError } from '@trpc/server';
import { db } from '../db.js';
import { redactPrivateLocation } from './TaskLocationService.js';
import { buildTaskScopeHash } from './TaskServiceShared.js';

type Query = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ScopeTask = {
  id: string;
  poster_id: string;
  worker_id: string | null;
  state: string;
  progress_state: string;
  active_scope_version_id: string | null;
  scope_hash: string | null;
};
type ScopeVersionRow = {
  id: string;
  task_id: string;
  version: number;
  scope_hash: string;
  title: string;
  description: string;
  requirements: string | null;
  checklist: string[];
  customer_total_cents: number;
  hustler_payout_cents: number | null;
  source: 'INITIAL' | 'APPROVED_CHANGE';
  change_summary: string;
  created_at: Date | string;
};
type ProposalRow = {
  id: string;
  task_id: string;
  base_version_id: string;
  proposed_by: string;
  proposer_role: 'POSTER' | 'HUSTLER';
  observed_scope_summary: string;
  proposed_checklist: string[];
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELED';
  decision_reason: string | null;
  approved_version_id: string | null;
  created_at: Date | string;
};

function fail(code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'PRECONDITION_FAILED' | 'CONFLICT', message: string): never {
  throw new TRPCError({ code, message });
}

function normalizeChecklist(checklist: string[]): string[] {
  const normalized = checklist.map((item) => redactPrivateLocation(item.trim()) ?? item.trim()).filter(Boolean);
  if (normalized.length < 1 || normalized.length > 12) fail('BAD_REQUEST', 'Execution checklist must contain 1 to 12 items.');
  if (normalized.some((item) => item.length > 200)) fail('BAD_REQUEST', 'Each execution checklist item must be 200 characters or fewer.');
  if (new Set(normalized.map((item) => item.toLocaleLowerCase())).size !== normalized.length) {
    fail('BAD_REQUEST', 'Execution checklist items must be unique.');
  }
  return normalized;
}

function participantRole(task: ScopeTask, userId: string): 'POSTER' | 'HUSTLER' {
  if (task.poster_id === userId) return 'POSTER';
  if (task.worker_id === userId) return 'HUSTLER';
  return fail('FORBIDDEN', 'Only task participants can access execution scope.');
}

async function lockTask(query: Query, taskId: string): Promise<ScopeTask> {
  const result = await query<ScopeTask>(
    `SELECT id, poster_id, worker_id, state, progress_state,
            active_scope_version_id, scope_hash
     FROM tasks WHERE id = $1 FOR UPDATE`,
    [taskId],
  );
  return result.rows[0] ?? fail('NOT_FOUND', 'Task not found.');
}

async function activeVersion(query: Query, task: ScopeTask): Promise<ScopeVersionRow> {
  if (!task.active_scope_version_id) fail('PRECONDITION_FAILED', 'This legacy task has no versioned execution scope.');
  const result = await query<ScopeVersionRow>(
    'SELECT * FROM task_scope_versions WHERE id = $1 AND task_id = $2',
    [task.active_scope_version_id, task.id],
  );
  return result.rows[0] ?? fail('PRECONDITION_FAILED', 'The active execution scope is unavailable.');
}

async function getForParticipant(taskId: string, userId: string) {
  const taskResult = await db.query<ScopeTask>(
    `SELECT id, poster_id, worker_id, state, progress_state,
            active_scope_version_id, scope_hash
     FROM tasks WHERE id = $1`,
    [taskId],
  );
  const task = taskResult.rows[0] ?? fail('NOT_FOUND', 'Task not found.');
  const role = participantRole(task, userId);
  if (!task.active_scope_version_id) {
    return { role, legacy: true, version: null, checklist: [], pendingChange: null };
  }

  const [versionResult, progressResult, proposalResult] = await Promise.all([
    db.query<ScopeVersionRow>('SELECT * FROM task_scope_versions WHERE id = $1 AND task_id = $2', [task.active_scope_version_id, taskId]),
    db.query<{ item_index: number; completed_by: string; completed_at: Date | string }>(
      'SELECT item_index, completed_by, completed_at FROM task_scope_checklist_progress WHERE version_id = $1 ORDER BY item_index',
      [task.active_scope_version_id],
    ),
    db.query<ProposalRow>(
      `SELECT * FROM task_scope_change_proposals
       WHERE task_id = $1 AND status = 'PENDING'
       ORDER BY created_at DESC LIMIT 1`,
      [taskId],
    ),
  ]);
  const version = versionResult.rows[0] ?? fail('PRECONDITION_FAILED', 'The active execution scope is unavailable.');
  const completed = new Map(progressResult.rows.map((row) => [row.item_index, row]));
  return {
    role,
    legacy: false,
    version: {
      id: version.id,
      number: version.version,
      hash: version.scope_hash,
      title: version.title,
      description: version.description,
      requirements: version.requirements,
      customerTotalCents: version.customer_total_cents,
      hustlerPayoutCents: version.hustler_payout_cents,
      source: version.source,
      changeSummary: version.change_summary,
      createdAt: version.created_at,
    },
    checklist: version.checklist.map((text, itemIndex) => ({
      itemIndex,
      text,
      completed: completed.has(itemIndex),
      completedBy: completed.get(itemIndex)?.completed_by ?? null,
      completedAt: completed.get(itemIndex)?.completed_at ?? null,
    })),
    pendingChange: proposalResult.rows[0] ?? null,
  };
}

async function proposeChange(params: {
  taskId: string;
  userId: string;
  observedScopeSummary: string;
  proposedChecklist: string[];
}) {
  const checklist = normalizeChecklist(params.proposedChecklist);
  const summary = redactPrivateLocation(params.observedScopeSummary.trim()) ?? params.observedScopeSummary.trim();
  if (!summary) fail('BAD_REQUEST', 'Explain what differs from the approved scope.');
  return db.transaction(async (query) => {
    const task = await lockTask(query, params.taskId);
    const role = participantRole(task, params.userId);
    if (task.state !== 'ACCEPTED') fail('PRECONDITION_FAILED', 'Scope changes are only available while an accepted task is active.');
    const version = await activeVersion(query, task);
    const activeProof = await query<{ id: string }>(
      `SELECT id FROM proofs
       WHERE task_id = $1 AND state IN ('PENDING', 'SUBMITTED')
       LIMIT 1 FOR UPDATE`,
      [params.taskId],
    );
    if (activeProof.rows[0]) fail('CONFLICT', 'Scope cannot change after completion proof has been submitted.');
    if (JSON.stringify(version.checklist) === JSON.stringify(checklist)) {
      fail('BAD_REQUEST', 'The proposed checklist must change the approved execution scope.');
    }
    const result = await query<ProposalRow>(
      `INSERT INTO task_scope_change_proposals (
         task_id, base_version_id, proposed_by, proposer_role,
         observed_scope_summary, proposed_checklist
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING *`,
      [params.taskId, version.id, params.userId, role, summary, JSON.stringify(checklist)],
    );
    return result.rows[0];
  });
}

async function reviewChange(params: {
  taskId: string;
  proposalId: string;
  posterId: string;
  decision: 'APPROVED' | 'REJECTED';
  reason: string;
}) {
  return db.transaction(async (query) => {
    const task = await lockTask(query, params.taskId);
    if (task.poster_id !== params.posterId) fail('FORBIDDEN', 'Only the task Poster can decide a scope change.');
    if (task.state !== 'ACCEPTED') fail('PRECONDITION_FAILED', 'This task can no longer change execution scope.');
    const proposalResult = await query<ProposalRow>(
      `SELECT * FROM task_scope_change_proposals
       WHERE id = $1 AND task_id = $2 FOR UPDATE`,
      [params.proposalId, params.taskId],
    );
    const proposal = proposalResult.rows[0] ?? fail('NOT_FOUND', 'Scope change proposal not found.');
    if (proposal.status !== 'PENDING') fail('CONFLICT', 'This scope change has already been decided.');
    if (proposal.base_version_id !== task.active_scope_version_id) fail('CONFLICT', 'The proposal targets a stale scope version.');

    if (params.decision === 'REJECTED') {
      const rejected = await query<ProposalRow>(
        `UPDATE task_scope_change_proposals
         SET status = 'REJECTED', reviewed_by = $2, reviewed_at = NOW(),
             decision_reason = $3, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [proposal.id, params.posterId, params.reason.trim()],
      );
      return { proposal: rejected.rows[0], version: null };
    }

    const activeProof = await query<{ id: string }>(
      `SELECT id FROM proofs
       WHERE task_id = $1 AND state IN ('PENDING', 'SUBMITTED')
       LIMIT 1 FOR UPDATE`,
      [params.taskId],
    );
    if (activeProof.rows[0]) fail('CONFLICT', 'Scope cannot change after completion proof has been submitted.');
    const current = await activeVersion(query, task);
    const checklist = normalizeChecklist(proposal.proposed_checklist);
    const hash = buildTaskScopeHash({
      title: current.title,
      description: current.description,
      requirements: current.requirements,
      checklist,
      customerTotalCents: current.customer_total_cents,
      hustlerPayoutCents: current.hustler_payout_cents,
    });
    const versionResult = await query<ScopeVersionRow>(
      `INSERT INTO task_scope_versions (
         task_id, version, scope_hash, title, description, requirements,
         checklist, customer_total_cents, hustler_payout_cents, source,
         change_summary, created_by, supersedes_version_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9,
                 'APPROVED_CHANGE', $10, $11, $12)
       RETURNING *`,
      [
        params.taskId,
        current.version + 1,
        hash,
        current.title,
        current.description,
        current.requirements,
        JSON.stringify(checklist),
        current.customer_total_cents,
        current.hustler_payout_cents,
        proposal.observed_scope_summary,
        params.posterId,
        current.id,
      ],
    );
    const version = versionResult.rows[0];
    await query(
      `UPDATE tasks SET active_scope_version_id = $2, scope_hash = $3, updated_at = NOW()
       WHERE id = $1`,
      [params.taskId, version.id, version.scope_hash],
    );
    const approved = await query<ProposalRow>(
      `UPDATE task_scope_change_proposals
       SET status = 'APPROVED', reviewed_by = $2, reviewed_at = NOW(),
           decision_reason = $3, approved_version_id = $4, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [proposal.id, params.posterId, params.reason.trim(), version.id],
    );
    return { proposal: approved.rows[0], version };
  });
}

async function setChecklistItem(params: {
  taskId: string;
  workerId: string;
  versionId: string;
  itemIndex: number;
  completed: boolean;
}) {
  return db.transaction(async (query) => {
    const task = await lockTask(query, params.taskId);
    if (task.worker_id !== params.workerId) fail('FORBIDDEN', 'Only the reserved Hustler can update execution checklist progress.');
    if (task.state !== 'ACCEPTED' || task.progress_state !== 'WORKING') {
      fail('PRECONDITION_FAILED', 'Checklist progress is available only after check-in and work start.');
    }
    if (task.active_scope_version_id !== params.versionId) fail('CONFLICT', 'Checklist update targets a stale scope version.');
    const pending = await query<{ id: string }>(
      `SELECT id FROM task_scope_change_proposals
       WHERE task_id = $1 AND status = 'PENDING' LIMIT 1 FOR UPDATE`,
      [params.taskId],
    );
    if (pending.rows[0]) fail('PRECONDITION_FAILED', 'Execution is frozen until the pending scope change is decided.');
    const version = await activeVersion(query, task);
    if (!Number.isInteger(params.itemIndex) || params.itemIndex < 0 || params.itemIndex >= version.checklist.length) {
      fail('BAD_REQUEST', 'Checklist item does not exist in the active scope.');
    }
    if (params.completed) {
      await query(
        `INSERT INTO task_scope_checklist_progress (version_id, item_index, completed_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (version_id, item_index) DO NOTHING`,
        [version.id, params.itemIndex, params.workerId],
      );
    } else {
      await query(
        'DELETE FROM task_scope_checklist_progress WHERE version_id = $1 AND item_index = $2',
        [version.id, params.itemIndex],
      );
    }
    return { versionId: version.id, itemIndex: params.itemIndex, completed: params.completed };
  });
}

export const TaskScopeService = {
  getForParticipant,
  proposeChange,
  reviewChange,
  setChecklistItem,
};
