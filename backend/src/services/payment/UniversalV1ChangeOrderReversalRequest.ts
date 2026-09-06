import { z } from 'zod';
import { db, type Database, type QueryFn } from '../../db.js';
import { configuredRuntimeDatabaseStartup } from '../../jobs/runtime-database-startup-config.js';
import {
  isAuthenticatedReleaseManifest,
  readReleaseManifest,
  releaseManifestDigest,
} from '../../releaseManifest.js';
import type { ChangeOrderCompensationWinnerReceipt } from '../UniversalV1ChangeOrderRecoveryCompensation.js';
import { assertNonproductionFakeFinanceAuthorized } from './NonproductionFinancialAuthorization.js';
import { encodeFakeFinancialDurableRequest } from './FakeFinancialDurableRequest.js';
import {
  PostgresFinancialProviderCommandJournal,
  prepareFinancialProviderCommand,
} from './FinancialProviderCommandJournal.js';
import type { RequestedUniversalV1FinancialEvent } from './UniversalV1FinancialRequestService.js';

const uuid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .refine((value) => value !== '0'.repeat(64));
const manifestDigest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u)
  .refine((value) => value !== 'sha256:' + '0'.repeat(64));
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime({ offset: true });
const environment = z.enum(['local', 'preview', 'staging']);
const key = z.string().regex(/^[A-Za-z0-9:_-]{16,128}$/u);
const authoritySchema = z
  .object({
    databaseName: z.string().min(1).max(63),
    serviceLogin: z.string().min(1).max(63),
    environment,
    manifestDigest,
    targetDigest: manifestDigest,
    releaseId: z.string().regex(/^[a-z0-9][a-z0-9._-]{7,127}$/u),
    revision: z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .refine((value) => value !== '0'.repeat(40)),
    authenticationStatus: z.literal('VERIFIED'),
  })
  .strict();
const metadataSchema = z
  .object({
    session_database_role: z.string(),
    target_authority_id: uuid,
    target_database_name: z.string(),
    environment,
    release_manifest_sha256: manifestDigest,
  })
  .strict();
const commandSchema = z
  .object({
    compensationCommandId: uuid,
    proposalId: uuid,
    witnessRequestSha256: digest,
    taskDraftId: uuid,
    taskId: uuid,
    eligibilityDecisionId: uuid,
    baseScopeVersionId: uuid,
    adjustmentEventId: uuid,
    adjustmentOperationId: uuid,
    reversalOperationId: uuid,
    reversalIdempotencyKey: key,
    lifecycleExpectedVersion: positive,
    amountCents: positive,
    currency: z.string().regex(/^[A-Z]{3}$/u),
    requestedBy: uuid,
    createdAt: timestamp,
    semanticLimitation: z.literal('PRIOR_SECURED_STATE_NOT_RESTORED'),
  })
  .strict();
const winnerSchema = z
  .object({
    resolution: z.object({ kind: z.literal('COMPENSATE'), command: commandSchema }).strict(),
    workerOrigin: z
      .object({
        compensation_command_id: uuid,
        proposal_id: uuid,
        recovery_lease_id: uuid,
        lease_owner_id: uuid,
        target_authority_id: uuid,
        release_environment: environment,
        release_manifest_digest: manifestDigest,
        service_database_role: z.string().min(1).max(63),
        witness_request_sha256: digest,
        adjustment_event_id: uuid,
        revocation_reason: z.enum([
          'PROPOSAL_NOT_APPROVED',
          'TASK_AUTHORITY_REVOKED',
          'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
          'CUSTOMER_APPROVAL_AUTHORITY_REVOKED',
          'PROVIDER_ACTOR_AUTHORITY_REVOKED',
          'PROVIDER_APPROVAL_AUTHORITY_REVOKED',
          'PROVIDER_ELIGIBILITY_REVOKED',
          'EXECUTION_AUTHORITY_REVOKED',
          'WORK_ORDER_TERMINALIZED',
          'FINANCIAL_SECURITY_EXPIRED',
        ]),
        recorded_at: timestamp,
      })
      .strict(),
    created: z.boolean(),
    observedAt: timestamp,
  })
  .strict();
// SQL JSON timestamps and XID8 remain opaque strings; no lossy Date/Number mapping.
const provenanceSchema = z
  .object({
    prepared_command_id: uuid,
    compensation_command_id: uuid,
    target_authority_id: uuid,
    release_manifest_sha256: manifestDigest,
    service_database_role: z.string().min(1).max(63),
    provider_request_sha256: digest,
    prepared_authority_sha256: digest,
    preparation_transaction_id: z.string().regex(/^[1-9][0-9]*$/u),
    recorded_at: timestamp,
  })
  .strict();
