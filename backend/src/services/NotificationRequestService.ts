import { z } from 'zod';
import { db, type QueryFn } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS } from './NotificationPolicy.js';
import { NotificationService, type CreateNotificationParams } from './NotificationService.js';

const requestSchema = z.object({
  userId: z.string().uuid(), category: z.enum(NOTIFICATION_CATEGORIES),
  title: z.string().min(1).max(200), body: z.string(), deepLink: z.string(),
  taskId: z.string().uuid().optional(), metadata: z.record(z.unknown()).optional(),
  channels: z.array(z.enum(NOTIFICATION_CHANNELS)).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  expiresAt: z.coerce.date().optional(),
  objectRef: z.object({type:z.string(), id:z.string()}).strict().optional(),
  // Leave room for the 21-character outbox namespace in its VARCHAR(255) key.
  dedupeKey: z.string().trim().min(1).max(234).regex(/^[^\r\n]+$/),
}).strict();

/** Persist delivery intent with the domain mutation; no transport or preference calls in that transaction. */
export async function enqueueNotificationRequest(query: QueryFn, input: CreateNotificationParams): Promise<void> {
  const params = requestSchema.parse(input);
  await writeToOutbox({
    eventType: 'notification.create_requested', aggregateType: 'notification_request',
    aggregateId: params.userId, queueName: 'user_notifications',
    idempotencyKey: `notification-request:${params.dedupeKey}`, payload: params,
  }, query);
}

/** Queue contents are not recipient/content authority. Only the persisted request may be replayed. */
export async function processNotificationRequest(job: {
  name: string;
  data: { outbox_idempotency_key?: unknown };
}): Promise<void> {
  const key = job.data.outbox_idempotency_key;
  if (job.name !== 'notification.create_requested' || typeof key !== 'string' || !key.startsWith('notification-request:')) {
    throw new Error('Notification request provenance is missing');
  }
  const result = await db.query<{id:string; payload:unknown; status:string}>(
    `SELECT id, payload, status FROM outbox_events
     WHERE idempotency_key=$1 AND event_type='notification.create_requested'
       AND aggregate_type='notification_request' AND queue_name='user_notifications'`, [key],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Persisted notification request is missing');
  if (row.status === 'processed') return;
  if (!['pending','enqueued'].includes(row.status)) throw new Error('Notification request is not dispatchable');
  const params = requestSchema.parse(row.payload);
  if (`notification-request:${params.dedupeKey}` !== key) throw new Error('Notification request identity mismatch');
  const recipient = await db.query(
    `SELECT id FROM users WHERE id=$1 AND account_status='ACTIVE'
       AND NOT COALESCE(is_banned,false) AND NOT COALESCE(trust_hold,false)`, [params.userId],
  );
  let skipped: string | null = recipient.rows.length ? null : 'recipient_ineligible';
  // Delayed action-required work must still refer to an actionable source.
  // These checks do not change task state or infer authority from queue contents.
  if (!skipped && params.category === 'proof_submitted' && typeof params.metadata?.proofId === 'string') {
    const source = await db.query(
      `SELECT p.id FROM proofs p JOIN tasks t ON t.id=p.task_id
       WHERE p.id=$1 AND p.task_id=$2 AND t.poster_id=$3
         AND p.state='SUBMITTED' AND t.state='PROOF_SUBMITTED'`,
      [params.metadata.proofId,params.taskId,params.userId],
    );
    if (!source.rows.length) skipped = 'source_no_longer_actionable';
  }
  if (!skipped && params.category === 'proof_rejected' && typeof params.metadata?.proofId === 'string') {
    const source = await db.query(
      `SELECT p.id FROM proofs p JOIN tasks t ON t.id=p.task_id
       WHERE p.id=$1 AND p.task_id=$2 AND t.worker_id=$3 AND p.state='REJECTED'
         AND t.state IN ('ACCEPTED','IN_PROGRESS')
         AND NOT EXISTS (SELECT 1 FROM proofs newer WHERE newer.task_id=p.task_id
           AND (newer.created_at,newer.id) > (p.created_at,p.id))`,
      [params.metadata.proofId,params.taskId,params.userId],
    );
    if (!source.rows.length) skipped = 'source_no_longer_actionable';
  }
  if (!skipped && params.category === 'new_matching_task' && typeof params.metadata?.applicationId === 'string') {
    const source = await db.query(
      `SELECT a.id FROM task_applications a JOIN tasks t ON t.id=a.task_id
       WHERE a.id=$1 AND a.task_id=$2 AND t.poster_id=$3 AND t.state='OPEN'
         AND a.status NOT IN ('rejected','counter_rejected','withdrawn','expired')`,
      [params.metadata.applicationId,params.taskId,params.userId],
    );
    if (!source.rows.length) skipped = 'source_no_longer_actionable';
  }
  if (!skipped && params.category === 'payment_released' && typeof params.metadata?.escrowId === 'string') {
    const source = await db.query(
      `SELECT e.id FROM escrows e JOIN tasks t ON t.id=e.task_id
       WHERE e.id=$1 AND t.id=$2 AND e.state='RELEASED' AND e.provider_transfer_id IS NOT NULL
         AND (
           (t.worker_id IS NOT NULL AND COALESCE(t.payout_recipient_user_id,t.worker_id)=$3)
           OR (t.worker_id IS NULL AND t.orchestration_mode='OPS_MANUAL'
             AND t.business_fulfiller_organization_id=$4
             AND EXISTS (SELECT 1 FROM hxos_local_test_business_payout_destinations d
               WHERE d.organization_id=t.business_fulfiller_organization_id
                 AND d.payout_recipient_user_id=$3 AND d.status='ACTIVE' AND d.is_test IS TRUE)
             AND business_membership_has_action(t.business_fulfiller_organization_id,$3,'READ_WORKSPACE'))
         )`,
      [params.metadata.escrowId,params.metadata.taskId,params.userId,params.metadata.organizationId ?? null],
    );
    if (!source.rows.length) skipped = 'release_recipient_no_longer_authorized';
  }
  if (!skipped) {
    const notification = await NotificationService.createNotification(params);
    if (!notification.success) {
      const code = notification.error.code;
      if (!['PREFERENCE_DISABLED','FORBIDDEN','NOT_FOUND'].includes(code)) {
        // Keep the durable request unacknowledged so BullMQ/outbox recovery retries it.
        throw new Error(`Notification request failed: ${code}`);
      }
      skipped = code;
    }
  }
  await db.query(
    `UPDATE outbox_events SET status = 'processed', processed_at=NOW(), error_message=$2
     WHERE id=$1 AND status IN ('pending','enqueued')`, [row.id,skipped],
  );
}
