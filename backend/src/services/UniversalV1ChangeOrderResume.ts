import type { UniversalV1ActorAttestationHandle } from '../auth/universal-v1-actor-attestation-contracts.js';
import {
  ChangeOrderHistoryPayloadSchema,
  ChangeOrderHistorySchema,
  changeOrderHistoryMatchesPayload,
  type ChangeOrderHistory,
} from '../auth/change-order-history-command-contract.js';
import { deterministicUuid } from './UniversalV1WorkOrderPostgresRepository.js';
import {
  UniversalV1ChangeOrderError,
  UniversalV1ChangeOrderPublicResultSchema,
  type AuthorizeAndMaterializeUniversalV1ChangeOrderPublic,
  type MaterializedUniversalV1ChangeOrder,
  type UniversalV1ChangeOrderPublicResult,
} from './UniversalV1ChangeOrderContracts.js';
import type { UniversalV1ChangeOrderMaterialization } from './UniversalV1ChangeOrderMaterialization.js';
import type { UniversalV1ChangeOrderHistoryReader } from './UniversalV1ChangeOrderHistory.js';
import type { UniversalV1FinancialRequestService } from './payment/UniversalV1FinancialRequestService.js';
export type UniversalV1ChangeOrderRequestFinance = Pick<
  UniversalV1FinancialRequestService,
  'requestFinancialEvent'
>;
type PendingStatus = 'PENDING' | 'COMPENSATING' | 'RECOVERY_REQUIRED';
type Stage = 'ADJUSTMENT' | 'FINALIZATION' | 'COMPENSATION';
function pending(
  status: PendingStatus,
  stage: Stage,
  retryable = status !== 'RECOVERY_REQUIRED'
): UniversalV1ChangeOrderPublicResult {
  return Object.freeze(
    UniversalV1ChangeOrderPublicResultSchema.parse({
      status,
      stage,
      retry_after_ms: retryable ? 1000 : null,
      payment_creation_performed: false,
      hard_assignment_created: false,
    })
  );
}
export function materializedChangeOrder(
  result: MaterializedUniversalV1ChangeOrder
): UniversalV1ChangeOrderPublicResult {
  return Object.freeze(
    UniversalV1ChangeOrderPublicResultSchema.parse({ status: 'MATERIALIZED', ...result })
  );
}
function refuse(): never {
  throw new UniversalV1ChangeOrderError(
    'CHANGE_ORDER_CONTEXT_UNAVAILABLE',
    'Committed change-order history is unavailable.'
  );
}

/** Each foreground call advances from committed history. It submits at most one
 * durable provider request and never executes provider work itself. */
