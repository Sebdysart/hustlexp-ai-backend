import { z } from 'zod';
import { db, type Database } from '../db.js';
import {
  UniversalV1ActorAttestationResponseSchema,
  type UniversalV1ActorAttestationHandle,
  type UniversalV1ActorCommand,
} from '../auth/universal-v1-actor-attestation-contracts.js';
import { FinancialProgressUuidSchema as uuid } from '../auth/financial-progress-command-contract.js';
import { freezeChangeOrderCommand } from '../auth/change-order-command-contract.js';
import {
  ChangeOrderKindPayloadSchema,
  ChangeOrderKindResultSchema,
  PrepareChangeOrderPayloadSchema,
  FinalizeChangeOrderPayloadSchema,
  ChangeOrderMaterializationPhaseSchema,
  MaterializedChangeOrderResultSchema,
  changeOrderResultMatchesInput,
} from '../auth/change-order-materialization-command-contract.js';
import {
  AuthorizeAndMaterializeUniversalV1ChangeOrderPublicSchema,
  type AuthorizeAndMaterializeUniversalV1ChangeOrderPublic,
  type MaterializedUniversalV1ChangeOrder,
  UniversalV1ChangeOrderError,
  type UniversalV1ChangeOrderErrorCode,
} from './UniversalV1ChangeOrderContracts.js';
import type { PriceAndScopeChangeOrderMaterializationPhase } from './UniversalV1ChangeOrderPostgresRepository.js';
import { deterministicUuid } from './UniversalV1WorkOrderPostgresRepository.js';
import { authorizedUniversalV1FinancialApiRelease } from './payment/UniversalV1FinancialRequestService.js';
import type { FinancialProviderCommandReleaseEvidence } from './payment/FinancialProviderCommandJournal.js';

