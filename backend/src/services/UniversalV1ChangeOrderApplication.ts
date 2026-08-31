import {
  AuthorizeAndMaterializeUniversalV1ChangeOrderPublicSchema,
  DecideUniversalV1ChangeOrderPublicSchema,
  ProposeUniversalV1ChangeOrderPublicSchema,
  type AuthorizeAndMaterializeUniversalV1ChangeOrderPublic,
  type DecideUniversalV1ChangeOrderPublic,
  type ProposeUniversalV1ChangeOrderPublic,
  UniversalV1ChangeOrderError,
} from './UniversalV1ChangeOrderContracts.js';
import {
  PostgresUniversalV1ChangeOrderRepository,
  type UniversalV1ChangeOrderRepository,
} from './UniversalV1ChangeOrderPostgresRepository.js';
import {
  createUniversalV1FakeFinancialApplicationService,
  type UniversalV1FakeFinancialApplicationService,
} from './payment/UniversalV1FinancialApplicationService.js';

type FinanceAuthorization = () => UniversalV1FakeFinancialApplicationService;

function assertCurrentRequest(clientTimestamp: string, now: () => number): void {
  const timestamp = Date.parse(clientTimestamp);
  if (!Number.isFinite(timestamp) || Math.abs(now() - timestamp) > 5 * 60_000) {
    throw new UniversalV1ChangeOrderError(
      'CHANGE_ORDER_REQUEST_STALE',
      'The change-order request timestamp is outside the allowed window.'
    );
  }
}

/**
 * Application boundary for an unassigned, fake-finance-only Universal V1 Work
 * Order. Actor identity is supplied by authenticated request context and is
 * never accepted in the public command payload.
 */
export class UniversalV1ChangeOrderApplication {
  constructor(
    private readonly repository: UniversalV1ChangeOrderRepository = new PostgresUniversalV1ChangeOrderRepository(),
    private readonly authorizeFinance: FinanceAuthorization = () =>
      createUniversalV1FakeFinancialApplicationService(),
    private readonly now: () => number = Date.now
  ) {}

  async proposeChangeOrder(actorId: string, raw: ProposeUniversalV1ChangeOrderPublic) {
    const input = ProposeUniversalV1ChangeOrderPublicSchema.parse(raw);
    assertCurrentRequest(input.client_ts, this.now);
    return this.repository.proposeChangeOrder(actorId, input);
  }

  async decideChangeOrder(actorId: string, raw: DecideUniversalV1ChangeOrderPublic) {
    const input = DecideUniversalV1ChangeOrderPublicSchema.parse(raw);
    assertCurrentRequest(input.client_ts, this.now);
    return this.repository.decideChangeOrder(actorId, input);
  }

  async authorizeAndMaterializeFakeChangeOrder(
    actorId: string,
    raw: AuthorizeAndMaterializeUniversalV1ChangeOrderPublic
  ) {
    const input = AuthorizeAndMaterializeUniversalV1ChangeOrderPublicSchema.parse(raw);
    assertCurrentRequest(input.client_ts, this.now);

    // Proposal kind is immutable. This read determines whether the fail-closed
    // nonproduction fake-finance gate must be evaluated before the repository
    // opens its caller-owned SERIALIZABLE transaction. The repository rechecks
    // the kind and every authority binding while locked.
    const kind = await this.repository.readFinalizationKind(actorId, input.proposal_id);
    if (!kind) {
      throw new UniversalV1ChangeOrderError(
        'CHANGE_ORDER_CONTEXT_UNAVAILABLE',
        'The change order is unavailable for materialization.'
      );
    }
    if (kind === 'SCHEDULE_AND_SCOPE') {
      throw new UniversalV1ChangeOrderError(
        'CHANGE_ORDER_SCHEDULE_UNSUPPORTED',
        'Structured Work Order schedule amendments are not yet authoritative.'
      );
    }

    if (kind !== 'PRICE_AND_SCOPE') {
      return this.repository.authorizeAndMaterializeFakeChangeOrder(actorId, input);
    }

    // Constructing the independent fake-finance service performs the exact
    // nonproduction, signed-manifest, build-identity, and frozen-money checks.
    // It must happen before Phase A commits a durable change-order command
    // witness. Provider I/O is never performed inside the repository's
    // caller-owned SERIALIZABLE transaction.
    const finance = this.authorizeFinance();
    const phase = await this.repository.preparePriceAndScopeMaterialization(actorId, input);
    if (phase.completed) return phase.result;

    const context = phase.context;
    const adjustment = await finance.executeFinancialEvent({
      providerKind: 'FAKE',
      operationKind: 'ADJUST',
      operationId: context.adjustmentOperationId,
      idempotencyKey: `${phase.idempotencyKey}:adjust`,
      providerExpectedVersion: 0,
      lifecycleExpectedVersion: context.expectedFinancialVersion + 1,
      taskDraftId: context.taskDraftId,
      taskId: context.taskId,
      eligibilityDecisionId: context.eligibilityDecisionId,
      scopeVersionId: context.scopeVersionId,
      predecessorEventId: context.predecessorEventId,
      relatedOperationId: context.predecessorOperationId,
      changeOrderId: context.proposalId,
      amountCents: context.customerTotalCents,
      currency: context.currency.toLowerCase(),
      recordedBy: actorId,
      occurredAt: context.occurredAt,
      scenario: 'SUCCESS',
    });

    return this.repository.finalizePriceAndScopeMaterialization(
      phase,
      adjustment.id,
      actorId
    );
  }
}