export async function resumeUniversalV1ChangeOrder(
  actor: string,
  input: AuthorizeAndMaterializeUniversalV1ChangeOrderPublic,
  attestation: UniversalV1ActorAttestationHandle,
  materialization: UniversalV1ChangeOrderMaterialization,
  finance: UniversalV1ChangeOrderRequestFinance,
  historyReader: UniversalV1ChangeOrderHistoryReader
): Promise<UniversalV1ChangeOrderPublicResult> {
  const { client_ts: _currentTime, ...rawPayload } = input;
  const payload = Object.freeze(ChangeOrderHistoryPayloadSchema.parse(rawPayload));
  const read = async () => {
    const found = await historyReader.read(payload, actor, attestation);
    if (found === null) return null;
    const parsed = ChangeOrderHistorySchema.safeParse(found);
    if (
      !parsed.success ||
      !changeOrderHistoryMatchesPayload(parsed.data, payload, actor) ||
      parsed.data.phase.context.adjustmentOperationId !==
        deterministicUuid(payload.idempotency_key, 'adjust')
    )
      return refuse();
    return parsed.data;
  };
  async function advance(
    history: ChangeOrderHistory,
    maySubmit: boolean,
    mayFinalize = true
  ): Promise<UniversalV1ChangeOrderPublicResult> {
    if (history.state === 'COMPLETED') return materializedChangeOrder(history.result);
    if (history.state === 'CANCELLED')
      return Object.freeze(
        UniversalV1ChangeOrderPublicResultSchema.parse({
          status: 'CANCELLED',
          stage: 'COMPENSATION',
          retry_after_ms: null,
          prior_secured_state_restored: false,
          execution_resume_authorized: false,
          capture_resume_authorized: false,
          payment_creation_performed: false,
          hard_assignment_created: false,
        })
      );
    const phase = history.phase,
      c = phase.context;
    if (history.state === 'COMPENSATION_CLAIM') {
      const progress = history.reversalProgress;
      if (progress) {
        // A provider reversal is not the missing immutable domain cancellation fact.
        if (progress.progressState === 'MATERIALIZED')
          return pending('RECOVERY_REQUIRED', 'COMPENSATION');
        return pending(
          progress.progressState === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : 'COMPENSATING',
          'COMPENSATION',
          true
        );
      }
      if (history.reversalRequestState === 'UNADMITTED_HELD' || !maySubmit)
        return pending('RECOVERY_REQUIRED', 'COMPENSATION');
      const claim = history.compensation;
      try {
        await finance.requestFinancialEvent(
          {
            providerKind: 'FAKE',
            operationKind: 'REVERSAL',
            operationId: claim.reversalOperationId,
            idempotencyKey: claim.reversalIdempotencyKey,
            providerExpectedVersion: 0,
            lifecycleExpectedVersion: claim.lifecycleExpectedVersion,
            taskDraftId: c.taskDraftId,
            taskId: c.taskId,
            eligibilityDecisionId: c.eligibilityDecisionId,
            scopeVersionId: claim.baseScopeVersionId,
            predecessorEventId: claim.adjustmentEventId,
            relatedOperationId: c.adjustmentOperationId,
            amountCents: claim.amountCents,
            currency: claim.currency.toLowerCase(),
            recordedBy: actor,
            occurredAt: new Date(claim.createdAt).toISOString(),
            scenario: 'SUCCESS',
          },
          attestation
        );
        return pending('COMPENSATING', 'COMPENSATION');
      } catch {
        const recovered = await read();
        // A recorded claim cannot be replaced with another actor or a new operation.
        if (recovered === null || recovered.state === 'PREPARED')
          return pending('RECOVERY_REQUIRED', 'COMPENSATION');
        return advance(recovered, false, false);
      }
    }
    const progress = history.adjustmentProgress;
    if (progress) {
      if (progress.progressState !== 'MATERIALIZED')
        return pending(
          progress.progressState === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : 'PENDING',
          'ADJUSTMENT',
          true
        );
      const event = progress.financialEvent;
      if (!event || event.status !== 'SUCCEEDED') return pending('RECOVERY_REQUIRED', 'ADJUSTMENT');
      if (!mayFinalize) return pending('RECOVERY_REQUIRED', 'FINALIZATION');
      try {
        return materializedChangeOrder(
          await materialization.finalize(
            actor,
            input,
            phase.requestSha256,
            event.id,
            input.client_ts,
            attestation
          )
        );
      } catch {
        // An ambiguous COMMIT is resolved by a fresh read, never by inferring rollback.
        const recovered = await read();
        if (recovered === null) return pending('RECOVERY_REQUIRED', 'FINALIZATION');
        return advance(recovered, false, false);
      }
    }
    if (
      history.adjustmentRequestState === 'UNADMITTED_HELD' ||
      !maySubmit ||
      !history.predecessorExpiresAt ||
      Date.parse(history.observedAt) >= Date.parse(history.predecessorExpiresAt)
    )
      return pending('RECOVERY_REQUIRED', 'ADJUSTMENT');
    try {
      await finance.requestFinancialEvent(
        {
          providerKind: 'FAKE',
          operationKind: 'ADJUST',
          operationId: c.adjustmentOperationId,
          idempotencyKey: phase.idempotencyKey + ':adjust',
          providerExpectedVersion: 0,
          lifecycleExpectedVersion: c.expectedFinancialVersion + 1,
          taskDraftId: c.taskDraftId,
          taskId: c.taskId,
          eligibilityDecisionId: c.eligibilityDecisionId,
          scopeVersionId: c.scopeVersionId,
          predecessorEventId: c.predecessorEventId,
          relatedOperationId: c.predecessorOperationId,
          changeOrderId: c.proposalId,
          amountCents: c.customerTotalCents,
          currency: c.currency.toLowerCase(),
          recordedBy: actor,
          occurredAt: new Date(c.occurredAt).toISOString(),
          scenario: 'SUCCESS',
        },
        attestation
      );
      return pending('PENDING', 'ADJUSTMENT');
    } catch {
      const recovered = await read();
      if (recovered === null) return pending('RECOVERY_REQUIRED', 'ADJUSTMENT');
      return advance(recovered, false);
    }
  }
  let history = await read();
  if (history !== null) return advance(history, true);
  let prepared;
  try {
    prepared = await materialization.prepare(actor, input, attestation);
  } catch (error) {
    history = await read();
    if (history === null) {
      if (
        error instanceof UniversalV1ChangeOrderError &&
        error.code !== 'CHANGE_ORDER_MATERIALIZATION_FAILED'
      )
        throw error;
      return pending('RECOVERY_REQUIRED', 'ADJUSTMENT');
    }
    return advance(history, false);
  }
  if (prepared.completed) return materializedChangeOrder(prepared.result);
  history = await read();
  if (history === null || history.phase.requestSha256 !== prepared.requestSha256) return refuse();
  return advance(history, true);
}
