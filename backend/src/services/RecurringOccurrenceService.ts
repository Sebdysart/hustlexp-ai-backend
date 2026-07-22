import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult, Task } from '../types.js';
import type { TaskCreateQuery } from './TaskCreateService.js';
import {
  decryptTaskLocation,
  type StoredEncryptedTaskLocation,
} from './TaskLocationCrypto.js';
import { recurringInvalid } from './RecurringWorkErrors.js';
import {
  completeAtEndDate,
  type GenerationContext,
  notDueResult,
  replayResult,
  safeguardResult,
  skipBlackout,
} from './RecurringScheduleService.js';
import type {
  ControlledOccurrenceResult,
  ControlledSeriesRow,
  GenerateControlledOccurrenceInput,
} from './RecurringWorkTypes.js';

const log = logger.child({ service: 'RecurringOccurrenceService' });

type ApprovalResolution =
  | { proceed: true; approvalRequestId: string | null }
  | { proceed: false; result: ServiceResult<ControlledOccurrenceResult> };

type ProviderSelection = {
  providerId: string | null;
  poolType: 'PREFERRED' | 'BACKUP';
};

function privatePayload(
  row: ControlledSeriesRow,
  kind: 'location' | 'access',
): StoredEncryptedTaskLocation {
  return {
    location_ciphertext: kind === 'location' ? row.location_ciphertext : row.access_ciphertext,
    location_nonce: kind === 'location' ? row.location_nonce : row.access_nonce,
    location_auth_tag: kind === 'location' ? row.location_auth_tag : row.access_auth_tag,
    location_key_id: kind === 'location' ? row.location_key_id : row.access_key_id,
  };
}

async function createOccurrenceTask(
  query: TaskCreateQuery,
  row: ControlledSeriesRow,
  occurrenceNumber: number,
  generationKey: string,
  scheduledStart: Date,
): Promise<ServiceResult<Task>> {
  const { TaskCreateService } = await import('./TaskCreateService.js');
  const exactLocation = decryptTaskLocation(row.id, privatePayload(row, 'location'));
  const accessProcedure = decryptTaskLocation(`${row.id}:access`, privatePayload(row, 'access'));
  const deadline = new Date(scheduledStart.getTime() + row.expected_duration_minutes * 60_000);
  return TaskCreateService.createInTransaction(query, {
    posterId: row.poster_id,
    title: row.title,
    description: row.description,
    price: row.payment_cents,
    hustlerPayoutCents: row.provider_payout_cents,
    platformMarginCents: row.platform_margin_cents,
    requirements: 'Follow the approved recurring recipe and completion checklist. Private access instructions release only after assignment.',
    location: `${exactLocation}\nAccess procedure: ${accessProcedure}`,
    roughArea: row.rough_location,
    regionCode: row.region_code,
    category: row.category,
    deadline,
    dispatchExpiresAt: scheduledStart,
    requiresProof: true,
    riskLevel: row.risk_level ?? 'LOW',
    mode: 'STANDARD',
    instantMode: false,
    templateSlug: 'recurring-work-v2',
    clientIdempotencyKey: generationKey,
    proofSteps: row.completion_checklist,
    estimatedDurationMinutes: row.expected_duration_minutes,
    requiredTools: row.required_tools,
    preferredWorkerId: row.preferred_worker_id ?? undefined,
    automationClassification: 'PRODUCTION',
  });
}

async function pauseForBusinessDecision(
  query: TaskCreateQuery,
  context: GenerationContext,
  actorId: string | null,
  decision: {
    approval_request_id: string;
    approval_status: string;
    approval_blockers: string[];
  },
): Promise<ServiceResult<ControlledOccurrenceResult>> {
  const pauseCode = decision.approval_status === 'BLOCKED'
    ? 'BUSINESS_BUDGET_BLOCKED'
    : 'BUSINESS_SPEND_NOT_APPROVED';
  await query(
    `SELECT pause_recurring_template($1,$2,$3::jsonb,$4) AS paused`,
    [context.row.id, pauseCode, JSON.stringify({
      approvalRequestId: decision.approval_request_id,
      approvalStatus: decision.approval_status,
      blockers: decision.approval_blockers,
    }), actorId],
  );
  return { success: true, data: { outcome: 'paused', pauseCode } };
}