const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .refine((value) => value !== '0'.repeat(64));
const receiptSchema = z
  .object({
    result: z.unknown(),
    actor_user_id: uuid,
    actor_assertion_id: uuid,
    actor_request_sha256: digest,
    target_authority_id: uuid,
    command_release_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();
const codes: readonly UniversalV1ChangeOrderErrorCode[] = [
  'CHANGE_ORDER_CONTEXT_UNAVAILABLE',
  'CHANGE_ORDER_REQUEST_STALE',
  'CHANGE_ORDER_VERSION_CONFLICT',
  'CHANGE_ORDER_IDEMPOTENCY_CONFLICT',
  'CHANGE_ORDER_AUTHORITY_REVOKED',
  'CHANGE_ORDER_INDEPENDENT_APPROVAL_REQUIRED',
  'CHANGE_ORDER_STATE_CONFLICT',
  'CHANGE_ORDER_SCHEDULE_UNSUPPORTED',
  'CHANGE_ORDER_SCOPE_HASH_MISMATCH',
  'CHANGE_ORDER_FAKE_FINANCE_ONLY',
  'CHANGE_ORDER_HARD_ASSIGNMENT_FORBIDDEN',
];
function refuse(
  code: UniversalV1ChangeOrderErrorCode = 'CHANGE_ORDER_MATERIALIZATION_FAILED'
): never {
  throw new UniversalV1ChangeOrderError(
    code,
    'The change-order materialization command was refused.'
  );
}
export interface UniversalV1ChangeOrderMaterialization {
  readKind(
    actor: string,
    proposalId: string,
    attestation: UniversalV1ActorAttestationHandle
  ): Promise<z.infer<typeof ChangeOrderKindResultSchema>>;
  prepare(
    actor: string,
    input: AuthorizeAndMaterializeUniversalV1ChangeOrderPublic,
    attestation: UniversalV1ActorAttestationHandle
  ): Promise<PriceAndScopeChangeOrderMaterializationPhase>;
  finalize(
    actor: string,
    input: AuthorizeAndMaterializeUniversalV1ChangeOrderPublic,
    phaseRequestSha256: string,
    adjustmentEventId: string,
    clientTimestamp: string,
    attestation: UniversalV1ActorAttestationHandle
  ): Promise<MaterializedUniversalV1ChangeOrder>;
}

/** Domain writes commit only after their typed receipt and, where applicable,
 * exact financial release authority are validated. Provider work is separate. */
export class PostgresUniversalV1ChangeOrderMaterialization implements UniversalV1ChangeOrderMaterialization {
  constructor(
    private readonly database: Database = db,
    private readonly authorize: () => FinancialProviderCommandReleaseEvidence = authorizedUniversalV1FinancialApiRelease
  ) {}
  readKind(actor: string, proposalId: string, attestation: UniversalV1ActorAttestationHandle) {
    const payload = Object.freeze(ChangeOrderKindPayloadSchema.parse({ proposal_id: proposalId }));
    return this.invoke(
      actor,
      { commandKind: 'READ_FAKE_CHANGE_ORDER_KIND', commandPayload: payload },
      'public.hxos_read_authenticated_change_order_kind_v13',
      ChangeOrderKindResultSchema,
      () => true,
      () => false,
      attestation
    );
  }
  prepare(
    actor: string,
    raw: AuthorizeAndMaterializeUniversalV1ChangeOrderPublic,
    attestation: UniversalV1ActorAttestationHandle
  ): Promise<PriceAndScopeChangeOrderMaterializationPhase> {
    const { client_ts, ...input } =
      AuthorizeAndMaterializeUniversalV1ChangeOrderPublicSchema.parse(raw);
    const payload = Object.freeze(
      PrepareChangeOrderPayloadSchema.parse({
        ...input,
        client_timestamp_epoch_ms: Date.parse(client_ts),
      })
    );
    return this.invoke(
      actor,
      { commandKind: 'PREPARE_FAKE_CHANGE_ORDER', commandPayload: payload },
      'public.hxos_prepare_authenticated_change_order_v13',
      ChangeOrderMaterializationPhaseSchema,
      (phase) => {
        if (phase.completed) return changeOrderResultMatchesInput(phase.result, payload);
        return (
          phase.idempotencyKey === payload.idempotency_key &&
          phase.context.proposalId === payload.proposal_id &&
          phase.context.scopeVersion === payload.expected_scope_version + 1 &&
          phase.context.expectedFinancialVersion === payload.expected_financial_version &&
          phase.context.adjustmentOperationId ===
            deterministicUuid(payload.idempotency_key, 'adjust')
        );
      },
      (phase) => !phase.completed || phase.result.adjustment_event_id !== null,
      attestation
    );
  }
  finalize(
    actor: string,
    raw: AuthorizeAndMaterializeUniversalV1ChangeOrderPublic,
    phaseRequestSha256: string,
    adjustmentEventId: string,
    clientTimestamp: string,
    attestation: UniversalV1ActorAttestationHandle
  ): Promise<MaterializedUniversalV1ChangeOrder> {
    const { client_ts: _priorTime, ...input } =
      AuthorizeAndMaterializeUniversalV1ChangeOrderPublicSchema.parse(raw);
    const payload = Object.freeze(
      FinalizeChangeOrderPayloadSchema.parse({
        ...input,
        phase_request_sha256: phaseRequestSha256,
        adjustment_event_id: adjustmentEventId,
        client_timestamp_epoch_ms: Date.parse(clientTimestamp),
      })
    );
    return this.invoke(
      actor,
      { commandKind: 'FINALIZE_FAKE_CHANGE_ORDER', commandPayload: payload },
      'public.hxos_finalize_authenticated_change_order_v13',
      MaterializedChangeOrderResultSchema,
      (result) =>
        changeOrderResultMatchesInput(result, payload) &&
        result.adjustment_event_id === payload.adjustment_event_id &&
        result.provider_kind === 'FAKE',
      () => true,
      attestation
    );
  }
  private async invoke<Result>(
    actor: string,
    command: UniversalV1ActorCommand,
    port: string,
    schema: z.ZodType<Result>,
    matches: (result: Result) => boolean,
    requiresFinance: (result: Result) => boolean,
    attestation: UniversalV1ActorAttestationHandle
  ): Promise<Result> {
    try {
      const expectedActor = uuid.parse(actor);
      if (!attestation) return refuse('CHANGE_ORDER_AUTHORITY_REVOKED');
      const parsed = UniversalV1ActorAttestationResponseSchema.safeParse(
        await attestation.issue(command)
      );
      if (
        !parsed.success ||
        parsed.data.command_kind !== command.commandKind ||
        !digest.safeParse(parsed.data.actor_assertion_token).success ||
        !digest.safeParse(parsed.data.canonical_request_sha256).success ||
        Date.parse(parsed.data.assertion_expires_at) <= Date.now()
      )
        return refuse('CHANGE_ORDER_AUTHORITY_REVOKED');
      const assertion = Object.freeze(parsed.data);
      return await this.database.transaction(async (query) => {
        const rows = await query(`SELECT * FROM ${port}($1,$2)`, [
          assertion.actor_assertion_token,
          command.commandPayload,
        ]);
        if (rows.rowCount !== 1 || rows.rows.length !== 1) return refuse();
        const receipt = receiptSchema.safeParse(rows.rows[0]);
        if (
          !receipt.success ||
          receipt.data.actor_user_id !== expectedActor ||
          receipt.data.actor_request_sha256 !== assertion.canonical_request_sha256
        )
          return refuse();
        const result = schema.safeParse(receipt.data.result);
        if (!result.success || !matches(result.data)) return refuse();
        if (requiresFinance(result.data)) {
          const release = Object.freeze({ ...this.authorize() });
          if (
            release.authenticationStatus !== 'VERIFIED' ||
            !['local', 'preview', 'staging'].includes(release.environment) ||
            release.manifestDigest !== receipt.data.command_release_sha256 ||
            JSON.stringify(this.authorize()) !== JSON.stringify(release)
          )
            return refuse('CHANGE_ORDER_FAKE_FINANCE_ONLY');
        }
        return freezeChangeOrderCommand(result.data);
      });
    } catch (error) {
      if (error instanceof UniversalV1ChangeOrderError) throw error;
      const code =
        error instanceof Error
          ? codes.find((value) =>
              new RegExp('(?:^|[^A-Z_])' + value + '(?:$|[^A-Z_])', 'u').test(error.message)
            )
          : undefined;
      return refuse(code);
    }
  }
}
