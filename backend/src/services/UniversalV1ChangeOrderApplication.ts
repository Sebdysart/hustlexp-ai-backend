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
  PostgresUniversalV1ChangeOrderMaterialization,
  type UniversalV1ChangeOrderMaterialization,
} from './UniversalV1ChangeOrderMaterialization.js';
import {
  PostgresUniversalV1ChangeOrderHistoryReader,
  type UniversalV1ChangeOrderHistoryReader,
} from './UniversalV1ChangeOrderHistory.js';
import { createUniversalV1FinancialRequestService } from './payment/UniversalV1FinancialRequestService.js';
import {
  resumeUniversalV1ChangeOrder,
  materializedChangeOrder,
  type UniversalV1ChangeOrderRequestFinance,
} from './UniversalV1ChangeOrderResume.js';
import type { UniversalV1ChangeOrderPublicResult } from './UniversalV1ChangeOrderContracts.js';
import type { UniversalV1ActorAttestationHandle } from '../auth/universal-v1-actor-attestation-contracts.js';
import {
  PostgresUniversalV1ChangeOrderCommands,
  type UniversalV1ChangeOrderCommands,
} from './UniversalV1ChangeOrderCommands.js';

type FinanceAuthorization = () =>
  | UniversalV1ChangeOrderRequestFinance
  | Promise<UniversalV1ChangeOrderRequestFinance>;

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
    private readonly materialization: UniversalV1ChangeOrderMaterialization = new PostgresUniversalV1ChangeOrderMaterialization(),
    private readonly authorizeFinance: FinanceAuthorization = () =>
      createUniversalV1FinancialRequestService(),
    private readonly now: () => number = Date.now,
    private readonly commands: UniversalV1ChangeOrderCommands = new PostgresUniversalV1ChangeOrderCommands(),
    private readonly history: UniversalV1ChangeOrderHistoryReader = new PostgresUniversalV1ChangeOrderHistoryReader()
  ) {}
  async proposeChangeOrder(
    actorId: string,
    raw: ProposeUniversalV1ChangeOrderPublic,
    attestation?: UniversalV1ActorAttestationHandle
  ) {
    const input = ProposeUniversalV1ChangeOrderPublicSchema.parse(raw);
    assertCurrentRequest(input.client_ts, this.now);
    if (!attestation)
      throw new UniversalV1ChangeOrderError(
        'CHANGE_ORDER_AUTHORITY_REVOKED',
        'A request-scoped actor attestation is required.'
      );
    return this.commands.propose(actorId, input, attestation);
  }

  async decideChangeOrder(
    actorId: string,
    raw: DecideUniversalV1ChangeOrderPublic,
    attestation?: UniversalV1ActorAttestationHandle
  ) {
    const input = DecideUniversalV1ChangeOrderPublicSchema.parse(raw);
    assertCurrentRequest(input.client_ts, this.now);
    if (!attestation)
      throw new UniversalV1ChangeOrderError(
        'CHANGE_ORDER_AUTHORITY_REVOKED',
        'A request-scoped actor attestation is required.'
      );
    return this.commands.decide(actorId, input, attestation);
  }

  async authorizeAndMaterializeFakeChangeOrder(
    actorId: string,
    raw: AuthorizeAndMaterializeUniversalV1ChangeOrderPublic,
    attestation?: UniversalV1ActorAttestationHandle
  ): Promise<UniversalV1ChangeOrderPublicResult> {
    const input = AuthorizeAndMaterializeUniversalV1ChangeOrderPublicSchema.parse(raw);
    assertCurrentRequest(input.client_ts, this.now);
    if (!attestation)
      throw new UniversalV1ChangeOrderError(
        'CHANGE_ORDER_AUTHORITY_REVOKED',
        'A request-scoped actor attestation is required.'
      );
    const kind = await this.materialization.readKind(actorId, input.proposal_id, attestation);
    if (!kind)
      throw new UniversalV1ChangeOrderError(
        'CHANGE_ORDER_CONTEXT_UNAVAILABLE',
        'The change order is unavailable for materialization.'
      );
    if (kind === 'SCHEDULE_AND_SCOPE')
      throw new UniversalV1ChangeOrderError(
        'CHANGE_ORDER_SCHEDULE_UNSUPPORTED',
        'Structured Work Order schedule amendments are not yet authoritative.'
      );
    if (kind === 'SCOPE_ONLY') {
      const phase = await this.materialization.prepare(actorId, input, attestation);
      if (!phase.completed || phase.result.adjustment_event_id !== null)
        throw new UniversalV1ChangeOrderError(
          'CHANGE_ORDER_STATE_CONFLICT',
          'Scope-only materialization returned an incompatible result.'
        );
      return materializedChangeOrder(phase.result);
    }
    // Authorize the exact fake-only release before committing a price witness.
    const finance = await this.authorizeFinance();
    return resumeUniversalV1ChangeOrder(
      actorId,
      input,
      attestation,
      this.materialization,
      finance,
      this.history
    );
  }
}
