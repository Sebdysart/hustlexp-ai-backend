import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../db.js';
import { logger } from '../logger.js';
import { requireBusinessManagementAuthority, requireOperationsAuthority } from './BusinessManagementAuthority.js';
import { consumeFinalizedMediaReceipt } from './MediaUploadReceiptService.js';
import { NotificationService } from './NotificationService.js';
import { recordOpsAudit } from './OpsAuditService.js';
import { ProofService } from './ProofService.js';
import { projectProofPhotosForViewer } from './PrivateMediaDeliveryService.js';
import {
  MAX_FAILED_ATTEMPTS, completionCodeExpiresAt, completionCodeMatches,
  generateCompletionCode, hashReworkCompletionCode,
} from './CompletionCodePolicy.js';

const log = logger.child({ service: 'TaskReworkService' });
export const REWORK_STATUSES = ['REQUESTED', 'ACCEPTED', 'DECLINED', 'SCHEDULED', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'COMPLETED', 'CANCELLED'] as const;
export type ReworkStatus = typeof REWORK_STATUSES[number];

interface ReworkRow {
  id: string; task_id: string; business_organization_id: string; sequence_number: number; status: ReworkStatus;
  reason_category: string; requested_correction: string; requested_by_admin_user_id: string;
  support_thread_id: string | null; scheduled_service_date: string | Date | null;
  arrival_window_start: Date | null; arrival_window_end: Date | null;
  accepted_at: Date | null; declined_at: Date | null; scheduled_at: Date | null;
  started_at: Date | null; proof_submitted_at: Date | null; customer_confirmed_at: Date | null;
  completed_at: Date | null; cancelled_at: Date | null; created_at: Date; updated_at: Date;
  event_sequence: number; proof_id?: string | null;
}

interface ParentRow {
  id: string; state: string; poster_id: string;
  business_fulfiller_organization_id: string | null;
  provider_organization_id: string | null;
  provider_assignment_id: string | null;
}

interface ReworkVerificationRow {
  id: string; task_id: string; poster_user_id: string; business_organization_id: string;
  code_hash: string; expires_at: Date; failed_attempts: number; verified_at: Date | null;
}

