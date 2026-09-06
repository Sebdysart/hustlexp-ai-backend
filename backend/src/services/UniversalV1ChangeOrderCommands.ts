import { z } from 'zod';
import { db, type Database } from '../db.js';
import {
  UniversalV1ActorAttestationResponseSchema,
  type UniversalV1ActorAttestationHandle,
  type UniversalV1ActorCommand,
} from '../auth/universal-v1-actor-attestation-contracts.js';
import {
  ProposeChangeOrderPayloadSchema,
  DecideChangeOrderPayloadSchema,
  ProposedChangeOrderResultSchema,
  DecidedChangeOrderResultSchema,
  freezeChangeOrderCommand,
} from '../auth/change-order-command-contract.js';
import {
  ProposeUniversalV1ChangeOrderPublicSchema,
  DecideUniversalV1ChangeOrderPublicSchema,
  UniversalV1ChangeOrderError,
  type ProposeUniversalV1ChangeOrderPublic,
  type DecideUniversalV1ChangeOrderPublic,
  type ProposedUniversalV1ChangeOrder,
  type DecidedUniversalV1ChangeOrder,
  type UniversalV1ChangeOrderErrorCode,
} from './UniversalV1ChangeOrderContracts.js';

const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .refine((value) => value !== '0'.repeat(64));
const uuid = z.string().uuid();
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
const businessCodes = [
  'CHANGE_ORDER_CONTEXT_UNAVAILABLE',
  'CHANGE_ORDER_REQUEST_STALE',
  'CHANGE_ORDER_VERSION_CONFLICT',
  'CHANGE_ORDER_IDEMPOTENCY_CONFLICT',
  'CHANGE_ORDER_AUTHORITY_REVOKED',
  'CHANGE_ORDER_INDEPENDENT_APPROVAL_REQUIRED',
  'CHANGE_ORDER_STATE_CONFLICT',
  'CHANGE_ORDER_SCOPE_HASH_MISMATCH',
] as const;
function refuse(code: UniversalV1ChangeOrderErrorCode): never {
  throw new UniversalV1ChangeOrderError(code, 'The change-order command was refused.');
}

export interface UniversalV1ChangeOrderCommands {
  propose(
    actor: string,
    input: ProposeUniversalV1ChangeOrderPublic,
    attestation: UniversalV1ActorAttestationHandle
  ): Promise<ProposedUniversalV1ChangeOrder>;
  decide(
    actor: string,
    input: DecideUniversalV1ChangeOrderPublic,
    attestation: UniversalV1ActorAttestationHandle
  ): Promise<DecidedUniversalV1ChangeOrder>;
}

/** Authenticated writes own one transaction and release a result only after COMMIT. */
export class PostgresUniversalV1ChangeOrderCommands implements UniversalV1ChangeOrderCommands {
  constructor(private readonly database: Database = db) {}

  async propose(
    actor: string,
    raw: ProposeUniversalV1ChangeOrderPublic,
    attestation: UniversalV1ActorAttestationHandle
  ): Promise<ProposedUniversalV1ChangeOrder> {
    const { client_ts, ...input } = ProposeUniversalV1ChangeOrderPublicSchema.parse(raw);
    const payload = freezeChangeOrderCommand(
      ProposeChangeOrderPayloadSchema.parse({
        ...input,
        client_timestamp_epoch_ms: Date.parse(client_ts),
      })
    );
    return this.invoke<ProposedUniversalV1ChangeOrder>(
      actor,
      { commandKind: 'PROPOSE_FAKE_CHANGE_ORDER', commandPayload: payload },
      'public.hxos_propose_authenticated_change_order_v13',
      ProposedChangeOrderResultSchema,
      (result) =>
        result.proposal_version === payload.expected_latest_proposal_version + 1 &&
        result.change_order_kind === payload.change_order_kind,
      attestation
    );
  }

  async decide(
    actor: string,
    raw: DecideUniversalV1ChangeOrderPublic,
    attestation: UniversalV1ActorAttestationHandle
  ): Promise<DecidedUniversalV1ChangeOrder> {
    const { client_ts, ...input } = DecideUniversalV1ChangeOrderPublicSchema.parse(raw);
    const payload = freezeChangeOrderCommand(
      DecideChangeOrderPayloadSchema.parse({
        ...input,
        client_timestamp_epoch_ms: Date.parse(client_ts),
      })
    );
    return this.invoke<DecidedUniversalV1ChangeOrder>(
      actor,
      { commandKind: 'DECIDE_FAKE_CHANGE_ORDER', commandPayload: payload },
      'public.hxos_decide_authenticated_change_order_v13',
      DecidedChangeOrderResultSchema,
      (result) =>
        result.proposal_id === payload.proposal_id &&
        result.proposal_version === payload.expected_proposal_version &&
        result.decision === payload.decision &&
        result.proposal_status === (payload.decision === 'REJECTED' ? 'REJECTED' : 'PENDING'),
      attestation
    );
  }

  private async invoke<Result>(
    actor: string,
    command: UniversalV1ActorCommand,
    port: string,
    resultSchema: z.ZodType<Result>,
    matches: (result: Result) => boolean,
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
        if (rows.rowCount !== 1 || rows.rows.length !== 1)
          return refuse('CHANGE_ORDER_MATERIALIZATION_FAILED');
        const receipt = receiptSchema.safeParse(rows.rows[0]);
        if (
          !receipt.success ||
          receipt.data.actor_user_id !== expectedActor ||
          receipt.data.actor_request_sha256 !== assertion.canonical_request_sha256
        )
          return refuse('CHANGE_ORDER_MATERIALIZATION_FAILED');
        const parsedResult = resultSchema.safeParse(receipt.data.result);
        if (!parsedResult.success || !matches(parsedResult.data))
          return refuse('CHANGE_ORDER_MATERIALIZATION_FAILED');
        return freezeChangeOrderCommand(parsedResult.data);
      });
    } catch (error) {
      if (error instanceof UniversalV1ChangeOrderError) throw error;
      const code =
        error instanceof Error
          ? businessCodes.find((candidate) =>
              new RegExp('(?:^|[^A-Z_])' + candidate + '(?:$|[^A-Z_])', 'u').test(error.message)
            )
          : undefined;
      return refuse(code ?? 'CHANGE_ORDER_MATERIALIZATION_FAILED');
    }
  }
}
