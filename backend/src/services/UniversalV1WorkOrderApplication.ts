import {
  type ExpressInterestPublic,
  type MaterializeWorkOrderPublic,
  type PlaceHoldPublic,
  type UniversalV1WorkOrderPublicResult,
  UniversalV1WorkOrderError,
} from './UniversalV1WorkOrderContracts.js';
import {
  clientTimestampEpochMs,
  type UniversalV1ActorAttestationHandle,
} from '../auth/universal-v1-actor-attestation-contracts.js';
import { PostgresUniversalV1WorkOrderRepository } from './UniversalV1WorkOrderPostgresRepository.js';
import { PostgresUniversalV1WorkOrderPublicFactReader } from './UniversalV1WorkOrderPublicFacts.js';
import { createUniversalV1FinancialRequestService } from './payment/UniversalV1FinancialRequestService.js';
import {
  PostgresUniversalV1WorkOrderHistoryReader,
  type UniversalV1WorkOrderHistoryReader,
} from './UniversalV1WorkOrderHistory.js';
import {
  resumeUniversalV1WorkOrder,
  type UniversalV1WorkOrderRequestFinance,
} from './UniversalV1WorkOrderResume.js';

function current(ts: string) {
  const d = Date.parse(ts),
    n = Date.now();
  if (!Number.isFinite(d) || Math.abs(n - d) > 5 * 60_000)
    throw new UniversalV1WorkOrderError('WORK_ORDER_REQUEST_STALE', 'Request timestamp is stale.');
}

function exactAttestation(
  value: UniversalV1ActorAttestationHandle | undefined
): UniversalV1ActorAttestationHandle {
  if (!value) {
    throw new UniversalV1WorkOrderError(
      'WORK_ORDER_AUTHORITY_REVOKED',
      'A request-scoped actor attestation is required.'
    );
  }
  return value;
}

export class UniversalV1WorkOrderApplication {
  constructor(
    private readonly facts = new PostgresUniversalV1WorkOrderPublicFactReader(),
    private readonly repo = new PostgresUniversalV1WorkOrderRepository(),
    private readonly createFinance: () =>
      | UniversalV1WorkOrderRequestFinance
      | Promise<UniversalV1WorkOrderRequestFinance> = () =>
      createUniversalV1FinancialRequestService(),
    private readonly history: UniversalV1WorkOrderHistoryReader = new PostgresUniversalV1WorkOrderHistoryReader()
  ) {}
  async expressProviderInterest(
    actor: string,
    input: ExpressInterestPublic,
    actorAttestation?: UniversalV1ActorAttestationHandle
  ) {
    current(input.client_ts);
    const c = await this.facts.interest(actor, input.task_id);
    if (!c)
      throw new UniversalV1WorkOrderError(
        'WORK_ORDER_CONTEXT_UNAVAILABLE',
        'Interest context unavailable.'
      );
    if (c.scope_version !== input.expected_scope_version)
      throw new UniversalV1WorkOrderError('WORK_ORDER_VERSION_CONFLICT', 'Scope version changed.');
    const assertion = await exactAttestation(actorAttestation).issue({
      commandKind: 'EXPRESS_POST_ESTIMATE_INTEREST',
      commandPayload: {
        task_id: input.task_id,
        expected_scope_version: input.expected_scope_version,
        idempotency_key: input.idempotency_key,
        client_timestamp_epoch_ms: clientTimestampEpochMs(input.client_ts),
      },
    });
    return this.repo.express(
      c,
      assertion.actor_assertion_token,
      input.idempotency_key,
      input.client_ts
    );
  }
  async placeConditionalHold(
    actor: string,
    input: PlaceHoldPublic,
    actorAttestation?: UniversalV1ActorAttestationHandle
  ) {
    current(input.client_ts);
    const c = await this.facts.hold(actor, input.interest_application_id);
    if (!c)
      throw new UniversalV1WorkOrderError(
        'WORK_ORDER_CONTEXT_UNAVAILABLE',
        'Hold context unavailable.'
      );
    if (c.eligibility_version !== input.expected_eligibility_version)
      throw new UniversalV1WorkOrderError(
        'WORK_ORDER_VERSION_CONFLICT',
        'Eligibility version changed.'
      );
    const assertion = await exactAttestation(actorAttestation).issue({
      commandKind: 'PLACE_CONDITIONAL_HOLD',
      commandPayload: {
        interest_application_id: input.interest_application_id,
        expected_eligibility_version: input.expected_eligibility_version,
        idempotency_key: input.idempotency_key,
        client_timestamp_epoch_ms: clientTimestampEpochMs(input.client_ts),
      },
    });
    return this.repo.hold(
      c,
      assertion.actor_assertion_token,
      input.idempotency_key,
      input.client_ts
    );
  }
  async secureAndMaterializeFakeWorkOrder(
    actor: string,
    input: MaterializeWorkOrderPublic,
    actorAttestation?: UniversalV1ActorAttestationHandle
  ): Promise<UniversalV1WorkOrderPublicResult> {
    current(input.client_ts);
    // Authorize the exact fake-only runtime before any Phase A witness write.
    const finance = await this.createFinance();
    return resumeUniversalV1WorkOrder(
      actor,
      input,
      exactAttestation(actorAttestation),
      this.repo,
      finance,
      this.history
    );
  }
}