async function resolveBusinessApproval(
  query: TaskCreateQuery,
  context: GenerationContext,
  actorId: string | null,
): Promise<ApprovalResolution> {
  const row = context.row;
  if (row.client_principal_type !== 'ORGANIZATION') {
    return { proceed: true, approvalRequestId: null };
  }
  if (!row.business_organization_id || !row.business_location_id) {
    return {
      proceed: false,
      result: recurringInvalid(
        'Organization recurring authority is incomplete.',
        'BUSINESS_RECURRING_SCOPE_INVALID',
      ),
    };
  }
  const approval = await query<{
    approval_request_id: string;
    approval_status: 'AUTO_APPROVED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'BLOCKED' | 'CANCELLED';
    approval_blockers: string[];
  }>(
    `SELECT approval_request_id,approval_status,approval_blockers
     FROM request_business_spend($1,$2,$3,$4,$5,$6,$7,$8)`,
    [row.business_organization_id, row.poster_id, row.business_location_id, row.category,
      row.payment_cents, row.recurring_po_number, row.recurring_cost_center, context.generationKey],
  );
  const decision = approval.rows[0];
  if (!decision) return {
    proceed: false,
    result: recurringInvalid(
      'Recurring spend policy produced no decision.',
      'BUSINESS_RECURRING_APPROVAL_FAILED',
    ),
  };
  if (decision.approval_status === 'PENDING_APPROVAL') return {
    proceed: false,
    result: {
      success: true,
      data: {
        outcome: 'approval_required',
        approvalRequestId: decision.approval_request_id,
      },
    },
  };
  if (!['AUTO_APPROVED', 'APPROVED'].includes(decision.approval_status)) return {
    proceed: false,
    result: await pauseForBusinessDecision(query, context, actorId, decision),
  };
  return { proceed: true, approvalRequestId: decision.approval_request_id };
}

function providerSelection(row: ControlledSeriesRow): ProviderSelection {
  if (row.preferred_worker_id) {
    return { providerId: row.preferred_worker_id, poolType: 'PREFERRED' };
  }
  return { providerId: row.backup_worker_ids[0] ?? null, poolType: 'BACKUP' };
}

async function bindBusinessWorkOrder(
  query: TaskCreateQuery,
  row: ControlledSeriesRow,
  approvalRequestId: string | null,
  taskId: string,
): Promise<void> {
  if (!approvalRequestId || !row.business_organization_id) return;
  await query(
    `SELECT canonical_task_id,idempotency_replayed
     FROM bind_business_work_order($1,$2,$3,$4)`,
    [row.business_organization_id, row.poster_id, approvalRequestId, taskId],
  );
}

async function createProviderReservation(
  query: TaskCreateQuery,
  occurrenceId: string,
  provider: ProviderSelection,
): Promise<void> {
  if (!provider.providerId) return;
  await query(
    `INSERT INTO recurring_provider_reservations (
       occurrence_id,worker_id,pool_type,wave_rank,status,expires_at
     ) VALUES ($1,$2,$3,0,'PENDING',NOW()+INTERVAL '30 minutes')`,
    [occurrenceId, provider.providerId, provider.poolType],
  );
}

