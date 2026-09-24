import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../db.js';
import { backblazeB2 } from '../storage/backblaze-b2.js';
import { recordOpsAudit } from './OpsAuditService.js';
import { TaskCompletionService } from './TaskCompletionService.js';

interface TaskRow {
  id: string; state: string; active_scope_version_id: string | null;
  scope_hash: string | null; business_fulfiller_organization_id: string | null;
  worker_id: string | null; title: string;
}
interface ProofRow {
  id: string; task_id: string; rework_id: string | null; state: string;
  description: string | null; submitter_id: string; submitted_at: Date | null;
  scope_version_id: string | null; scope_version_hash: string | null;
  review_source: string | null;
}
interface PaymentRow {
  id: string; amount_cents: number; status: string; provider: string;
  provider_merchant_id: string | null; provider_payment_id: string;
  finalization_state: string; business_organization_id: string | null;
  refunded_cents: number; pending_cents: number;
  legacy_refund_cents: number | null;
}

function blocked(message: string): never {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
}

async function latestProof(query: QueryFn, taskId: string, lock: boolean): Promise<ProofRow | undefined> {
  const result = await query<ProofRow>(
    `SELECT id, task_id, rework_id, state, description, submitter_id, submitted_at,
            scope_version_id, scope_version_hash, review_source
     FROM proofs WHERE task_id = $1 AND rework_id IS NULL
     ORDER BY created_at DESC, id DESC LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`, [taskId]);
  return result.rows[0];
}

async function boundPayment(query: QueryFn, taskId: string, lock: boolean): Promise<PaymentRow | undefined> {
  const result = await query<Omit<PaymentRow, 'refunded_cents' | 'pending_cents'>>(
    `SELECT payment.id, payment.amount_cents, payment.status, payment.provider,
            payment.provider_merchant_id, payment.provider_payment_id,
            payment.finalization_state, payment.business_organization_id,
            escrow.refund_amount AS legacy_refund_cents
     FROM quote_payments payment
     LEFT JOIN LATERAL (SELECT refund_amount FROM escrows WHERE task_id = payment.task_id
       ORDER BY created_at DESC, id DESC LIMIT 1) escrow ON TRUE
     WHERE payment.task_id = $1 ${lock ? 'FOR UPDATE OF payment' : ''}`,
    [taskId]);
  const payment = result.rows[0];
  if (!payment) return undefined;
  const totals = await query<{ refunded_cents: number; pending_cents: number }>(
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status = 'SUCCEEDED'),0)::INTEGER AS refunded_cents,
            COALESCE(SUM(amount_cents) FILTER (WHERE status IN
              ('RESERVED','PROCESSING','PENDING','UNCERTAIN','REQUIRES_ACTION')),0)::INTEGER AS pending_cents
     FROM quote_payment_refunds WHERE quote_payment_id = $1`, [payment.id]);
  return { ...payment, ...totals.rows[0] };
}

async function assertProofBusiness(query: QueryFn, task: TaskRow, proof: ProofRow): Promise<boolean> {
  if (!task.business_fulfiller_organization_id) return false;
  const membership = await query<{ allowed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM business_memberships
      WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'
        AND role IN ('OWNER','ADMIN','DISPATCHER')) AS allowed`,
    [task.business_fulfiller_organization_id, proof.submitter_id]);
  return membership.rows[0]?.allowed === true;
}

