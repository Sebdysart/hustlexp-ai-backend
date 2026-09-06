import type {
  PrepareUniversalV1StandardizedQuoteInput,
  UniversalV1StandardizedQuoteCurrentState,
  UniversalV1StandardizedQuoteRecord,
} from './UniversalV1StandardizedQuoteContracts.js';
import type { PrepareUniversalV1StandardizedQuoteCommand } from './UniversalV1StandardizedQuoteApplication.js';
import { readinessStateProjection } from './UniversalV1StandardizedQuotePostgresSql.js';
import {
  acceptanceRecord,
  assertOwnedDraft,
  exactInteger,
  fail,
  quoteRecord,
  readinessRecord,
  runSerializable,
  translateDatabaseError,
  type AcceptanceRow,
  type QuoteRouteRow,
  type QuoteRow,
  type ReadinessRow,
  type StandardizedQuoteDatabase,
} from './UniversalV1StandardizedQuotePostgresSupport.js';

function acceptedActionableState(
  routingCurrent: boolean,
  fakePaymentMethodReady: boolean
): UniversalV1StandardizedQuoteCurrentState['actionableState'] {
  if (!routingCurrent) return 'ROUTE_REVIEW_REQUIRED_AFTER_ACCEPTANCE';
  return fakePaymentMethodReady
    ? 'READY_FOR_PROVIDER_DISCOVERY'
    : 'PREPARE_OR_RENEW_FAKE_PAYMENT_METHOD';
}

export class UniversalV1StandardizedQuotePostgresQuoteStore {
  constructor(private readonly database: StandardizedQuoteDatabase) {}