const activeStatuses: ReworkStatus[] = ['REQUESTED', 'ACCEPTED', 'SCHEDULED', 'IN_PROGRESS', 'PROOF_SUBMITTED'];
const allowed: Readonly<Record<ReworkStatus, readonly ReworkStatus[]>> = {
  REQUESTED: ['ACCEPTED', 'DECLINED', 'CANCELLED'],
  ACCEPTED: ['SCHEDULED', 'IN_PROGRESS', 'CANCELLED'],
  SCHEDULED: ['SCHEDULED', 'IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['PROOF_SUBMITTED', 'CANCELLED'],
  PROOF_SUBMITTED: ['COMPLETED', 'CANCELLED'],
  DECLINED: [], COMPLETED: [], CANCELLED: [],
};

async function event(query: QueryFn, row: ReworkRow, type: string): Promise<void> {
  await query(
    `INSERT INTO engine_automation_events(task_id,event_type,idempotency_key,payload)
     VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(idempotency_key) DO NOTHING`,
    [row.task_id, `TASK_REWORK_${type}`, `task-rework:${row.id}:${row.event_sequence}`,
      JSON.stringify({ reworkId: row.id, sequenceNumber: row.sequence_number, status: row.status,
        ...(row.scheduled_service_date ? { scheduledServiceDate: row.scheduled_service_date } : {}) })],
  );
}

async function parent(query: QueryFn, taskId: string, lock = false): Promise<ParentRow> {
  const result = await query<ParentRow>(
    `SELECT id,state,poster_id,business_fulfiller_organization_id,provider_organization_id,provider_assignment_id
       FROM tasks WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [taskId],
  );
  if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found.' });
  return result.rows[0];
}

async function requireBusiness(query: QueryFn, row: Pick<ReworkRow, 'task_id' | 'business_organization_id'>, actorId: string): Promise<void> {
  const result = await query<{ organization_id: string }>(
    `SELECT membership.organization_id FROM tasks task
       JOIN business_memberships membership ON membership.user_id=$2
        AND membership.organization_id=$3
        AND membership.status='ACTIVE' AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
      WHERE task.id=$1 AND task.state='COMPLETED'
      LIMIT 1`, [row.task_id, actorId, row.business_organization_id],
  );
  if (!result.rows[0]) {
    log.warn({ taskId: row.task_id }, 'Rework business authority denied');
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Fulfilling business access is required.' });
  }
  await requireBusinessManagementAuthority(query, actorId, row.business_organization_id, 'SUBMIT_PROOF');
}

function publicRework(row: ReworkRow) {
  return {
    id: row.id, task_id: row.task_id, sequence_number: row.sequence_number, status: row.status,
    reason_category: row.reason_category, requested_correction: row.requested_correction,
    scheduled_service_date: row.scheduled_service_date,
    arrival_window_start: row.arrival_window_start, arrival_window_end: row.arrival_window_end,
    accepted_at: row.accepted_at, declined_at: row.declined_at, scheduled_at: row.scheduled_at,
    started_at: row.started_at, proof_submitted_at: row.proof_submitted_at,
    customer_confirmed_at: row.customer_confirmed_at, completed_at: row.completed_at,
    cancelled_at: row.cancelled_at, created_at: row.created_at, updated_at: row.updated_at,
    proof_id: row.proof_id ?? null,
  };
}

async function requireCustomer(query: QueryFn, taskId: string, actorId: string): Promise<void> {
  const task = await parent(query, taskId);
  if (task.poster_id !== actorId) {
    log.warn({ taskId }, 'Rework customer authority denied');
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the original customer can view or confirm corrective work.' });
  }
}

async function lockRework(query: QueryFn, reworkId: string): Promise<ReworkRow> {
  const result = await query<ReworkRow>('SELECT * FROM task_reworks WHERE id=$1 FOR UPDATE', [reworkId]);
  if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Corrective work not found.' });
  return result.rows[0];
}

function requireTransition(row: ReworkRow, next: ReworkStatus): void {
  if (!allowed[row.status].includes(next)) {
    log.warn({ reworkId: row.id, from: row.status, to: next }, 'Illegal corrective-work transition');
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `Cannot move corrective work from ${row.status} to ${next}.` });
  }
}

async function notifyCustomer(query: QueryFn, row: ReworkRow, type: string, title: string, message: string): Promise<void> {
  const task = await parent(query, row.task_id);
  await NotificationService.createInTransaction(query, {
    userId: task.poster_id, type, title, message, entityType: 'task_rework', entityId: row.id,
    actionUrl: `/dashboard/tasks/${row.task_id}`, dedupeKey: `task-rework:${row.id}:${row.event_sequence}:customer`,
  });
}

async function notifyBusiness(query: QueryFn, row: ReworkRow, organizationId: string, type: string, title: string, message: string): Promise<void> {
  await NotificationService.createForBusinessInTransaction(query, organizationId, {
    type, title, message, entityType: 'task_rework', entityId: row.id,
    actionUrl: `/business/tasks/${row.task_id}`, dedupeKey: `task-rework:${row.id}:${row.event_sequence}:business`,
  });
}

async function updateStatus(query: QueryFn, row: ReworkRow, next: ReworkStatus, extraSql = '', values: unknown[] = []): Promise<ReworkRow> {
  requireTransition(row, next);
  const changed = await query<ReworkRow>(
    `UPDATE task_reworks SET status=$2, event_sequence=event_sequence+1, updated_at=NOW()
       ${extraSql} WHERE id=$1 AND status=$3 RETURNING *`,
    [row.id, next, row.status, ...values],
  );
  if (!changed.rows[0]) throw new TRPCError({ code: 'CONFLICT', message: 'Corrective work changed; reload and retry.' });
  return changed.rows[0];
}

function validServiceDate(value: string): void {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value || value < new Date().toISOString().slice(0, 10)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Return visit must have a valid future service date.' });
  }
}

export const TaskReworkService = {
  async request(input: { taskId: string; actorId: string; reasonCategory: string; requestedCorrection: string; supportThreadId?: string }) {
    return db.transaction(async (query) => {
      await requireOperationsAuthority(query, input.actorId);
      const task = await parent(query, input.taskId, true);
      if (task.state !== 'COMPLETED') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Only completed tasks can have corrective work.' });
      const organizationId = task.business_fulfiller_organization_id ?? task.provider_organization_id;
      if (!organizationId) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Task has no canonical fulfilling business.' });
      if (!task.business_fulfiller_organization_id) {
        const assignment = await query<{ id: string }>(
          'SELECT id FROM business_service_task_assignments WHERE id=$1 AND task_id=$2 AND provider_organization_id=$3',
          [task.provider_assignment_id, task.id, organizationId],
        );
        if (!assignment.rows[0]) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Task has no canonical fulfilling assignment.' });
      }
      if (input.supportThreadId) {
        const thread = await query<{ id: string }>(
          `SELECT thread.id FROM support_threads thread
             LEFT JOIN task_drafts draft ON draft.id=thread.task_draft_id
            WHERE thread.id=$1 AND (thread.task_id=$2 OR draft.task_id=$2)
              AND (thread.business_organization_id IS NULL OR thread.business_organization_id=$3)`,
          [input.supportThreadId, task.id, organizationId],
        );
        if (!thread.rows[0]) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Support thread is outside this task context.' });
      }
      const existing = await query<{ sequence_number: number; status: string }>(
        'SELECT sequence_number,status FROM task_reworks WHERE task_id=$1 ORDER BY sequence_number DESC LIMIT 1', [task.id],
      );
      if (existing.rows[0] && activeStatuses.includes(existing.rows[0].status as ReworkStatus)) {
        log.warn({ taskId: task.id }, 'Duplicate active corrective-work request');
        throw new TRPCError({ code: 'CONFLICT', message: 'An active corrective-work cycle already exists.' });
      }
      const sequence = Number(existing.rows[0]?.sequence_number ?? 0) + 1;
      const inserted = await query<ReworkRow>(
        `INSERT INTO task_reworks(task_id,business_organization_id,sequence_number,reason_category,requested_correction,requested_by_admin_user_id,support_thread_id)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [task.id, organizationId, sequence, input.reasonCategory, input.requestedCorrection, input.actorId, input.supportThreadId ?? null],
      );
      const row = inserted.rows[0];
      await event(query, row, 'REQUESTED');
      await recordOpsAudit({ actorUserId: input.actorId, action: 'task_rework_requested', targetType: 'task_rework',
        targetId: row.id, meta: { taskId: task.id, sequenceNumber: sequence, reasonCategory: input.reasonCategory,
          supportThreadId: input.supportThreadId ?? null } }, query, true);
      await notifyBusiness(query, row, organizationId, 'TASK_REWORK_REQUESTED', 'Corrective work requested', 'HustleXP requested corrective work for a completed task.');
      return row;
    });
  },

  async history(taskId: string, actorId: string, audience: 'OPS' | 'BUSINESS' | 'CUSTOMER') {
    if (audience === 'OPS') await requireOperationsAuthority(db.query, actorId);
    if (audience === 'CUSTOMER') await requireCustomer(db.query, taskId, actorId);
    const rows = await db.query<ReworkRow>(
      `SELECT rework.*, proof.id AS proof_id FROM task_reworks rework
         LEFT JOIN LATERAL (SELECT id FROM proofs WHERE rework_id=rework.id ORDER BY created_at DESC LIMIT 1) proof ON TRUE
        WHERE rework.task_id=$1 ORDER BY rework.sequence_number DESC`, [taskId],
    );
    if (audience === 'OPS') return rows.rows;
    if (audience === 'CUSTOMER') return rows.rows.map(publicRework);
    if (rows.rows.length === 0) {
      const task = await parent(db.query, taskId);
      const businessOrganizationId = task.business_fulfiller_organization_id ?? task.provider_organization_id;
      if (!businessOrganizationId) throw new TRPCError({ code: 'FORBIDDEN', message: 'Fulfilling business access is required.' });
      await requireBusiness(db.query, { task_id: taskId, business_organization_id: businessOrganizationId }, actorId);
      return [];
    }
    const visible: ReturnType<typeof publicRework>[] = [];
    for (const row of rows.rows) {
      try {
        await requireBusiness(db.query, row, actorId);
        visible.push(publicRework(row));
      } catch (error) {
        if (!(error instanceof TRPCError) || error.code !== 'FORBIDDEN') throw error;
      }
    }
    if (!visible.length) throw new TRPCError({ code: 'FORBIDDEN', message: 'Fulfilling business access is required.' });
    return visible;
  },

  async respond(reworkId: string, actorId: string, response: 'ACCEPTED' | 'DECLINED') {
    return db.transaction(async (query) => {
      const row = await lockRework(query, reworkId);
      await requireBusiness(query, row, actorId);
      const changed = await updateStatus(query, row, response,
        response === 'ACCEPTED' ? ', accepted_at=NOW()' : ', declined_at=NOW()');
      await event(query, changed, response);
      await notifyCustomer(query, changed, `TASK_REWORK_${response}`, response === 'ACCEPTED' ? 'Corrective work accepted' : 'Corrective work declined',
        response === 'ACCEPTED' ? 'The provider accepted the corrective-work request.' : 'The provider declined the corrective-work request.');
      return publicRework(changed);
    });
  },

  async schedule(input: { reworkId: string; actorId: string; serviceDate: string; windowStart?: string; windowEnd?: string }) {
    validServiceDate(input.serviceDate);
    if (Boolean(input.windowStart) !== Boolean(input.windowEnd) ||
      (input.windowStart && input.windowEnd && (Date.parse(input.windowEnd) <= Date.parse(input.windowStart) ||
        new Date(input.windowStart).toISOString().slice(0, 10) !== input.serviceDate))) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Return visit window is invalid.' });
    }
    return db.transaction(async (query) => {
      const row = await lockRework(query, input.reworkId);
      await requireBusiness(query, row, input.actorId);
      const rescheduled = row.status === 'SCHEDULED';
      const changed = await updateStatus(query, row, 'SCHEDULED',
        ', scheduled_service_date=$4::date, arrival_window_start=$5::timestamptz, arrival_window_end=$6::timestamptz, scheduled_at=COALESCE(scheduled_at,NOW())',
        [input.serviceDate, input.windowStart ?? null, input.windowEnd ?? null]);
      await event(query, changed, rescheduled ? 'RESCHEDULED' : 'SCHEDULED');
      await notifyCustomer(query, changed, 'TASK_REWORK_SCHEDULED', rescheduled ? 'Corrective visit rescheduled' : 'Corrective visit scheduled',
        rescheduled ? 'The provider updated the corrective return visit.' : 'The provider scheduled a corrective return visit.');
      return publicRework(changed);
    });
  },

  async start(reworkId: string, actorId: string) {
    return db.transaction(async (query) => {
      const row = await lockRework(query, reworkId);
      await requireBusiness(query, row, actorId);
      const changed = await updateStatus(query, row, 'IN_PROGRESS', ', started_at=NOW()');
      await event(query, changed, 'STARTED');
      return publicRework(changed);
    });
  },

  async submitProof(input: { reworkId: string; actorId: string; description?: string; photoEvidence: Array<{
    uploadReceiptId: string; contentType: string; fileSizeBytes: number; checksumSha256: string;
  }> }) {
    if (!input.description?.trim() && !input.photoEvidence.length) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Corrective proof needs a description or photo.' });
    return db.transaction(async (query) => {
      const row = await lockRework(query, input.reworkId);
      await requireBusiness(query, row, input.actorId);
      requireTransition(row, 'PROOF_SUBMITTED');
      const pending = await query('SELECT 1 FROM proofs WHERE rework_id=$1 AND state IN (\'PENDING\',\'SUBMITTED\') LIMIT 1', [row.id]);
      if (pending.rows[0]) throw new TRPCError({ code: 'CONFLICT', message: 'Corrective proof is already pending.' });
      const inserted = await query<{ id: string }>(
        `INSERT INTO proofs(task_id,rework_id,submitter_id,state,description)
         VALUES($1,$2,$3,'SUBMITTED',$4) RETURNING id`,
        [row.task_id, row.id, input.actorId, input.description?.trim() ?? null],
      );
      const proofId = inserted.rows[0].id;
      for (const [index, photo] of input.photoEvidence.entries()) {
        const media = await consumeFinalizedMediaReceipt(query, {
          evidence: photo, taskId: row.task_id, reworkId: row.id, uploaderId: input.actorId,
          purpose: 'PROOF', consumerId: proofId,
        });
        await query(
          `INSERT INTO proof_photos(proof_id,storage_key,content_type,file_size_bytes,checksum_sha256,sequence_number)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [proofId, media.storageKey, media.contentType, media.fileSizeBytes, media.checksumSha256, index + 1],
        );
      }
      const changed = await updateStatus(query, row, 'PROOF_SUBMITTED', ', proof_submitted_at=NOW()');
      await event(query, changed, 'PROOF_SUBMITTED');
      await notifyCustomer(query, changed, 'TASK_REWORK_PROOF_SUBMITTED', 'Corrective proof submitted', 'The provider submitted corrective-work proof for your review.');
      return { rework: publicRework(changed), proofId };
    });
  },

  async proofForCustomer(reworkId: string, actorId: string) {
    const row = (await db.query<ReworkRow>('SELECT * FROM task_reworks WHERE id=$1', [reworkId])).rows[0];
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Corrective work not found.' });
    await requireCustomer(db.query, row.task_id, actorId);
    const proof = (await db.query<{ id: string; description: string | null }>(
      'SELECT id,description FROM proofs WHERE rework_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 1',
      [row.id, row.task_id],
    )).rows[0];
    if (!proof) return null;
    const photos = await ProofService.getPhotos(proof.id);
    if (!photos.success) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Corrective proof media is unavailable.' });
    return { ...proof, photos: await projectProofPhotosForViewer({ taskId: row.task_id, proofId: proof.id, viewerId: actorId, photos: photos.data }), videos: [] };
  },

  async generateCompletionCode(reworkId: string, actorId: string) {
    return db.transaction(async (query) => {
      const row = await lockRework(query, reworkId);
      await requireCustomer(query, row.task_id, actorId);
      const task = await parent(query, row.task_id);
      if (task.state !== 'COMPLETED' || row.status !== 'PROOF_SUBMITTED') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Corrective proof is not awaiting completion.' });
      }
      const proof = await query('SELECT 1 FROM proofs WHERE rework_id=$1 AND task_id=$2 AND state=\'SUBMITTED\' LIMIT 1', [row.id, row.task_id]);
      if (!proof.rows[0]) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Corrective proof is missing.' });
      const previous = (await query<Pick<ReworkVerificationRow, 'code_hash' | 'verified_at'>>(
        'SELECT code_hash,verified_at FROM task_rework_completion_verifications WHERE rework_id=$1 FOR UPDATE', [row.id],
      )).rows[0];
      if (previous?.verified_at) throw new TRPCError({ code: 'CONFLICT', message: 'This completion code has already been used.' });
      let code = generateCompletionCode();
      while (previous && completionCodeMatches(previous.code_hash, hashReworkCompletionCode(row.task_id, row.id, code))) {
        code = generateCompletionCode();
      }
      const expiresAt = completionCodeExpiresAt();
      const result = await query<{ expires_at: Date }>(
        `INSERT INTO task_rework_completion_verifications
           (rework_id,task_id,poster_user_id,business_organization_id,code_hash,expires_at)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(rework_id) DO UPDATE SET
           code_hash=EXCLUDED.code_hash, expires_at=EXCLUDED.expires_at,
           failed_attempts=0, verified_at=NULL, verified_by_user_id=NULL, updated_at=NOW()
         WHERE task_rework_completion_verifications.task_id=EXCLUDED.task_id
           AND task_rework_completion_verifications.poster_user_id=EXCLUDED.poster_user_id
           AND task_rework_completion_verifications.business_organization_id=EXCLUDED.business_organization_id
           AND task_rework_completion_verifications.verified_at IS NULL
         RETURNING expires_at`,
        [row.id, row.task_id, actorId, row.business_organization_id,
          hashReworkCompletionCode(row.task_id, row.id, code), expiresAt],
      );
      if (!result.rows[0]) throw new TRPCError({ code: 'CONFLICT', message: 'This completion code cannot be regenerated.' });
      return { reworkId: row.id, code, expiresAt: result.rows[0].expires_at.toISOString() };
    });
  },

  async verifyCompletionCode(reworkId: string, actorId: string, code: string) {
    const outcome = await db.transaction(async (query) => {
      const row = await lockRework(query, reworkId);
      await requireBusiness(query, row, actorId);
      requireTransition(row, 'COMPLETED');
      const task = await parent(query, row.task_id);
      if (task.state !== 'COMPLETED') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Parent task is not completed.' });
      const verification = (await query<ReworkVerificationRow>(
        `SELECT id,task_id,poster_user_id,business_organization_id,code_hash,expires_at,failed_attempts,verified_at
           FROM task_rework_completion_verifications WHERE rework_id=$1 FOR UPDATE`, [row.id],
      )).rows[0];
      if (!verification) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'The customer has not generated a corrective-work completion code.' });
      if (verification.task_id !== row.task_id || verification.poster_user_id !== task.poster_id ||
          verification.business_organization_id !== row.business_organization_id) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Completion code context does not match corrective work.' });
      }
      if (verification.verified_at) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This completion code has already been used.' });
      if (verification.expires_at <= new Date()) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This completion code has expired. Ask the customer to generate a new one.' });
      if (verification.failed_attempts >= MAX_FAILED_ATTEMPTS) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Too many incorrect attempts. Ask the customer to generate a new code.' });
      if (!completionCodeMatches(verification.code_hash, hashReworkCompletionCode(row.task_id, row.id, code))) {
        const attempts = verification.failed_attempts + 1;
        await query('UPDATE task_rework_completion_verifications SET failed_attempts=$2, updated_at=NOW() WHERE id=$1', [verification.id, attempts]);
        return { invalid: true as const, locked: attempts >= MAX_FAILED_ATTEMPTS };
      }
      await query(
        `UPDATE task_rework_completion_verifications
            SET verified_at=NOW(), verified_by_user_id=$2, updated_at=NOW() WHERE id=$1`,
        [verification.id, actorId],
      );
      const changed = await updateStatus(query, row, 'COMPLETED', ', customer_confirmed_at=NOW(), completed_at=NOW()');
      await event(query, changed, 'CUSTOMER_CONFIRMED');
      await notifyBusiness(query, changed, row.business_organization_id, 'TASK_REWORK_COMPLETED', 'Corrective work confirmed', 'The customer confirmed the corrective work is complete.');
      return { invalid: false as const, rework: publicRework(changed) };
    });
    if (outcome.invalid) throw new TRPCError({ code: 'BAD_REQUEST', message: outcome.locked
      ? 'Too many incorrect attempts. Ask the customer to generate a new code.' : 'The completion code is incorrect.' });
    return outcome.rework;
  },

  async cancel(reworkId: string, actorId: string) {
    return db.transaction(async (query) => {
      await requireOperationsAuthority(query, actorId);
      const row = await lockRework(query, reworkId);
      const changed = await updateStatus(query, row, 'CANCELLED', ', cancelled_at=NOW()');
      await event(query, changed, 'CANCELLED');
      await recordOpsAudit({ actorUserId: actorId, action: 'task_rework_cancelled', targetType: 'task_rework', targetId: row.id,
        meta: { taskId: row.task_id, sequenceNumber: row.sequence_number } }, query, true);
      await notifyCustomer(query, changed, 'TASK_REWORK_CANCELLED', 'Corrective work cancelled', 'HustleXP cancelled the corrective-work request.');
      return changed;
    });
  },

  async assertUpload(taskId: string, reworkId: string, actorId: string): Promise<void> {
    const row = (await db.query<ReworkRow>(
      'SELECT * FROM task_reworks WHERE id=$1 AND task_id=$2', [reworkId, taskId],
    )).rows[0];
    if (!row || row.status !== 'IN_PROGRESS') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Corrective work is not in progress.' });
    await requireBusiness(db.query, row, actorId);
  },
};
