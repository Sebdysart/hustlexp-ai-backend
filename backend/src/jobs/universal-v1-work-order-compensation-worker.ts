import { randomUUID } from 'node:crypto';

import { db, type Database } from '../db.js';
import type { WorkOrderCompensationCommand } from '../services/UniversalV1WorkOrderPostgresRepository.js';
import {
  createUniversalV1FakeFinancialApplicationService,
  type RecordedUniversalV1FinancialEvent,
  type UniversalV1FakeFinancialApplicationService,
} from '../services/payment/UniversalV1FinancialApplicationService.js';

interface WorkOrderCompensationCommandRow
  extends Omit<WorkOrderCompensationCommand, 'amount_cents' | 'created_at'> {
  amount_cents: string | number;
  created_at: string | Date;
}

export interface UniversalV1WorkOrderCompensationRepository {
  claimDue(limit: number, minimumAgeSeconds: number): Promise<readonly WorkOrderCompensationCommand[]>;
}

export class PostgresUniversalV1WorkOrderCompensationRepository
  implements UniversalV1WorkOrderCompensationRepository {
  constructor(private readonly database: Database = db) {}

  async claimDue(
    limit: number,
    minimumAgeSeconds: number
  ): Promise<readonly WorkOrderCompensationCommand[]> {
    const result = await this.database.query<WorkOrderCompensationCommandRow>(
      `SELECT compensation_command_id,work_order_idempotency_key,task_draft_id,
              task_id,scope_version_id,eligibility_decision_id,secured_event_id,
              secured_operation_id,void_operation_id,void_idempotency_key,
              amount_cents,currency,requested_by,created_at
         FROM public.claim_universal_v1_work_order_compensations($1,$2)`,
      [limit, minimumAgeSeconds]
    );
    return result.rows.map((row) => ({
      ...row,
      amount_cents: Number(row.amount_cents),
      created_at: new Date(row.created_at).toISOString(),
    }));
  }
}

type CompensationFinance = Pick<
  UniversalV1FakeFinancialApplicationService,
  'executeFinancialEvent'
>;

export async function executeUniversalV1WorkOrderCompensation(
  finance: CompensationFinance,
  command: WorkOrderCompensationCommand,
  occurredAt: string = new Date().toISOString()
): Promise<RecordedUniversalV1FinancialEvent> {
  const result = await finance.executeFinancialEvent({
    providerKind: 'FAKE',
    providerExpectedVersion: 0,
    operationKind: 'VOID',
    operationId: command.void_operation_id,
    idempotencyKey: command.void_idempotency_key,
    lifecycleExpectedVersion: 3,
    taskDraftId: command.task_draft_id,
    taskId: command.task_id,
    eligibilityDecisionId: command.eligibility_decision_id,
    scopeVersionId: command.scope_version_id,
    predecessorEventId: command.secured_event_id,
    relatedOperationId: command.secured_operation_id,
    amountCents: command.amount_cents,
    currency: command.currency.toLowerCase(),
    recordedBy: command.requested_by,
    scenario: 'SUCCESS',
    occurredAt,
  });
  if (
    result.operationId !== command.void_operation_id
    || result.eventKind !== 'VOIDED'
    || result.status !== 'SUCCEEDED'
    || result.providerKind !== 'FAKE'
    || result.taskDraftId !== command.task_draft_id
    || result.taskId !== command.task_id
    || result.eligibilityDecisionId !== command.eligibility_decision_id
    || result.scopeVersionId !== command.scope_version_id
    || result.predecessorEventId !== command.secured_event_id
    || result.amountCents !== command.amount_cents
    || result.currency !== command.currency
  ) {
    throw new Error('WORK_ORDER_COMPENSATION_RESULT_IDENTITY_MISMATCH');
  }
  return result;
}

export interface UniversalV1WorkOrderCompensationRunResult {
  readonly claimed: number;
  readonly voided: number;
  readonly replayed: number;
  readonly failed: number;
}

export class UniversalV1WorkOrderCompensationWorker {
  constructor(
    private readonly repository: UniversalV1WorkOrderCompensationRepository =
      new PostgresUniversalV1WorkOrderCompensationRepository(),
    private readonly createFinance: () => CompensationFinance = () =>
      createUniversalV1FakeFinancialApplicationService()
  ) {}

