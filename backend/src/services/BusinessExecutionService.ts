import { db } from '../db.js';
import { computePlatformFeeCents } from '../lib/money.js';
import { logger } from '../logger.js';
import type { ServiceError, ServiceResult, Task } from '../types.js';
import { ComplianceGuardianService } from './ComplianceGuardianService.js';
import { businessExecutionError } from './BusinessExecutionErrors.js';
import type {
  BusinessInvoiceSnapshotSummary,
  BusinessProviderPerformanceSummary,
  BusinessProviderPreferenceSummary,
  BusinessWorkOrderSummary,
} from './BusinessExecutionTypes.js';
import { TaskCreateService } from './TaskCreateService.js';
import { decryptTaskLocation } from './TaskLocationCrypto.js';
import { TaskRiskClassifier } from './TaskRiskClassifier.js';
import { isCareContent } from './TaskTemplateRegistry.js';

export type {
  BusinessInvoiceSnapshotSummary,
  BusinessProviderPerformanceSummary,
  BusinessProviderPreferenceSummary,
  BusinessWorkOrderSummary,
} from './BusinessExecutionTypes.js';

const log = logger.child({ service: 'BusinessExecutionService' });

class WorkOrderFailure extends Error {
  constructor(readonly serviceError: ServiceError) {
    super(serviceError.message);
  }
}

function failure(error: unknown, fallbackCode: string, fallbackMessage: string): ServiceResult<never> {
  if (error instanceof WorkOrderFailure) return { success: false, error: error.serviceError };
  const message = error instanceof Error ? error.message : '';
  const mappedError = businessExecutionError(message);
  if (mappedError) return { success: false, error: mappedError };
  log.error({ err: message || 'unknown' }, fallbackMessage);
  return { success: false, error: { code: fallbackCode, message: fallbackMessage } };
}

type ApprovedDemandRow = {
  approval_request_id: string;
  canonical_task_id: string | null;
  amount_cents: number;
  service_category: string;
  location_id: string;
  location_name: string;
  rough_location: string;
  region_code: string;
  exact_address_ciphertext: string;
  exact_address_nonce: string;
  exact_address_auth_tag: string;
  exact_address_key_id: string;
  access_ciphertext: string;
  access_nonce: string;
  access_auth_tag: string;
  access_key_id: string;
};

async function loadApprovedDemand(
  query: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string,
  actorId: string,
  approvalRequestId: string,
): Promise<ApprovedDemandRow | null> {
  const result = await query<ApprovedDemandRow>(
    `WITH authority AS (SELECT business_require_action($1,$2,'CREATE_WORK_ORDER'))
     SELECT request.id AS approval_request_id,request.canonical_task_id,request.amount_cents,
            request.service_category,location.id AS location_id,location.name AS location_name,
            location.rough_location,location.region_code,location.exact_address_ciphertext,
            location.exact_address_nonce,location.exact_address_auth_tag,location.exact_address_key_id,
            location.access_ciphertext,location.access_nonce,location.access_auth_tag,
            location.access_key_id
     FROM business_approval_requests request
     JOIN business_locations location ON location.id=request.location_id
     CROSS JOIN authority
     WHERE request.id=$3 AND request.organization_id=$1 AND request.requester_id=$2
       AND request.status IN ('AUTO_APPROVED','APPROVED') AND location.status='ACTIVE'
     FOR UPDATE OF request`,
    [organizationId, actorId, approvalRequestId],
  );
  return result.rows[0] ?? null;
}