const preparedSchema = z
  .object({
    prepared_command_id: uuid,
    command_state: z.literal('PREPARED'),
    operation_kind: z.literal('REVERSAL'),
    event_kind: z.literal('REVERSED'),
    operation_id: uuid,
    provider_kind: z.literal('FAKE'),
    idempotency_key: key,
    provider_expected_version: z.literal(0),
    lifecycle_expected_version: positive,
    provider_request_sha256: digest,
    task_draft_id: uuid,
    task_id: uuid,
    eligibility_decision_id: uuid,
    eligibility_decision_version: positive,
    eligibility_valid_until: timestamp,
    scope_version_id: uuid,
    scope_version: positive,
    scope_hash: digest,
    work_order_id: uuid,
    work_order_materialization_version: positive,
    work_order_execution_contract_version: z.union([z.literal(0), z.literal(1)]),
    change_order_id: z.null(),
    change_order_version: z.null(),
    predecessor_event_id: uuid,
    predecessor_operation_id: uuid,
    predecessor_event_kind: z.literal('ADJUSTMENT_AUTHORIZED'),
    predecessor_status: z.literal('SUCCEEDED'),
    predecessor_lifecycle_version: positive,
    completion_fact_id: z.null(),
    completion_version: z.null(),
    related_operation_id: uuid,
    amount_cents: positive,
    currency: z.string().regex(/^[A-Z]{3}$/u),
    recorded_by: uuid,
    occurred_at: timestamp,
    request_identity_sha256: digest,
    authority_context_sha256: digest,
    prepared_at: timestamp,
  })
  .strict();
const preparationSchema = z
  .object({
    prepared_command: preparedSchema,
    idempotency_replayed: z.boolean(),
    worker_provenance: provenanceSchema,
    target_authority_id: uuid,
    release_manifest_digest: manifestDigest,
  })
  .strict();
const requestedSchema = z
  .object({
    commandId: uuid,
    operationKind: z.literal('REVERSAL'),
    operationId: uuid,
    providerKind: z.literal('FAKE'),
    idempotencyKey: key,
    providerExpectedVersion: z.literal(0),
    requestSha256: digest,
    commandIdentitySha256: digest,
    preparedFinancialCommandId: uuid,
    preparedAuthoritySha256: digest,
    recordedAt: timestamp,
    idempotencyReplayed: z.boolean(),
  })
  .strict();
const rawRequestedSchema = z
  .object({
    command_id: uuid,
    operation_kind: z.literal('REVERSAL'),
    operation_id: uuid,
    provider_kind: z.literal('FAKE'),
    idempotency_key: key,
    provider_expected_version: z.union([z.literal(0), z.literal('0')]),
    request_sha256: digest,
    command_identity_sha256: digest,
    prepared_financial_command_id: uuid,
    prepared_authority_sha256: digest,
    recorded_at: z.union([z.date(), timestamp]),
    idempotency_replayed: z.boolean(),
  })
  .strict();

export type ChangeOrderReversalRequestAuthority = Readonly<z.infer<typeof authoritySchema>>;
export interface RequestedChangeOrderReversal extends RequestedUniversalV1FinancialEvent {
  readonly compensationCommandId: string;
  readonly providerRequestSha256: string;
  readonly preparedAuthoritySha256: string;
  readonly commandIdentitySha256: string;
  readonly preparationReplayed: boolean;
  readonly preparedAt: string;
  readonly workerProvenance: Readonly<z.infer<typeof provenanceSchema>>;
}
function refuse(reason: string): never {
  throw Error('CHANGE_ORDER_REVERSAL_REQUEST_' + reason);
}

export function authorizedChangeOrderReversalRequests(): ChangeOrderReversalRequestAuthority {
  const manifest = assertNonproductionFakeFinanceAuthorized({ component: 'worker' });
  const evidence = readReleaseManifest(),
    manifestHash = releaseManifestDigest(manifest);
  if (evidence.digest !== manifestHash || !isAuthenticatedReleaseManifest(evidence, process.env))
    return refuse('AUTHENTICATED_RELEASE_REQUIRED');
  const runtime = configuredRuntimeDatabaseStartup('worker');
  if (runtime.expectedTarget.environment !== manifest.environment)
    return refuse('WORKER_RELEASE_REQUIRED');
  return Object.freeze(
    authoritySchema.parse({
      databaseName: runtime.expectedTarget.databaseName,
      serviceLogin: runtime.target.serviceLogin,
      environment: manifest.environment,
      manifestDigest: manifestHash,
      targetDigest: runtime.targetDigest,
      releaseId: manifest.releaseId,
      revision: manifest.components.worker.revision,
      authenticationStatus: 'VERIFIED',
    })
  );
}