  async runOnce(
    limit: number = 25,
    minimumAgeSeconds: number = 30
  ): Promise<UniversalV1WorkOrderCompensationRunResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('WORK_ORDER_COMPENSATION_LIMIT_INVALID');
    }
    if (
      !Number.isInteger(minimumAgeSeconds)
      || minimumAgeSeconds < 5
      || minimumAgeSeconds > 3_600
    ) {
      throw new Error('WORK_ORDER_COMPENSATION_AGE_INVALID');
    }
    // Factory construction is the nonproduction fake-finance capability gate.
    // It precedes even the durable claim so production cannot acquire recovery
    // commands or perform provider I/O through this worker.
    const finance = this.createFinance();
    const commands = await this.repository.claimDue(limit, minimumAgeSeconds);
    let voided = 0;
    let replayed = 0;
    let failed = 0;
    for (const command of commands) {
      try {
        const result = await executeUniversalV1WorkOrderCompensation(finance, command);
        if (result.idempotencyReplayed) replayed += 1;
        else voided += 1;
      } catch {
        // UNKNOWN and persistence failures remain represented by the durable
        // provider command journal and immutable compensation claim. The next
        // pass uses the same exact key through the coordinator; it never invents
        // a second provider command or directly redispatches an UNKNOWN outcome.
        failed += 1;
      }
    }
    return { claimed: commands.length, voided, replayed, failed };
  }
}

export interface UniversalV1WorkOrderCompensationPollerDependencies {
  readonly worker: Pick<UniversalV1WorkOrderCompensationWorker, 'runOnce'>;
  readonly assertAuthorized: () => void;
}

export interface UniversalV1WorkOrderCompensationPollerHealth {
  readonly status: 'healthy' | 'degraded' | 'stopped';
  readonly inFlight: boolean;
  readonly consecutiveFailures: number;
  readonly lastFailureCode: string | null;
}

export interface UniversalV1WorkOrderCompensationPollerHandle {
  readonly workerId: string;
  readonly interval: NodeJS.Timeout;
  health(): UniversalV1WorkOrderCompensationPollerHealth;
  stop(): Promise<void>;
}

export function startUniversalV1WorkOrderCompensationPoller(
  intervalMs: number,
  dependencies: UniversalV1WorkOrderCompensationPollerDependencies,
  options: { readonly workerId?: string } = {}
): UniversalV1WorkOrderCompensationPollerHandle {
  if (!Number.isInteger(intervalMs) || intervalMs < 500 || intervalMs > 60_000) {
    throw new Error('WORK_ORDER_COMPENSATION_INTERVAL_INVALID');
  }
  dependencies.assertAuthorized();
  const workerId = options.workerId ?? `work-order-compensation:${randomUUID()}`;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let consecutiveFailures = 0;
  let lastFailureCode: string | null = null;

  const tick = (): Promise<void> => {
    if (stopped || inFlight) return inFlight ?? Promise.resolve();
    inFlight = Promise.resolve()
      .then(() => {
        dependencies.assertAuthorized();
        return dependencies.worker.runOnce();
      })
      .then((result) => {
        if (result.failed > 0) throw new Error('WORK_ORDER_COMPENSATION_BATCH_INCOMPLETE');
        consecutiveFailures = 0;
        lastFailureCode = null;
      })
      .catch((error: unknown) => {
        consecutiveFailures += 1;
        lastFailureCode = error instanceof Error
          && error.message === 'WORK_ORDER_COMPENSATION_BATCH_INCOMPLETE'
          ? 'BATCH_INCOMPLETE'
          : 'BATCH_FAILED';
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  void tick();
  const interval = setInterval(() => {
    void tick();
  }, intervalMs);
  return {
    workerId,
    interval,
    health: () => ({
      status: stopped ? 'stopped' : consecutiveFailures > 0 ? 'degraded' : 'healthy',
      inFlight: inFlight !== null,
      consecutiveFailures,
      lastFailureCode,
    }),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      await inFlight;
    },
  };
}