async function persistOccurrence(
  query: TaskCreateQuery,
  context: GenerationContext,
  approvalRequestId: string | null,
): Promise<ServiceResult<ControlledOccurrenceResult>> {
  const { row, scheduledStart, generationKey } = context;
  const occurrenceNumber = row.occurrence_count + 1;
  const taskResult = await createOccurrenceTask(
    query, row, occurrenceNumber, generationKey, scheduledStart,
  );
  if (!taskResult.success) return taskResult;
  const taskId = taskResult.data.id;
  const scheduledEnd = new Date(scheduledStart.getTime() + row.expected_duration_minutes * 60_000);
  await query(
    `UPDATE tasks SET parent_series_id=$1,occurrence_number=$2,recurring_template_revision_id=$3
     WHERE id=$4`,
    [row.id, occurrenceNumber, row.current_revision_id, taskId],
  );
  await bindBusinessWorkOrder(query, row, approvalRequestId, taskId);
  const provider = providerSelection(row);
  const occurrence = await query<{ id: string }>(
    `INSERT INTO recurring_task_occurrences (
       series_id,task_id,occurrence_number,scheduled_date,status,template_revision_id,
       scheduled_start,scheduled_end,customer_total_cents,provider_payout_cents,
       platform_margin_cents,reservation_state,generation_key,generation_attempted_at,
       business_approval_request_id
     ) VALUES ($1,$2,$3,$4,'posted',$5,$6,$7,$8,$9,$10,$11,$12,NOW(),$13) RETURNING id`,
    [row.id, taskId, occurrenceNumber, scheduledStart.toISOString().slice(0, 10),
      row.current_revision_id, scheduledStart, scheduledEnd, row.payment_cents,
      row.provider_payout_cents, row.platform_margin_cents,
      provider.providerId ? `${provider.poolType}_PENDING` : 'NO_PROVIDER', generationKey,
      approvalRequestId],
  );
  const occurrenceId = occurrence.rows[0].id;
  await createProviderReservation(query, occurrenceId, provider);
  await query(
    `UPDATE recurring_task_series SET occurrence_count=occurrence_count+1,
       budget_spend_cents=budget_spend_cents+payment_cents,
       next_occurrence_at=(CASE pattern
         WHEN 'daily' THEN (next_occurrence_at AT TIME ZONE timezone + INTERVAL '1 day') AT TIME ZONE timezone
         WHEN 'weekly' THEN (next_occurrence_at AT TIME ZONE timezone + INTERVAL '7 days') AT TIME ZONE timezone
         WHEN 'biweekly' THEN (next_occurrence_at AT TIME ZONE timezone + INTERVAL '14 days') AT TIME ZONE timezone
         WHEN 'monthly' THEN (next_occurrence_at AT TIME ZONE timezone + INTERVAL '1 month') AT TIME ZONE timezone
       END),updated_at=NOW() WHERE id=$1`,
    [row.id],
  );
  return {
    success: true,
    data: { outcome: 'generated', taskId, occurrenceId, occurrenceNumber },
  };
}

function generationContext(
  row: ControlledSeriesRow,
  input: GenerateControlledOccurrenceInput,
): GenerationContext {
  const evaluatedAt = input.evaluateAt ?? new Date();
  const scheduledStart = new Date(row.next_occurrence_at);
  const generationKey = `recurring:${row.id}:${row.current_revision_id}:${scheduledStart.toISOString().slice(0, 10)}`;
  return { row, evaluatedAt, scheduledStart, generationKey };
}

async function generateInTransaction(
  query: TaskCreateQuery,
  input: GenerateControlledOccurrenceInput,
): Promise<ServiceResult<ControlledOccurrenceResult>> {
  const locked = await query<ControlledSeriesRow>(
    `SELECT * FROM recurring_task_series WHERE id=$1 AND contract_version >= 2 FOR UPDATE`,
    [input.seriesId],
  );
  const row = locked.rows[0];
  if (!row) return recurringInvalid('Controlled recurring template not found.', 'NOT_FOUND');
  const context = generationContext(row, input);
  const safeguard = await safeguardResult(query, context, input.actorId);
  if (safeguard) return safeguard;
  const replay = await replayResult(query, context.generationKey);
  if (replay) return replay;
  const notDue = notDueResult(context, input.lookaheadHours ?? 24);
  if (notDue) return notDue;
  const completed = await completeAtEndDate(query, context);
  if (completed) return completed;
  const skipped = await skipBlackout(query, context);
  if (skipped) return skipped;
  const approval = await resolveBusinessApproval(query, context, input.actorId);
  if (!approval.proceed) return approval.result;
  return persistOccurrence(query, context, approval.approvalRequestId);
}

export async function generateControlledRecurringOccurrence(
  input: GenerateControlledOccurrenceInput,
): Promise<ServiceResult<ControlledOccurrenceResult>> {
  try {
    return await db.transaction((query) => generateInTransaction(query, input));
  } catch (error) {
    log.error({ err: error, seriesId: input.seriesId }, 'controlled recurring generation failed');
    return {
      success: false,
      error: {
        code: 'RECURRING_GENERATION_FAILED',
        message: 'No recurring occurrence was generated.',
      },
    };
  }
}