/** Commit worker PREPARED, then REQUESTED/outbox through the existing journal.
 * This port does not dispatch, execute, terminalize recovery, or clear holds.
 * Uncertain commits and lock contention require exact idempotent retries. */
export class PostgresUniversalV1ChangeOrderReversalRequests {
  constructor(
    private readonly database: Pick<Database, 'transaction'> = db,
    private readonly authorize: () => ChangeOrderReversalRequestAuthority = authorizedChangeOrderReversalRequests
  ) {}

  async requestReversal(
    raw: ChangeOrderCompensationWinnerReceipt
  ): Promise<RequestedChangeOrderReversal> {
    const parsed = winnerSchema.safeParse(raw);
    if (!parsed.success) return refuse('WORKER_WINNER_REQUIRED');
    const {
      resolution: { command },
      workerOrigin,
    } = parsed.data;
    if (
      workerOrigin.compensation_command_id !== command.compensationCommandId ||
      workerOrigin.proposal_id !== command.proposalId ||
      workerOrigin.witness_request_sha256 !== command.witnessRequestSha256 ||
      workerOrigin.adjustment_event_id !== command.adjustmentEventId
    )
      return refuse('WINNER_BINDING_MISMATCH');
    const authority = Object.freeze(authoritySchema.parse(this.authorize()));
    const stableAuthority = () => {
      if (JSON.stringify(authoritySchema.parse(this.authorize())) !== JSON.stringify(authority))
        return refuse('RELEASE_AUTHORITY_CHANGED');
    };
    const readTarget = async (query: QueryFn, expectedTargetId?: string) => {
      stableAuthority();
      const result = await query(
        'SELECT session_database_role,target_authority_id,target_database_name,environment,release_manifest_sha256 FROM public.hxos_read_universal_v1_fake_financial_runtime_authority_v13()'
      );
      if (result.rowCount !== 1 || result.rows.length !== 1) return refuse('TARGET_CARDINALITY');
      const target = metadataSchema.parse(result.rows[0]);
      if (
        target.session_database_role !== authority.serviceLogin ||
        target.target_database_name !== authority.databaseName ||
        target.environment !== authority.environment ||
        target.release_manifest_sha256 !== authority.manifestDigest ||
        (expectedTargetId !== undefined && target.target_authority_id !== expectedTargetId)
      )
        return refuse('TARGET_BINDING_MISMATCH');
      return target;
    };
    const durable = encodeFakeFinancialDurableRequest('REVERSAL', {
      operationId: command.reversalOperationId,
      idempotencyKey: command.reversalIdempotencyKey,
      expectedVersion: 0,
      relatedOperationId: command.adjustmentOperationId,
      amountCents: command.amountCents,
      currency: command.currency.toLowerCase(),
      scenario: 'REVERSAL',
    });
    const preparation = await this.database.transaction(async (query) => {
      const target = await readTarget(query);
      const result = await query(
        'SELECT * FROM public.hxos_prepare_change_order_compensation_reversal_v13($1,$2,$3,$4,$5,$6)',
        [
          target.target_authority_id,
          authority.databaseName,
          authority.environment,
          authority.manifestDigest,
          command.compensationCommandId,
          durable.canonicalRequestJson,
        ]
      );
      if (result.rowCount !== 1 || result.rows.length !== 1) return refuse('RECEIPT_CARDINALITY');
      const receipt = preparationSchema.parse(result.rows[0]);
      const p = receipt.prepared_command,
        origin = receipt.worker_provenance;
      if (
        receipt.target_authority_id !== target.target_authority_id ||
        receipt.release_manifest_digest !== authority.manifestDigest ||
        p.operation_id !== command.reversalOperationId ||
        p.idempotency_key !== command.reversalIdempotencyKey ||
        p.lifecycle_expected_version !== command.lifecycleExpectedVersion ||
        p.provider_request_sha256 !== durable.providerRequestSha256 ||
        p.task_draft_id !== command.taskDraftId ||
        p.task_id !== command.taskId ||
        p.eligibility_decision_id !== command.eligibilityDecisionId ||
        p.scope_version_id !== command.baseScopeVersionId ||
        p.predecessor_event_id !== command.adjustmentEventId ||
        p.predecessor_operation_id !== command.adjustmentOperationId ||
        p.predecessor_lifecycle_version !== command.lifecycleExpectedVersion - 1 ||
        p.related_operation_id !== command.adjustmentOperationId ||
        p.amount_cents !== command.amountCents ||
        p.currency !== command.currency ||
        p.recorded_by !== command.requestedBy ||
        origin.prepared_command_id !== p.prepared_command_id ||
        origin.compensation_command_id !== command.compensationCommandId ||
        origin.target_authority_id !== target.target_authority_id ||
        origin.release_manifest_sha256 !== authority.manifestDigest ||
        origin.service_database_role !== authority.serviceLogin ||
        origin.provider_request_sha256 !== durable.providerRequestSha256 ||
        origin.prepared_authority_sha256 !== p.authority_context_sha256
      )
        return refuse('PREPARATION_BINDING_MISMATCH');
      stableAuthority();
      return receipt;
    });
    const p = preparation.prepared_command;
    const input = {
      operationKind: 'REVERSAL' as const,
      operationId: command.reversalOperationId,
      providerKind: 'FAKE' as const,
      idempotencyKey: command.reversalIdempotencyKey,
      providerExpectedVersion: 0,
      exactRequest: durable.request,
      evidence: {
        preparedFinancialCommandId: p.prepared_command_id,
        preparedAuthoritySha256: p.authority_context_sha256,
        taskDraftId: command.taskDraftId,
        taskId: command.taskId,
        workOrderId: p.work_order_id,
        relatedOperationId: command.adjustmentOperationId,
        amountCents: command.amountCents,
        currency: command.currency,
      },
      actor: { actorId: command.requestedBy, actorKind: 'PARTICIPANT' as const },
      release: {
        manifestDigest: authority.manifestDigest,
        releaseId: authority.releaseId,
        revision: authority.revision,
        environment: authority.environment,
        authenticationStatus: authority.authenticationStatus,
      },
    };
    const expected = prepareFinancialProviderCommand(input);
    // The journal still owns a separate transaction. Its delegated transaction
    // runner validates the receipt and installed authority before that commit.
    const journal = new PostgresFinancialProviderCommandJournal({
      transaction: (work) =>
        this.database.transaction(async (query) => {
          await readTarget(query, preparation.target_authority_id);
          const guardedQuery: QueryFn = async <Row>(sql: string, params?: unknown[]) => {
            const result = await query<Row>(sql, params);
            if (result.rowCount !== 1 || result.rows.length !== 1)
              return refuse('REQUEST_CARDINALITY');
            // Validate before the shared journal's Number/Date receipt mapping.
            rawRequestedSchema.parse(result.rows[0]);
            return result;
          };
          const result = await work(guardedQuery),
            receipt = requestedSchema.parse(result);
          if (
            receipt.operationId !== command.reversalOperationId ||
            receipt.idempotencyKey !== command.reversalIdempotencyKey ||
            receipt.requestSha256 !== durable.providerRequestSha256 ||
            receipt.commandIdentitySha256 !== expected.commandIdentitySha256 ||
            receipt.preparedFinancialCommandId !== p.prepared_command_id ||
            receipt.preparedAuthoritySha256 !== p.authority_context_sha256
          )
            return refuse('REQUEST_BINDING_MISMATCH');
          stableAuthority();
          return result;
        }),
    });
    const requested = await journal.recordRequested(input);
    stableAuthority();
    return Object.freeze({
      requestState: 'REQUESTED' as const,
      commandId: requested.commandId,
      preparedCommandId: p.prepared_command_id,
      compensationCommandId: command.compensationCommandId,
      operationId: command.reversalOperationId,
      requestedAt: requested.recordedAt,
      preparedAt: p.prepared_at,
      providerRequestSha256: durable.providerRequestSha256,
      preparedAuthoritySha256: p.authority_context_sha256,
      commandIdentitySha256: expected.commandIdentitySha256,
      preparationReplayed: preparation.idempotency_replayed,
      idempotencyReplayed: requested.idempotencyReplayed,
      workerProvenance: Object.freeze(preparation.worker_provenance),
    });
  }
}