export async function createBusinessWorkOrder(input: {
  actorId: string;
  organizationId: string;
  approvalRequestId: string;
  title: string;
  description: string;
  requirements: string | null;
  serviceWindowStart: string;
  serviceWindowEnd: string;
  expectedDurationMinutes: number;
  requiredTools: string[];
  proofChecklist: string[];
  insideHome: boolean;
  peoplePresent: boolean;
  petsPresent: boolean;
  caregiving: boolean;
}): Promise<ServiceResult<{ taskId: string; idempotencyReplayed: boolean }>> {
  try {
    const caregiving = input.caregiving || isCareContent(input.description);
    const templateSlug = caregiving ? 'care' : input.insideHome ? 'in_home' : 'standard_physical';
    const compliance = await ComplianceGuardianService.evaluate({
      description: input.description,
      userId: input.actorId,
      templateSlug,
    });
    if (compliance.tier === 'hard_block') return { success: false, error: {
      code: 'BUSINESS_WORK_ORDER_COMPLIANCE_BLOCKED',
      message: 'This work order cannot be created under HustleXP safety policy.',
    } };
    const riskLevel = TaskRiskClassifier.toLegacyRiskLevel(TaskRiskClassifier.classifyWithTemplate({
      insideHome: input.insideHome,
      peoplePresent: input.peoplePresent,
      petsPresent: input.petsPresent,
      caregiving,
    }, templateSlug, [], compliance));
    const start = new Date(input.serviceWindowStart);
    const end = new Date(input.serviceWindowEnd);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      return { success: false, error: {
        code: 'BUSINESS_SERVICE_WINDOW_INVALID',
        message: 'The service window end must be later than its start.',
      } };
    }

    return await db.transaction(async (query) => {
      const demand = await loadApprovedDemand(
        query, input.organizationId, input.actorId, input.approvalRequestId,
      );
      if (!demand) throw new WorkOrderFailure({
        code: 'BUSINESS_SPEND_NOT_APPROVED',
        message: 'This spend request is not approved for work-order creation.',
      });
      const exactAddress = decryptTaskLocation(demand.location_id, {
        location_ciphertext: demand.exact_address_ciphertext,
        location_nonce: demand.exact_address_nonce,
        location_auth_tag: demand.exact_address_auth_tag,
        location_key_id: demand.exact_address_key_id,
      });
      const access = decryptTaskLocation(`${demand.location_id}:access`, {
        location_ciphertext: demand.access_ciphertext,
        location_nonce: demand.access_nonce,
        location_auth_tag: demand.access_auth_tag,
        location_key_id: demand.access_key_id,
      });
      const platformMarginCents = computePlatformFeeCents(demand.amount_cents);
      const taskResult = await TaskCreateService.createInTransaction(query, {
        posterId: input.actorId,
        title: input.title,
        description: input.description,
        price: demand.amount_cents,
        hustlerPayoutCents: demand.amount_cents - platformMarginCents,
        platformMarginCents,
        requirements: input.requirements ?? 'Follow the approved work-order scope.',
        location: `${exactAddress}\nAccess procedure: ${access}`,
        roughArea: demand.rough_location,
        regionCode: demand.region_code,
        category: demand.service_category,
        deadline: end,
        dispatchExpiresAt: start,
        requiresProof: true,
        riskLevel,
        mode: 'STANDARD',
        instantMode: false,
        templateSlug: 'business-work-order-v1',
        clientIdempotencyKey: `business-work-order:${demand.approval_request_id}`,
        proofSteps: input.proofChecklist,
        estimatedDurationMinutes: input.expectedDurationMinutes,
        requiredTools: input.requiredTools,
        automationClassification: 'PRODUCTION',
      });
      if (!taskResult.success) throw new WorkOrderFailure(taskResult.error);
      const binding = await query<{ canonical_task_id: string; idempotency_replayed: boolean }>(
        `SELECT canonical_task_id,idempotency_replayed
         FROM bind_business_work_order($1,$2,$3,$4)`,
        [input.organizationId, input.actorId, input.approvalRequestId, taskResult.data.id],
      );
      const row = binding.rows[0];
      if (!row) throw new WorkOrderFailure({
        code: 'BUSINESS_WORK_ORDER_BIND_FAILED', message: 'The canonical work order was not bound.',
      });
      return { success: true, data: {
        taskId: row.canonical_task_id,
        idempotencyReplayed: row.idempotency_replayed || Boolean((taskResult.data as Task).idempotency_replayed),
      } };
    });
  } catch (error) {
    return failure(error, 'BUSINESS_WORK_ORDER_FAILED', 'The canonical work order was not created.');
  }
}