  async findQuoteReplay(
    actorUserId: string,
    input: PrepareUniversalV1StandardizedQuoteInput,
    requestSha256: string
  ): Promise<UniversalV1StandardizedQuoteRecord | null> {
    try {
      const result = await this.database.query<QuoteRow>(
        `SELECT *
           FROM public.task_draft_standardized_quote_versions
          WHERE requested_by_user_id = $1::UUID
            AND idempotency_key = $2
          LIMIT 1`,
        [actorUserId, input.idempotencyKey]
      );
      const row = result.rows[0];
      if (!row) return null;
      if (row.request_sha256.trim() !== requestSha256) {
        return fail('CONFLICT', 'The idempotency key is bound to a different quote request.');
      }
      return quoteRecord(row);
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async prepareQuote(command: PrepareUniversalV1StandardizedQuoteCommand) {
    try {
      return await runSerializable(this.database, async (query) => {
        await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `standardized-quote-idempotency:${command.actorUserId}:${command.input.idempotencyKey}`,
        ]);
        await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `standardized-quote-lifecycle:${command.input.taskDraftId}`,
        ]);
        const replay = await query<QuoteRow>(
          `SELECT *
             FROM public.task_draft_standardized_quote_versions
            WHERE requested_by_user_id = $1::UUID
              AND idempotency_key = $2
            LIMIT 1`,
          [command.actorUserId, command.input.idempotencyKey]
        );
        if (replay.rows[0]) {
          if (replay.rows[0].request_sha256.trim() !== command.requestSha256) {
            return fail('CONFLICT', 'The idempotency key is bound to a different quote request.');
          }
          return { record: quoteRecord(replay.rows[0]), replayed: true };
        }
        const route = await query<QuoteRouteRow>(
          `SELECT route.id AS routing_decision_id,
                  route.decision_version AS routing_decision_version
             FROM public.task_drafts draft
             JOIN public.task_routing_decisions route
               ON route.id = draft.active_routing_decision_id
              AND route.task_draft_id = draft.id
            WHERE draft.id = $1::UUID
              AND draft.poster_user_id = $2::UUID
            FOR SHARE OF draft, route`,
          [command.input.taskDraftId, command.actorUserId]
        );
        const currentRoute = route.rows[0];
        if (!currentRoute) return fail('NOT_FOUND', 'Owned open TaskDraft was not found.');
        if (
          exactInteger(currentRoute.routing_decision_version, 'Routing decision') !==
          command.input.expectedRoutingDecisionVersion
        ) {
          return fail('CONFLICT', 'The active routing decision version changed.');
        }
        const inserted = await query<QuoteRow>(
          `INSERT INTO public.task_draft_standardized_quote_versions(
             task_draft_id, routing_decision_id, routing_decision_version,
             quote_version, expected_quote_version,
             requested_by_user_id, environment_class, issuance_build_commit_sha,
             issuance_release_manifest_digest, issuance_capability_policy_digest,
             idempotency_key, request_sha256, client_timestamp_ms
           ) VALUES (
             $1::UUID, $2::UUID, $3, $4, $5, $6::UUID, $7, $8, $9, $10,
             $11, $12, $13
           )
           RETURNING *`,
          [
            command.input.taskDraftId,
            currentRoute.routing_decision_id,
            command.input.expectedRoutingDecisionVersion,
            command.input.expectedQuoteVersion + 1,
            command.input.expectedQuoteVersion,
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
        if (!row) return fail('INTERNAL_SERVER_ERROR', 'Quote insert returned no fact.');
        return { record: quoteRecord(row), replayed: false };
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async getCurrent(
    actorUserId: string,
    input: { taskDraftId: string }
  ): Promise<UniversalV1StandardizedQuoteCurrentState> {
    try {
      return await runSerializable(this.database, async (query) => {
        await assertOwnedDraft(query, actorUserId, input.taskDraftId);
        const quoteResult = await query<QuoteRow>(
          `SELECT quote.*,
                  EXISTS (
                    SELECT 1
                      FROM public.task_routing_decisions route
                      JOIN public.universal_v1_service_cell_authorities cell
                        ON cell.id = route.service_cell_authority_id
                       AND cell.authority_version = quote.service_cell_authority_version
                     WHERE route.id = draft.active_routing_decision_id
                       AND route.id = quote.routing_decision_id
                       AND route.task_draft_id = draft.id
                       AND route.decision_version = quote.routing_decision_version
                       AND route.outcome = 'FULFILLMENT_CANDIDATE'
                       AND route.policy_version = 'universal-v1-intake-1.2.0'
                       AND route.category_snapshot = quote.work_category_code
                       AND route.service_cell_snapshot = quote.region_code
                       AND cell.id = quote.service_cell_authority_id
                       AND cell.authority_environment = quote.environment_class
                       AND cell.routing_availability = 'ACTIVE'
                       AND cell.is_test IS TRUE
                       AND cell.authority_kind = 'SYNTHETIC_FIXTURE'
                       AND cell.effective_from <= clock_timestamp()
                       AND (cell.expires_at IS NULL OR cell.expires_at > clock_timestamp())
                       AND NOT EXISTS (
                         SELECT 1
                           FROM public.universal_v1_service_cell_authorities successor
                          WHERE successor.supersedes_authority_id = cell.id
                       )
                       AND EXISTS (
                         SELECT 1
                           FROM public.universal_v1_relationship_origins origin
                          WHERE origin.id = quote.relationship_origin_id
                            AND origin.task_draft_id = draft.id
                            AND origin.origin_version = quote.relationship_origin_version
                            AND origin.origin_kind = 'MARKETPLACE'
                            AND origin.routing_state = 'ROUTING_READY'
                            AND cardinality(origin.hold_reason_codes) = 0
                            AND NOT EXISTS (
                              SELECT 1
                                FROM public.universal_v1_relationship_origins successor
                               WHERE successor.supersedes_origin_id = origin.id
                            )
                       )
                  ) AS routing_current,
                  quote.valid_until > clock_timestamp() AS quote_unexpired
             FROM public.task_draft_standardized_quote_versions quote
             JOIN public.task_drafts draft ON draft.id = quote.task_draft_id
            WHERE quote.task_draft_id = $1::UUID
              AND NOT EXISTS (
                SELECT 1
                  FROM public.task_draft_standardized_quote_versions successor
                 WHERE successor.supersedes_quote_version_id = quote.id
              )
            ORDER BY quote.quote_version DESC
            LIMIT 1`,
          [input.taskDraftId]
        );
        const quote = quoteResult.rows[0];
        if (!quote) {
          return {
            quote: null,
            acceptance: null,
            readiness: null,
            routingCurrent: false,
            acceptanceOpen: false,
            priceLocked: false,
            fakePaymentMethodReady: false,
            actionableState: 'PREPARE_QUOTE_OR_REVIEW_ROUTE',
          };
        }
        const currentQuote = quoteRecord(quote);
        const routingCurrent = quote.routing_current === true;
        const quoteUnexpired = quote.quote_unexpired === true;
        const acceptanceResult = await query<AcceptanceRow>(
          `SELECT *
             FROM public.task_draft_standardized_quote_acceptance_facts
            WHERE quote_version_id = $1::UUID
              AND accepted_by_user_id = $2::UUID
            LIMIT 1`,
          [quote.id, actorUserId]
        );
        const acceptance = acceptanceResult.rows[0];
        if (!acceptance) {
          const acceptanceOpen = routingCurrent && quoteUnexpired;
          return {
            quote: currentQuote,
            acceptance: null,
            readiness: null,
            routingCurrent,
            acceptanceOpen,
            priceLocked: false,
            fakePaymentMethodReady: false,
            actionableState: acceptanceOpen ? 'ACCEPT_QUOTE' : 'REQUOTE_OR_REVIEW_ROUTE',
          };
        }
        const readinessResult = await query<ReadinessRow>(
          `SELECT readiness.*,
                  ${readinessStateProjection}
             FROM public.task_draft_payment_method_readiness_facts readiness
            WHERE readiness.acceptance_fact_id = $1::UUID
              AND readiness.prepared_by_user_id = $2::UUID
              AND NOT EXISTS (
                SELECT 1
                  FROM public.task_draft_payment_method_readiness_facts successor
                 WHERE successor.supersedes_readiness_fact_id = readiness.id
              )
            ORDER BY readiness.readiness_version DESC
            LIMIT 1`,
          [acceptance.id, actorUserId]
        );
        const acceptedQuote = acceptanceRecord(acceptance);
        const readiness = readinessResult.rows[0]
          ? readinessRecord({
              ...readinessResult.rows[0],
              routing_current: routingCurrent && readinessResult.rows[0].routing_current,
            })
          : null;
        const priceLocked =
          new Date(acceptedQuote.acceptedAt).getTime() <=
          new Date(currentQuote.validUntil).getTime();
        if (!priceLocked) {
          return fail(
            'INTERNAL_SERVER_ERROR',
            'Accepted standardized quote violated its accepted-before-expiry price lock.'
          );
        }
        const fakePaymentMethodReady = routingCurrent && readiness?.isCurrent === true;
        return {
          quote: currentQuote,
          acceptance: acceptedQuote,
          readiness,
          routingCurrent,
          acceptanceOpen: false,
          priceLocked,
          fakePaymentMethodReady,
          actionableState: acceptedActionableState(routingCurrent, fakePaymentMethodReady),
        };
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }
}
