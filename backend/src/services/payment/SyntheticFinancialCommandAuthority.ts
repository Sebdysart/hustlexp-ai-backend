import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, type Database } from '../../db.js';

export const SYNTHETIC_FINANCIAL_WEBHOOK_MAX_BODY_BYTES = 16 * 1024;
const WEBHOOK_SIGNATURE = /^[0-9a-f]{64}$/u;

export class SyntheticFinancialAuthorityError extends Error {
  readonly code = 'SYNTHETIC_FINANCIAL_AUTHORITY_REFUSED';

  constructor(readonly reason: string) {
    super(`SYNTHETIC_FINANCIAL_AUTHORITY_REFUSED:${reason}`);
  }
}

export function assertSyntheticFinancialWebhookHmac(
  rawBody: string,
  providedSignature: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): void {
  const secret = env.HX_FAKE_FINANCIAL_WEBHOOK_SECRET?.trim() ?? '';
  if (secret.length < 32) {
    throw new SyntheticFinancialAuthorityError('WEBHOOK_SECRET_UNAVAILABLE');
  }
  if (Buffer.byteLength(rawBody, 'utf8') > SYNTHETIC_FINANCIAL_WEBHOOK_MAX_BODY_BYTES) {
    throw new SyntheticFinancialAuthorityError('WEBHOOK_PAYLOAD_TOO_LARGE');
  }
  const normalized = providedSignature.trim().toLowerCase();
  if (!WEBHOOK_SIGNATURE.test(normalized)) {
    throw new SyntheticFinancialAuthorityError('WEBHOOK_HMAC_INVALID');
  }
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  const provided = Buffer.from(normalized, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new SyntheticFinancialAuthorityError('WEBHOOK_HMAC_INVALID');
  }
}

/**
 * Bind an authenticated actor to a Universal V1 controlled-test aggregate.
 *
 * This is intentionally participant authority, not Operations authority. A
 * customer may act on their own controlled-test draft; a provider may act only
 * after an immutable Work Order identifies that provider. Production tasks,
 * legacy contracts, and any task with a hard assignment fail closed.
 */
export class SyntheticFinancialCommandAuthority {
  constructor(private readonly database: Database = db) {}

  async assertTaskParticipant(
    actorId: string,
    taskDraftId: string,
    taskId: string,
  ): Promise<void> {
    const result = await this.database.query<{ authorized: boolean }>(
      `SELECT TRUE AS authorized
       FROM task_drafts draft
       JOIN tasks task
         ON task.id = draft.task_id
        AND task.id = $3
       LEFT JOIN task_work_orders work_order
         ON work_order.task_draft_id = draft.id
        AND work_order.task_id = task.id
       WHERE draft.id = $2
         AND draft.universal_contract_version = 1
         AND task.universal_contract_version = 1
         AND task.automation_classification = 'CONTROLLED_TEST'
         AND task.worker_id IS NULL
         AND (
           draft.poster_user_id = $1
           OR task.poster_id = $1
           OR work_order.provider_user_id = $1
           OR EXISTS (
             SELECT 1
             FROM business_memberships membership
             WHERE membership.organization_id = work_order.provider_organization_id
               AND membership.user_id = $1
               AND membership.status = 'ACTIVE'
               AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
           )
         )
       LIMIT 1`,
      [actorId, taskDraftId, taskId],
    );
    if (result.rows[0]?.authorized !== true) {
      throw new SyntheticFinancialAuthorityError('TASK_PARTICIPANT_OR_SYNTHETIC_BOUNDARY');
    }
  }

  async assertWorkOrderParticipant(actorId: string, workOrderId: string): Promise<void> {
    const result = await this.database.query<{ authorized: boolean }>(
      `SELECT TRUE AS authorized
       FROM task_work_orders work_order
       JOIN task_drafts draft ON draft.id = work_order.task_draft_id
       JOIN tasks task ON task.id = work_order.task_id
       WHERE work_order.id = $2
         AND draft.universal_contract_version = 1
         AND task.universal_contract_version = 1
         AND task.automation_classification = 'CONTROLLED_TEST'
         AND task.worker_id IS NULL
         AND (
           draft.poster_user_id = $1
           OR task.poster_id = $1
           OR work_order.provider_user_id = $1
           OR EXISTS (
             SELECT 1
             FROM business_memberships membership
             WHERE membership.organization_id = work_order.provider_organization_id
               AND membership.user_id = $1
               AND membership.status = 'ACTIVE'
               AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
           )
         )
       LIMIT 1`,
      [actorId, workOrderId],
    );
    if (result.rows[0]?.authorized !== true) {
      throw new SyntheticFinancialAuthorityError('WORK_ORDER_PARTICIPANT_OR_SYNTHETIC_BOUNDARY');
    }
  }

  /**
   * Bind a signed fake-provider callback to an existing provider-neutral
   * operation and prove that its original recorder was a participant in the
   * same unassigned Universal V1 controlled-test aggregate.
   */
  async assertWebhookOperationBoundary(
    taskDraftId: string,
    taskId: string,
    operationId: string,
  ): Promise<void> {
    const result = await this.database.query<{ authorized: boolean }>(
      `SELECT TRUE AS authorized
       FROM task_drafts draft
       JOIN tasks task
         ON task.id = draft.task_id
        AND task.id = $2
       LEFT JOIN task_work_orders work_order
         ON work_order.task_draft_id = draft.id
        AND work_order.task_id = task.id
       WHERE draft.id = $1
         AND draft.universal_contract_version = 1
         AND task.universal_contract_version = 1
         AND task.automation_classification = 'CONTROLLED_TEST'
         AND task.worker_id IS NULL
         AND (
           EXISTS (
             SELECT 1
             FROM task_financial_operations operation
             JOIN task_financial_security_events event
               ON event.operation_id = operation.operation_id
              AND event.provider_kind = 'FAKE'
             WHERE operation.operation_id = $3
               AND operation.provider_kind = 'FAKE'
               AND operation.task_draft_id = draft.id
               AND operation.task_id = task.id
               AND (
                 event.recorded_by = draft.poster_user_id
                 OR event.recorded_by = task.poster_id
                 OR event.recorded_by = work_order.provider_user_id
                 OR EXISTS (
                   SELECT 1
                   FROM business_memberships membership
                   WHERE membership.organization_id = work_order.provider_organization_id
                     AND membership.user_id = event.recorded_by
                     AND membership.status = 'ACTIVE'
                     AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
                 )
               )
           )
           OR EXISTS (
             SELECT 1
             FROM financial_provider_command_journal command
             WHERE command.operation_id::TEXT = $3
               AND command.command_state = 'REQUESTED'
               AND command.provider_kind = 'FAKE'
               AND command.task_draft_id = draft.id
               AND command.task_id = task.id
               AND (
                 command.recorded_actor_id = draft.poster_user_id
                 OR command.recorded_actor_id = task.poster_id
                 OR command.recorded_actor_id = work_order.provider_user_id
                 OR EXISTS (
                   SELECT 1
                   FROM business_memberships membership
                   WHERE membership.organization_id = work_order.provider_organization_id
                     AND membership.user_id = command.recorded_actor_id
                     AND membership.status = 'ACTIVE'
                     AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
                 )
               )
           )
         )
       LIMIT 1`,
      [taskDraftId, taskId, operationId],
    );
    if (result.rows[0]?.authorized !== true) {
      throw new SyntheticFinancialAuthorityError('WEBHOOK_OPERATION_OR_SYNTHETIC_BOUNDARY');
    }
  }
}

export const syntheticFinancialCommandAuthority = new SyntheticFinancialCommandAuthority();