export async function setBusinessProviderPreferenceByEmail(input: {
  actorId: string;
  organizationId: string;
  locationId: string | null;
  serviceCategory: string;
  providerEmail: string;
  priority: 'PRIMARY' | 'BACKUP';
}): Promise<ServiceResult<{ id: string; priority: 'PRIMARY' | 'BACKUP' }>> {
  try {
    const result = await db.query<{ preference_id: string; preference_priority: 'PRIMARY' | 'BACKUP' }>(
      `SELECT preference_id,preference_priority
       FROM set_business_provider_preference_by_email($1,$2,$3,$4,$5,$6)`,
      [input.organizationId, input.actorId, input.locationId, input.serviceCategory,
        input.providerEmail.trim().toLowerCase(), input.priority],
    );
    const row = result.rows[0];
    if (!row) return failure(null, 'BUSINESS_PROVIDER_PREFERENCE_FAILED', 'Provider preference was not saved.');
    return { success: true, data: { id: row.preference_id, priority: row.preference_priority } };
  } catch (error) {
    return failure(error, 'BUSINESS_PROVIDER_PREFERENCE_FAILED', 'Provider preference was not saved.');
  }
}

export async function listBusinessProviderPreferences(
  actorId: string,
  organizationId: string,
): Promise<ServiceResult<BusinessProviderPreferenceSummary[]>> {
  try {
    const result = await db.query<{
      id: string; location_id: string | null; location_name: string | null;
      service_category: string; provider_name: string; priority: 'PRIMARY' | 'BACKUP';
    }>(
      `WITH authority AS (SELECT business_require_action($1,$2,'READ_WORKSPACE'))
       SELECT preference.id,preference.location_id,location.name AS location_name,
              preference.service_category,provider.full_name AS provider_name,preference.priority
       FROM business_provider_preferences preference
       JOIN users provider ON provider.id=preference.provider_worker_id
       LEFT JOIN business_locations location ON location.id=preference.location_id
       CROSS JOIN authority
       WHERE preference.organization_id=$1 AND preference.active=TRUE
       ORDER BY preference.priority,preference.updated_at DESC`,
      [organizationId, actorId],
    );
    return { success: true, data: result.rows.map((row) => ({
      id: row.id, locationId: row.location_id, locationName: row.location_name,
      serviceCategory: row.service_category, providerName: row.provider_name,
      priority: row.priority,
    })) };
  } catch (error) {
    return failure(error, 'BUSINESS_PROVIDER_LIST_FAILED', 'Provider preferences could not be loaded.');
  }
}

function iso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export async function listBusinessWorkOrders(
  actorId: string,
  organizationId: string,
): Promise<ServiceResult<BusinessWorkOrderSummary[]>> {
  try {
    const result = await db.query<{
      task_id: string; location_name: string | null; title: string; category: string | null;
      task_state: string; progress_state: string; worker_name: string | null;
      customer_total_cents: number | string; escrow_state: string;
      refunded_cents: number | string; deadline: string | Date | null;
      completed_at: string | Date | null; completed_on_time: boolean | null;
      created_at: string | Date;
    }>(
      `WITH authority AS (SELECT business_require_action($1,$2,'READ_WORKSPACE'))
       SELECT report.* FROM business_work_order_reporting report CROSS JOIN authority
       WHERE report.organization_id=$1 ORDER BY report.created_at DESC LIMIT 200`,
      [organizationId, actorId],
    );
    return { success: true, data: result.rows.map((row) => ({
      taskId: row.task_id, locationName: row.location_name, title: row.title,
      category: row.category, taskState: row.task_state, progressState: row.progress_state,
      workerName: row.worker_name, customerTotalCents: Number(row.customer_total_cents),
      escrowState: row.escrow_state, refundedCents: Number(row.refunded_cents),
      deadline: iso(row.deadline), completedAt: iso(row.completed_at),
      completedOnTime: row.completed_on_time, createdAt: iso(row.created_at)!,
    })) };
  } catch (error) {
    return failure(error, 'BUSINESS_WORK_ORDER_LIST_FAILED', 'Business work orders could not be loaded.');
  }
}