async function eligibility(query: QueryFn, task: TaskRow | undefined,
  proof: ProofRow | undefined, payment: PaymentRow | undefined): Promise<string | null> {
  if (!task) return 'Task not found.';
  if (task.state !== 'PROOF_SUBMITTED') return 'Task is no longer awaiting original completion.';
  if (!proof || proof.task_id !== task.id || proof.rework_id !== null
    || !['SUBMITTED', 'ACCEPTED'].includes(proof.state)) return 'Submitted original proof is required.';
  if (task.active_scope_version_id && (proof.scope_version_id !== task.active_scope_version_id
    || proof.scope_version_hash !== task.scope_hash)) return 'Proof does not match the accepted task scope.';
  if (!(await assertProofBusiness(query, task, proof))) return 'Proof submitter does not belong to the fulfilling business.';
  const verified = await query<{ verified: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM task_completion_verifications
      WHERE task_id = $1 AND verified_at IS NOT NULL) AS verified`, [task.id]);
  if (verified.rows[0]?.verified) return 'A verified customer code is awaiting normal completion recovery.';
  if (!payment || payment.provider !== 'tilled' || payment.status !== 'SUCCEEDED'
    || payment.finalization_state !== 'FINALIZED'
    || payment.business_organization_id !== task.business_fulfiller_organization_id
    || !payment.provider_merchant_id || !/^pi_[A-Za-z0-9_]+$/.test(payment.provider_payment_id)) {
    return 'A successful bound original payment is required.';
  }
  if (Number(payment.pending_cents) > 0) return 'A refund is pending or requires reconciliation.';
  if (Number(payment.refunded_cents) + Number(payment.legacy_refund_cents ?? 0) >= payment.amount_cents) {
    return 'The original charge has been fully refunded.';
  }
  return null;
}

async function proofPhotosForOps(proofId: string, actorId: string) {
  const result = await db.query<{ id: string; receipt_id: string; storage_key: string;
    content_type: string; sequence_number: number }>(
    `SELECT photo.id, receipt.id AS receipt_id, photo.storage_key,
            photo.content_type, photo.sequence_number
     FROM proof_photos photo JOIN proofs proof ON proof.id = photo.proof_id
     JOIN media_upload_receipts receipt ON receipt.task_id = proof.task_id
       AND receipt.status = 'CONSUMED' AND receipt.purpose = 'PROOF'
       AND receipt.consumed_kind = 'PROOF' AND receipt.consumed_id = proof.id
       AND receipt.canonical_key = photo.storage_key AND receipt.canonical_url IS NULL
     JOIN admin_roles role ON role.user_id = $2
       AND (role.can_manage_operations = TRUE OR role.role IN ('admin','founder'))
     WHERE photo.proof_id = $1 ORDER BY photo.sequence_number, photo.id LIMIT 100`,
    [proofId, actorId]);
  const photos = [];
  for (const photo of result.rows) {
    try {
      const downloadUrl = await backblazeB2.getSignedUrlForObject(photo.storage_key, 300);
      const parsed = new URL(downloadUrl);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) continue;
      const expiresAt = new Date(Date.now() + 300_000);
      await db.query(`INSERT INTO ops_proof_media_access_audit
        (proof_id, receipt_id, ops_actor_user_id, signed_url_expires_at) VALUES ($1,$2,$3,$4)`,
      [proofId, photo.receipt_id, actorId, expiresAt]);
      photos.push({ id: photo.id, contentType: photo.content_type,
        sequenceNumber: photo.sequence_number, downloadUrl, expiresAt });
    } catch {
      // A photo without receipt-bound, audited delivery is not disclosed.
    }
  }
  return photos;
}

export async function getOpsCompletionOverrideContext(taskId: string, actorId: string) {
  const taskResult = await db.query<TaskRow>(
    `SELECT id, state, active_scope_version_id, scope_hash,
            business_fulfiller_organization_id, worker_id, title FROM tasks WHERE id = $1`, [taskId]);
  const task = taskResult.rows[0];
  if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
  const proof = await latestProof(db.query.bind(db), taskId, false);
  const payment = await boundPayment(db.query.bind(db), taskId, false);
  const reason = await eligibility(db.query.bind(db), task, proof, payment);
  const override = await db.query<{ id: string; completed_at: Date; internal_reason: string;
    actor_name: string | null }>(
    `SELECT o.id, o.completed_at, o.internal_reason, actor.full_name AS actor_name
     FROM task_completion_overrides o LEFT JOIN users actor ON actor.id = o.ops_actor_user_id
     WHERE o.task_id = $1`, [taskId]);
  const photos = proof ? await proofPhotosForOps(proof.id, actorId) : [];
  return { eligible: reason === null, blocker: reason,
    taskState: task.state, proof: proof ? { id: proof.id, state: proof.state,
      description: proof.description, submittedAt: proof.submitted_at,
      reviewSource: proof.review_source, photos } : null,
    refund: payment ? { originalChargeCents: payment.amount_cents,
      confirmedRefundedCents: Number(payment.refunded_cents), pendingCents: Number(payment.pending_cents) } : null,
    override: override.rows[0] ?? null };
}

export async function completeTaskByOpsOverride(input: {
  taskId: string; proofId: string; actorId: string; internalReason: string;
}) {
  return db.transaction(async (query) => {
    const taskResult = await query<TaskRow>(
      `SELECT id, state, active_scope_version_id, scope_hash,
              business_fulfiller_organization_id, worker_id, title
       FROM tasks WHERE id = $1 FOR UPDATE`, [input.taskId]);
    const task = taskResult.rows[0];
    if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
    if (task.state === 'COMPLETED') blocked('Task is already completed.');
    const proof = await latestProof(query, input.taskId, true);
    if (!proof || proof.id !== input.proofId) blocked('The submitted original proof changed. Reload and review it again.');
    const payment = await boundPayment(query, input.taskId, true);
    const reason = await eligibility(query, task, proof, payment);
    if (reason) blocked(reason);
    const override = await query<{ id: string; created_at: Date }>(
      `INSERT INTO task_completion_overrides
         (task_id, proof_id, ops_actor_user_id, internal_reason)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [input.taskId, input.proofId, input.actorId, input.internalReason]);
    if (proof.state === 'SUBMITTED') {
      await query(`UPDATE proofs SET state = 'ACCEPTED', reviewed_by = $2,
         reviewed_at = NOW(), review_source = 'OPS_OVERRIDE', updated_at = NOW()
         WHERE id = $1 AND task_id = $3 AND rework_id IS NULL AND state = 'SUBMITTED'`,
      [proof.id, input.actorId, input.taskId]);
    }
    const completed = await TaskCompletionService.completeOpsOverrideInTransaction(query, input.taskId, input.actorId);
    if (!completed.success) blocked(completed.error.message);
    await recordOpsAudit({ actorUserId: input.actorId, action: 'TASK_COMPLETION_OPS_OVERRIDE',
      targetType: 'task', targetId: input.taskId,
      meta: { proofId: proof.id, overrideId: override.rows[0].id,
        reason: input.internalReason, completionSource: 'OPS_OVERRIDE', resultingState: 'COMPLETED' },
    }, query, true);
    return { taskState: completed.data.state, override: { id: override.rows[0].id,
      completedAt: override.rows[0].created_at, completionSource: 'OPS_OVERRIDE' as const } };
  });
}
