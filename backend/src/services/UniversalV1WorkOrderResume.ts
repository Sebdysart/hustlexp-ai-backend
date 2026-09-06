import { UniversalV1WorkOrderPublicResultSchema } from './UniversalV1WorkOrderContracts.js';
import type { UniversalV1ActorAttestationHandle } from '../auth/universal-v1-actor-attestation-contracts.js';
import { clientTimestampEpochMs } from '../auth/universal-v1-actor-attestation-contracts.js';
import type {
  FinancialPredecessor,
  FinancialPredecessorFacts,
} from '../auth/financial-predecessor-command-contract.js';
import type {
  WorkOrderHistory,
  WorkOrderHistoryPayload,
} from '../auth/work-order-history-command-contract.js';
import {
  deterministicUuid,
  type PostgresUniversalV1WorkOrderRepository,
  type WorkOrderMaterializationPhase,
  type WorkOrderResult,
} from './UniversalV1WorkOrderPostgresRepository.js';
import type {
  MaterializeWorkOrderPublic,
  UniversalV1WorkOrderPublicResult,
} from './UniversalV1WorkOrderContracts.js';
import type { UniversalV1WorkOrderHistoryReader } from './UniversalV1WorkOrderHistory.js';
import type { UniversalV1FinancialRequestService } from './payment/UniversalV1FinancialRequestService.js';
import type { ExecuteUniversalV1FinancialEventCommand } from './payment/UniversalV1FinancialApplicationService.js';

export type UniversalV1WorkOrderRequestFinance = Pick<
  UniversalV1FinancialRequestService,
  'requestFinancialEvent' | 'readPredecessor'
>;
type Prepared = Extract<WorkOrderMaterializationPhase, { completed: false }>;
type PendingStatus = Exclude<UniversalV1WorkOrderPublicResult['status'], 'MATERIALIZED'>;
type Stage = 'PAYMENT_SETUP' | 'PAYMENT_AUTHORIZATION' | 'FINANCIAL_SECURITY' | 'COMPENSATION';
type Repository = Pick<
  PostgresUniversalV1WorkOrderRepository,
  'prepareMaterialization' | 'finalizeMaterialization' | 'claimMaterializationCompensation'
>;
const steps = [
  {
    kind: 'PREPARE_PAYMENT_METHOD',
    label: 'prepare',
    suffix: 'prep',
    stage: 'PAYMENT_SETUP',
    version: 0,
  },
  {
    kind: 'AUTHORIZE',
    label: 'authorize',
    suffix: 'auth',
    stage: 'PAYMENT_AUTHORIZATION',
    version: 1,
  },
  { kind: 'SECURE', label: 'secure', suffix: 'secure', stage: 'FINANCIAL_SECURITY', version: 2 },
] as const;
function pending(
  status: PendingStatus,
  stage: Stage,
  retryable = status === 'PENDING' || status === 'COMPENSATING'
): UniversalV1WorkOrderPublicResult {
  return Object.freeze(
    UniversalV1WorkOrderPublicResultSchema.parse({
      status,
      stage,
      retry_after_ms: retryable ? 1_000 : null,
      hard_assignment_created: false,
      payment_creation_performed: false,
    })
  );
}
function completed(result: WorkOrderResult): UniversalV1WorkOrderPublicResult {
  return Object.freeze({ status: 'MATERIALIZED' as const, ...result });
}
function refuse(): never {
  throw new Error('WORK_ORDER_RESUME_HISTORY_UNAVAILABLE');
}
function normalizeTime(value: string, offset = 0): string {
  return new Date(Date.parse(value) + offset).toISOString();
}

function exactPredecessor(
  facts: FinancialPredecessorFacts,
  phase: Prepared,
  step: (typeof steps)[number],
  previous: FinancialPredecessor | null
): FinancialPredecessor | null {
  const event = facts.predecessor,
    c = phase.context;
  if (event === null) return null;
  if (
    event.operationKind !== step.kind ||
    event.operationId !== deterministicUuid(phase.idempotencyKey, step.label) ||
    event.idempotencyKey !== phase.idempotencyKey + ':' + step.suffix ||
    event.lifecycleExpectedVersion !== step.version ||
    event.taskDraftId !== c.task_draft_id ||
    event.taskId !== c.task_id ||
    event.scopeVersionId !== c.scope_version_id ||
    event.eligibilityDecisionId !== c.eligibility_decision_id ||
    event.predecessorEventId !== (previous?.financialEventId ?? null) ||
    (step.version > 0 &&
      (event.amountCents !== c.customer_total_cents || event.currency !== c.currency))
  )
    return refuse();
  return event;
}

