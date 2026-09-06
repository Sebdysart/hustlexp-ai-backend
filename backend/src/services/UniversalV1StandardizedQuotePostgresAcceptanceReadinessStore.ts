import type {
  AcceptUniversalV1StandardizedQuoteInput,
  PrepareUniversalV1FakePaymentMethodInput,
  UniversalV1FakePaymentMethodReadinessRecord,
  UniversalV1StandardizedQuoteAcceptanceRecord,
} from './UniversalV1StandardizedQuoteContracts.js';
import type {
  AcceptUniversalV1StandardizedQuoteCommand,
  PrepareUniversalV1FakePaymentMethodCommand,
} from './UniversalV1StandardizedQuoteApplication.js';
import { readinessStateProjection } from './UniversalV1StandardizedQuotePostgresSql.js';
import {
  acceptanceRecord,
  fail,
  readinessRecord,
  runSerializable,
  translateDatabaseError,
  type AcceptanceRow,
  type ReadinessRow,
  type StandardizedQuoteDatabase,
} from './UniversalV1StandardizedQuotePostgresSupport.js';

export class UniversalV1StandardizedQuotePostgresAcceptanceReadinessStore {
  constructor(private readonly database: StandardizedQuoteDatabase) {}

  async findAcceptanceReplay(
    actorUserId: string,
    input: AcceptUniversalV1StandardizedQuoteInput,
    requestSha256: string
  ): Promise<UniversalV1StandardizedQuoteAcceptanceRecord | null> {
    try {
      const result = await this.database.query<AcceptanceRow>(
        `SELECT *
           FROM public.task_draft_standardized_quote_acceptance_facts
          WHERE accepted_by_user_id = $1::UUID
            AND idempotency_key = $2
          LIMIT 1`,
        [actorUserId, input.idempotencyKey]
      );
      const row = result.rows[0];
      if (!row) return null;
      if (row.request_sha256.trim() !== requestSha256) {
        return fail('CONFLICT', 'The idempotency key is bound to a different acceptance.');
      }
      return acceptanceRecord(row);
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async acceptQuote(command: AcceptUniversalV1StandardizedQuoteCommand) {
    try {
      return await runSerializable(this.database, async (query) => {
        await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `standardized-quote-acceptance:${command.actorUserId}:${command.input.idempotencyKey}`,
        ]);
        await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `standardized-quote-lifecycle:${command.input.taskDraftId}`,
        ]);
        const replay = await query<AcceptanceRow>(
          `SELECT *
             FROM public.task_draft_standardized_quote_acceptance_facts
            WHERE accepted_by_user_id = $1::UUID
              AND idempotency_key = $2
            LIMIT 1`,
          [command.actorUserId, command.input.idempotencyKey]
        );
        if (replay.rows[0]) {
          if (replay.rows[0].request_sha256.trim() !== command.requestSha256) {
            return fail('CONFLICT', 'The idempotency key is bound to a different acceptance.');
          }
          return { record: acceptanceRecord(replay.rows[0]), replayed: true };
        }
        const inserted = await query<AcceptanceRow>(
          `INSERT INTO public.task_draft_standardized_quote_acceptance_facts(
             task_draft_id, quote_version_id, expected_quote_version,
             routing_decision_version, expected_acceptance_version,
             accepted_by_user_id, environment_class, command_build_commit_sha,
             command_release_manifest_digest, command_capability_policy_digest,
             idempotency_key, request_sha256, client_timestamp_ms
           ) VALUES (
             $1::UUID, $2::UUID, $3, $4, $5, $6::UUID, $7, $8, $9, $10,
             $11, $12, $13
           )
           RETURNING *`,
          [
            command.input.taskDraftId,
            command.input.quoteVersionId,
            command.input.expectedQuoteVersion,
            command.input.expectedRoutingDecisionVersion,
            command.input.expectedAcceptanceVersion,
            command.actorUserId,
            command.evidence.environment,
            command.evidence.buildCommitSha,
            command.evidence.releaseManifestDigest,
            command.evidence.capabilityPolicyDigest,
            command.input.idempotencyKey,
            command.requestSha256,
            command.input.clientTs,
          ]
        );
        const row = inserted.rows[0];
        if (!row) return fail('INTERNAL_SERVER_ERROR', 'Acceptance insert returned no fact.');
        return { record: acceptanceRecord(row), replayed: false };
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async findFakePaymentMethodReplay(
    actorUserId: string,
    input: PrepareUniversalV1FakePaymentMethodInput,
    requestSha256: string
  ): Promise<UniversalV1FakePaymentMethodReadinessRecord | null> {
    try {
      const result = await this.database.query<ReadinessRow>(
        `SELECT readiness.*,
                ${readinessStateProjection}
           FROM public.task_draft_payment_method_readiness_facts readiness
          WHERE readiness.prepared_by_user_id = $1::UUID
            AND readiness.idempotency_key = $2
          LIMIT 1`,
        [actorUserId, input.idempotencyKey]
      );
      const row = result.rows[0];
      if (!row) return null;
      if (row.request_sha256.trim() !== requestSha256) {
        return fail('CONFLICT', 'The idempotency key is bound to different readiness.');
      }
      return readinessRecord(row);
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async prepareFakePaymentMethod(command: PrepareUniversalV1FakePaymentMethodCommand) {
    try {
      return await runSerializable(this.database, async (query) => {
        await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `fake-payment-readiness:${command.actorUserId}:${command.input.idempotencyKey}`,
        ]);
        await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `standardized-quote-lifecycle:${command.input.taskDraftId}`,
        ]);
        const replay = await query<ReadinessRow>(
          `SELECT readiness.*,
                  ${readinessStateProjection}
             FROM public.task_draft_payment_method_readiness_facts readiness
            WHERE readiness.prepared_by_user_id = $1::UUID
              AND readiness.idempotency_key = $2
            LIMIT 1`,
          [command.actorUserId, command.input.idempotencyKey]
        );
        if (replay.rows[0]) {
          if (replay.rows[0].request_sha256.trim() !== command.requestSha256) {
            return fail('CONFLICT', 'The idempotency key is bound to different readiness.');
          }
          return { record: readinessRecord(replay.rows[0]), replayed: true };
        }
        const inserted = await query<ReadinessRow>(
          `INSERT INTO public.task_draft_payment_method_readiness_facts(
             task_draft_id, acceptance_fact_id, expected_quote_version,
             expected_readiness_version, provider_kind, environment_class,
             prepared_by_user_id, opaque_reference_sha256,
             command_build_commit_sha, command_release_manifest_digest,
             command_capability_policy_digest,
             idempotency_key, request_sha256, client_timestamp_ms
           ) VALUES (
             $1::UUID, $2::UUID, $3, $4, 'FAKE', $5, $6::UUID, $7, $8, $9,
             $10, $11, $12, $13
           )
           RETURNING *, TRUE AS is_current, TRUE AS readiness_chain_head,
                     TRUE AS readiness_unexpired, TRUE AS routing_current`,
          [
            command.input.taskDraftId,
            command.input.acceptanceFactId,
            command.input.expectedQuoteVersion,
            command.input.expectedReadinessVersion,
            command.evidence.environment,
            command.actorUserId,
            command.opaqueReferenceSha256,
            command.evidence.buildCommitSha,
            command.evidence.releaseManifestDigest,
            command.evidence.capabilityPolicyDigest,
            command.input.idempotencyKey,
            command.requestSha256,
            command.input.clientTs,
          ]
        );
        const row = inserted.rows[0];
        if (!row) return fail('INTERNAL_SERVER_ERROR', 'Readiness insert returned no fact.');
        return { record: readinessRecord(row), replayed: false };
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }
}