export async function listBusinessProviderPerformance(
  actorId: string,
  organizationId: string,
): Promise<ServiceResult<BusinessProviderPerformanceSummary[]>> {
  try {
    const result = await db.query<{
      provider_name: string; category: string | null; assigned_count: number | string;
      completed_count: number | string; disputed_count: number | string;
      on_time_count: number | string; cancelled_count: number | string;
    }>(
      `WITH authority AS (SELECT business_require_action($1,$2,'READ_WORKSPACE'))
       SELECT report.worker_name AS provider_name,report.category,report.assigned_count,
              report.completed_count,report.disputed_count,report.on_time_count,
              report.cancelled_count
       FROM business_provider_performance_reporting report CROSS JOIN authority
       WHERE report.organization_id=$1 ORDER BY report.completed_count DESC,report.worker_name`,
      [organizationId, actorId],
    );
    return { success: true, data: result.rows.map((row) => ({
      providerName: row.provider_name, category: row.category,
      assignedCount: Number(row.assigned_count), completedCount: Number(row.completed_count),
      disputedCount: Number(row.disputed_count), onTimeCount: Number(row.on_time_count),
      cancelledCount: Number(row.cancelled_count),
    })) };
  } catch (error) {
    return failure(error, 'BUSINESS_PERFORMANCE_LIST_FAILED', 'Provider performance could not be loaded.');
  }
}

export async function createBusinessInvoiceSnapshot(input: {
  actorId: string;
  organizationId: string;
  periodStart: string;
  periodEnd: string;
  grouping: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<ServiceResult<{ id: string; transactionCount: number; settledTotalCents: number }>> {
  try {
    const result = await db.query<{
      invoice_snapshot_id: string; transaction_count: number; settled_total_cents: number | string;
    }>(
      `SELECT invoice_snapshot_id,transaction_count,settled_total_cents
       FROM create_business_invoice_snapshot($1,$2,$3,$4,$5::jsonb,$6)`,
      [input.organizationId, input.actorId, input.periodStart, input.periodEnd,
        JSON.stringify(input.grouping), input.idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) return failure(null, 'BUSINESS_INVOICE_FAILED', 'The billing snapshot was not created.');
    return { success: true, data: {
      id: row.invoice_snapshot_id, transactionCount: row.transaction_count,
      settledTotalCents: Number(row.settled_total_cents),
    } };
  } catch (error) {
    return failure(error, 'BUSINESS_INVOICE_FAILED', 'The billing snapshot was not created.');
  }
}

export async function listBusinessInvoiceSnapshots(
  actorId: string,
  organizationId: string,
): Promise<ServiceResult<BusinessInvoiceSnapshotSummary[]>> {
  try {
    const result = await db.query<{
      id: string; period_start: string | Date; period_end: string | Date;
      transaction_count: number; customer_total_cents: number | string;
      refunded_total_cents: number | string; settled_total_cents: number | string;
      status: 'SNAPSHOT'; created_at: string | Date;
    }>(
      `WITH authority AS (SELECT business_require_action($1,$2,'VIEW_BILLING'))
       SELECT snapshot.id,snapshot.period_start,snapshot.period_end,snapshot.transaction_count,
              snapshot.customer_total_cents,snapshot.refunded_total_cents,
              snapshot.settled_total_cents,snapshot.status,snapshot.created_at
       FROM business_invoice_snapshots snapshot CROSS JOIN authority
       WHERE snapshot.organization_id=$1 ORDER BY snapshot.created_at DESC LIMIT 100`,
      [organizationId, actorId],
    );
    return { success: true, data: result.rows.map((row) => ({
      id: row.id, periodStart: iso(row.period_start)!, periodEnd: iso(row.period_end)!,
      transactionCount: row.transaction_count, customerTotalCents: Number(row.customer_total_cents),
      refundedTotalCents: Number(row.refunded_total_cents),
      settledTotalCents: Number(row.settled_total_cents), status: row.status,
      createdAt: iso(row.created_at)!,
    })) };
  } catch (error) {
    return failure(error, 'BUSINESS_INVOICE_LIST_FAILED', 'Billing snapshots could not be loaded.');
  }
}