/** A foreground request advances only from committed history. Each new command
 * obtains its own fresh human assertion; workers execute only admitted requests. */
export async function resumeUniversalV1WorkOrder(
  actor: string,
  input: MaterializeWorkOrderPublic,
  attestation: UniversalV1ActorAttestationHandle,
  repo: Repository,
  finance: UniversalV1WorkOrderRequestFinance,
  historyReader: UniversalV1WorkOrderHistoryReader
): Promise<UniversalV1WorkOrderPublicResult> {
  const payload: WorkOrderHistoryPayload = {
    conditional_hold_id: input.conditional_hold_id,
    expected_eligibility_version: input.expected_eligibility_version,
    idempotency_key: input.idempotency_key,
  };
  const readHistory = () => historyReader.read(payload, actor, attestation);
  async function compensate(
    history: Extract<WorkOrderHistory, { state: 'COMPENSATION_CLAIM' }>
  ): Promise<UniversalV1WorkOrderPublicResult> {
    const progress = history.voidProgress;
    if (progress !== null) {
      if (progress.progressState === 'MATERIALIZED')
        return pending(
          progress.financialEvent?.status === 'SUCCEEDED' ? 'COMPENSATED' : 'RECOVERY_REQUIRED',
          'COMPENSATION'
        );
      return pending(
        progress.progressState === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : 'COMPENSATING',
        'COMPENSATION',
        true
      );
    }
    const claim = history.compensation;
    await finance.requestFinancialEvent(
      {
        providerKind: 'FAKE',
        providerExpectedVersion: 0,
        operationKind: 'VOID',
        operationId: claim.void_operation_id,
        idempotencyKey: claim.void_idempotency_key,
        lifecycleExpectedVersion: 3,
        taskDraftId: claim.task_draft_id,
        taskId: claim.task_id,
        eligibilityDecisionId: claim.eligibility_decision_id,
        scopeVersionId: claim.scope_version_id,
        predecessorEventId: claim.secured_event_id,
        relatedOperationId: claim.secured_operation_id,
        amountCents: claim.amount_cents,
        currency: claim.currency.toLowerCase(),
        recordedBy: actor,
        scenario: 'SUCCESS',
        occurredAt: normalizeTime(claim.created_at),
      },
      attestation
    );
    return pending('COMPENSATING', 'COMPENSATION');
  }

  let history = await readHistory();
  if (history?.state === 'COMPLETED') return completed(history.result);
  if (history?.state === 'COMPENSATION_CLAIM') return compensate(history);
  if (history === null) {
    const assertion = await attestation.issue({
      commandKind: 'PREPARE_FAKE_WORK_ORDER',
      commandPayload: {
        ...payload,
        client_timestamp_epoch_ms: clientTimestampEpochMs(input.client_ts),
      },
    });
    const prepared = await repo.prepareMaterialization(
      {
        conditional_hold_id: input.conditional_hold_id,
        eligibility_version: input.expected_eligibility_version,
      },
      input.idempotency_key,
      assertion.actor_assertion_token,
      input.client_ts
    );
    if (prepared.completed) return completed(prepared.result);
    // Observe committed history using the database clock before issuing finance.
    history = await readHistory();
    if (history?.state === 'COMPLETED') return completed(history.result);
    if (history?.state === 'COMPENSATION_CLAIM') return compensate(history);
    if (history === null || history.phase.requestSha256 !== prepared.requestSha256) return refuse();
  }
  const phase = history.phase,
    c = phase.context,
    observedAt = Date.parse(history.observedAt);
  if (
    phase.idempotencyKey !== input.idempotency_key ||
    c.poster_user_id !== actor ||
    c.conditional_hold_id !== input.conditional_hold_id ||
    c.eligibility_version !== input.expected_eligibility_version
  )
    return refuse();
  let previous: FinancialPredecessor | null = null;
  for (const step of steps) {
    const selector = {
      operationKind: step.kind,
      operationId: deterministicUuid(phase.idempotencyKey, step.label),
      taskDraftId: c.task_draft_id,
      idempotencyKey: phase.idempotencyKey + ':' + step.suffix,
    };
    const facts = await finance.readPredecessor(selector, actor, attestation);
    if (facts !== null) {
      const fact = exactPredecessor(facts, phase, step, previous);
      if (fact !== null) {
        previous = fact;
        continue;
      }
      const event = facts.progress.financialEvent;
      if (event !== null)
        return pending(
          step.kind === 'SECURE'
            ? 'RECOVERY_REQUIRED'
            : event.status === 'DECLINED'
              ? 'DECLINED'
              : 'FAILED',
          step.stage
        );
      return pending(
        facts.progress.progressState === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : 'PENDING',
        step.stage,
        true
      );
    }
    // Reading an old witness never renews its hold, eligibility or security.
    if (
      observedAt >= Date.parse(c.hold_expires_at) ||
      observedAt >= Date.parse(c.eligibility_valid_until) ||
      (step.kind === 'SECURE' &&
        (!previous?.expiresAt || observedAt >= Date.parse(previous.expiresAt)))
    ) {
      return pending('RECOVERY_REQUIRED', step.stage);
    }
    const common = {
      ...selector,
      providerKind: 'FAKE' as const,
      providerExpectedVersion: 0,
      taskId: c.task_id,
      eligibilityDecisionId: c.eligibility_decision_id,
      scopeVersionId: c.scope_version_id,
      lifecycleExpectedVersion: step.version,
      recordedBy: actor,
      scenario: 'SUCCESS' as const,
      occurredAt: normalizeTime(phase.occurredAt, step.version),
    };
    let command: ExecuteUniversalV1FinancialEventCommand;
    if (step.kind === 'PREPARE_PAYMENT_METHOD')
      command = { ...common, operationKind: step.kind, customerId: actor };
    else {
      if (!previous) return refuse();
      command = {
        ...common,
        operationKind: step.kind,
        predecessorEventId: previous.financialEventId,
        relatedOperationId: previous.operationId,
        amountCents: c.customer_total_cents,
        currency: c.currency.toLowerCase(),
        ...(step.kind === 'AUTHORIZE'
          ? { paymentMethodReference: previous.externalReference! }
          : { authorizationOperationId: previous.operationId }),
      };
    }
    await finance.requestFinancialEvent(command, attestation);
    return pending('PENDING', step.stage);
  }
  if (!previous || previous.operationKind !== 'SECURE') return refuse();
  try {
    const assertion = await attestation.issue({
      commandKind: 'MATERIALIZE_FAKE_WORK_ORDER',
      commandPayload: {
        idempotency_key: phase.idempotencyKey,
        request_sha256: phase.requestSha256,
        secured_event_id: previous.financialEventId,
      },
    });
    return completed(
      await repo.finalizeMaterialization(
        phase,
        previous.financialEventId,
        assertion.actor_assertion_token
      )
    );
  } catch {
    // Resolve an ambiguous COMMIT before claiming compensation. A completed
    // Work Order or existing claim wins, even if the hold has since expired.
    const recovered = await readHistory();
    if (recovered?.state === 'COMPLETED') return completed(recovered.result);
    if (recovered?.state === 'COMPENSATION_CLAIM') return compensate(recovered);
    if (recovered === null) return refuse();
    const assertion = await attestation.issue({
      commandKind: 'REQUEST_FAKE_WORK_ORDER_RECOVERY',
      commandPayload: {
        idempotency_key: phase.idempotencyKey,
        request_sha256: phase.requestSha256,
        secured_event_id: previous.financialEventId,
      },
    });
    const resolution = await repo.claimMaterializationCompensation(
      phase,
      previous.financialEventId,
      assertion.actor_assertion_token
    );
    if (resolution.completed) return completed(resolution.result);
    const claimed = await readHistory();
    if (claimed?.state === 'COMPLETED') return completed(claimed.result);
    if (claimed?.state !== 'COMPENSATION_CLAIM') return refuse();
    return compensate(claimed);
  }
}
