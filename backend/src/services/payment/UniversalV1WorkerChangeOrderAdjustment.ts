import { z } from 'zod';
import { db, type Database, type QueryFn } from '../../db.js';
import type { ChangeOrderRecoveryLease } from '../UniversalV1ChangeOrderRecoveryClaims.js';
import {
  authorizedChangeOrderReversalRequests,
  type ChangeOrderReversalRequestAuthority,
} from './UniversalV1ChangeOrderReversalRequest.js';
import { decodeFakeFinancialDurableRequest } from './FakeFinancialDurableRequest.js';
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
const preparedSchema = z
  .object({
    prepared_command_id: uuid,
    command_state: z.literal('PREPARED'),
    operation_kind: z.literal('ADJUST'),
    event_kind: z.literal('ADJUSTMENT_AUTHORIZED'),
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
    change_order_id: uuid,
    change_order_version: positive,
    predecessor_event_id: uuid,
    predecessor_operation_id: uuid,
    predecessor_event_kind: z.enum(['SECURED', 'ADJUSTMENT_AUTHORIZED']),
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
const requestedSchema = z
  .object({
    commandId: uuid,
    operationKind: z.literal('ADJUST'),
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
    operation_kind: z.literal('ADJUST'),
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

const driverTimestamp = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  timestamp
);
const leaseSchema = z
  .object({
    proposal_id: uuid,
    recovery_lease_id: uuid,
    lease_owner_id: uuid,
    witness_request_sha256: digest,
    work_order_id: uuid,
    acquired_at: driverTimestamp,
    expires_at: driverTimestamp,
    target_authority_id: uuid,
    release_manifest_digest: manifestDigest,
  })
  .strict();
const provenanceSchema = z
  .object({
    preparation_origin_id: uuid,
    prepared_command_id: uuid,
    proposal_id: uuid,
    recovery_lease_id: uuid,
    lease_owner_id: uuid,
    witness_request_sha256: digest,
    target_authority_id: uuid,
    release_manifest_sha256: manifestDigest,
    service_database_role: z.string().min(1).max(63),
    provider_request_sha256: digest,
    prepared_authority_sha256: digest,
    created_prepared: z.boolean(),
    preparation_transaction_id: z.string().regex(/^[1-9][0-9]*$/u),
    recorded_at: timestamp,
  })
  .strict();
const historicalRequestSchema = rawRequestedSchema
  .omit({ idempotency_replayed: true })
  .extend({
    command_state: z.literal('REQUESTED'),
    provider_expected_version: z.literal(0),
    recorded_at: timestamp,
    requested_transaction_id: z.string().regex(/^[1-9][0-9]*$/u),
    task_draft_id: uuid,
    task_id: uuid,
    work_order_id: uuid,
    related_operation_id: uuid,
    amount_cents: positive,
    currency: z.string().regex(/^[A-Z]{3}$/u),
    recorded_actor_id: uuid,
    recorded_actor_kind: z.literal('PARTICIPANT'),
    release_manifest_digest: manifestDigest,
    release_id: authoritySchema.shape.releaseId,
    release_revision: authoritySchema.shape.revision,
    release_environment: environment,
    release_authentication_status: z.literal('VERIFIED'),
  })
  .strict();
const preparationSchema = z
  .object({
    prepared_command: preparedSchema,
    idempotency_replayed: z.boolean(),
    worker_provenance: provenanceSchema.nullable(),
    requested_command: historicalRequestSchema.nullable(),
    canonical_provider_request: z.string().min(2).max(65536),
    target_authority_id: uuid,
    release_manifest_digest: manifestDigest,
  })
  .strict();
export interface RequestedWorkerChangeOrderAdjustment extends RequestedUniversalV1FinancialEvent {
  readonly proposalId: string;
  readonly preparedAt: string;
  readonly providerRequestSha256: string;
  readonly preparedAuthoritySha256: string;
  readonly commandIdentitySha256: string;
  readonly preparationReplayed: boolean;
  readonly workerProvenance: Readonly<z.infer<typeof provenanceSchema>> | null;
}
function refuse(reason: string): never {
  throw Error('WORKER_CHANGE_ORDER_ADJUSTMENT_' + reason);
}

/** Commits bounded PREPARED continuation, then hands an exact request to the existing
 * journal/outbox. Historical requests retain their original actor and release identity. */
export class PostgresUniversalV1WorkerChangeOrderAdjustments {
  constructor(
    private readonly database: Pick<Database, 'transaction'> = db,
    private readonly authorize: () => ChangeOrderReversalRequestAuthority = authorizedChangeOrderReversalRequests
  ) {}
  async requestAdjustment(
    raw: ChangeOrderRecoveryLease
  ): Promise<Readonly<RequestedWorkerChangeOrderAdjustment>> {
    const lease = Object.freeze(leaseSchema.parse(raw));
    if (Date.parse(lease.acquired_at) >= Date.parse(lease.expires_at))
      return refuse('LEASE_WINDOW_INVALID');
    const authority = Object.freeze(authoritySchema.parse(this.authorize()));
    const stableAuthority = () => {
      if (JSON.stringify(authoritySchema.parse(this.authorize())) !== JSON.stringify(authority))
        return refuse('AUTHORITY_CHANGED');
    };
    const readTarget = async (query: QueryFn, expectedTarget?: string) => {
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
        (expectedTarget !== undefined && target.target_authority_id !== expectedTarget)
      )
        return refuse('TARGET_BINDING_MISMATCH');
      return target;
    };
    const preparation = await this.database.transaction(async (query) => {
      const target = await readTarget(query);
      const result = await query(
        'SELECT * FROM public.hxos_prepare_worker_change_order_adjustment_v13($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          target.target_authority_id,
          authority.databaseName,
          authority.environment,
          authority.manifestDigest,
          lease.proposal_id,
          lease.recovery_lease_id,
          lease.lease_owner_id,
          lease.witness_request_sha256,
          lease.work_order_id,
          null,
        ]
      );
      if (result.rowCount !== 1 || result.rows.length !== 1)
        return refuse('PREPARATION_CARDINALITY');
      const receipt = preparationSchema.parse(result.rows[0]),
        p = receipt.prepared_command,
        o = receipt.worker_provenance;
      const durable = decodeFakeFinancialDurableRequest(
        'ADJUST',
        receipt.canonical_provider_request,
        p.provider_request_sha256
      );
      if (
        receipt.target_authority_id !== target.target_authority_id ||
        receipt.release_manifest_digest !== authority.manifestDigest ||
        p.change_order_id !== lease.proposal_id ||
        p.work_order_id !== lease.work_order_id ||
        p.provider_request_sha256 !== durable.providerRequestSha256 ||
        p.operation_id !== durable.request.operationId ||
        p.idempotency_key !== durable.request.idempotencyKey ||
        p.scope_version_id !== durable.request.scopeVersionId ||
        p.change_order_id !== durable.request.changeOrderId ||
        p.related_operation_id !== durable.request.relatedOperationId ||
        p.predecessor_operation_id !== p.related_operation_id ||
        p.predecessor_lifecycle_version + 1 !== p.lifecycle_expected_version ||
        p.amount_cents !== durable.request.amountCents ||
        p.currency.toLowerCase() !== durable.request.currency
      )
        return refuse('PREPARATION_BINDING_MISMATCH');
      if (
        o &&
        (o.prepared_command_id !== p.prepared_command_id ||
          o.proposal_id !== lease.proposal_id ||
          o.recovery_lease_id !== lease.recovery_lease_id ||
          o.lease_owner_id !== lease.lease_owner_id ||
          o.witness_request_sha256 !== lease.witness_request_sha256 ||
          o.target_authority_id !== target.target_authority_id ||
          o.release_manifest_sha256 !== authority.manifestDigest ||
          o.provider_request_sha256 !== p.provider_request_sha256 ||
          o.prepared_authority_sha256 !== p.authority_context_sha256 ||
          Date.parse(o.recorded_at) < Date.parse(lease.acquired_at) ||
          Date.parse(o.recorded_at) >= Date.parse(lease.expires_at) ||
          Date.parse(o.recorded_at) < Date.parse(p.prepared_at))
      )
        return refuse('PROVENANCE_BINDING_MISMATCH');
      if (
        !receipt.requested_command &&
        (!o ||
          o.service_database_role !== authority.serviceLogin ||
          (!receipt.idempotency_replayed && !o.created_prepared))
      )
        return refuse('WORKER_PROVENANCE_REQUIRED');
      stableAuthority();
      return receipt;
    });
    stableAuthority();
    const p = preparation.prepared_command,
      durable = decodeFakeFinancialDurableRequest(
        'ADJUST',
        preparation.canonical_provider_request,
        p.provider_request_sha256
      );
    const input = {
      operationKind: 'ADJUST' as const,
      operationId: p.operation_id,
      providerKind: 'FAKE' as const,
      idempotencyKey: p.idempotency_key,
      providerExpectedVersion: 0,
      exactRequest: durable.request,
      evidence: {
        preparedFinancialCommandId: p.prepared_command_id,
        preparedAuthoritySha256: p.authority_context_sha256,
        taskDraftId: p.task_draft_id,
        taskId: p.task_id,
        workOrderId: p.work_order_id,
        relatedOperationId: p.related_operation_id,
        amountCents: p.amount_cents,
        currency: p.currency,
      },
      actor: { actorId: p.recorded_by, actorKind: 'PARTICIPANT' as const },
      release: {
        manifestDigest: authority.manifestDigest,
        releaseId: authority.releaseId,
        revision: authority.revision,
        environment: authority.environment,
        authenticationStatus: authority.authenticationStatus,
      },
    };
    const finish = (
      commandId: string,
      requestedAt: string,
      commandIdentitySha256: string,
      idempotencyReplayed: boolean
    ) =>
      Object.freeze({
        requestState: 'REQUESTED' as const,
        commandId,
        preparedCommandId: p.prepared_command_id,
        operationId: p.operation_id,
        proposalId: lease.proposal_id,
        requestedAt,
        preparedAt: p.prepared_at,
        providerRequestSha256: p.provider_request_sha256,
        preparedAuthoritySha256: p.authority_context_sha256,
        commandIdentitySha256,
        preparationReplayed: preparation.idempotency_replayed,
        idempotencyReplayed,
        workerProvenance: preparation.worker_provenance
          ? Object.freeze(preparation.worker_provenance)
          : null,
      });
    const historical = preparation.requested_command;
    if (historical) {
      const exact = prepareFinancialProviderCommand({
        ...input,
        release: {
          manifestDigest: historical.release_manifest_digest,
          releaseId: historical.release_id,
          revision: historical.release_revision,
          environment: historical.release_environment,
          authenticationStatus: historical.release_authentication_status,
        },
      });
      if (
        !preparation.idempotency_replayed ||
        historical.command_identity_sha256 !== exact.commandIdentitySha256 ||
        historical.request_sha256 !== p.provider_request_sha256 ||
        historical.operation_id !== p.operation_id ||
        historical.idempotency_key !== p.idempotency_key ||
        historical.prepared_financial_command_id !== p.prepared_command_id ||
        historical.prepared_authority_sha256 !== p.authority_context_sha256 ||
        historical.task_draft_id !== p.task_draft_id ||
        historical.task_id !== p.task_id ||
        historical.work_order_id !== p.work_order_id ||
        historical.related_operation_id !== p.related_operation_id ||
        historical.recorded_actor_id !== p.recorded_by ||
        historical.amount_cents !== p.amount_cents ||
        historical.currency !== p.currency ||
        historical.release_environment !== authority.environment ||
        Date.parse(historical.recorded_at) < Date.parse(p.prepared_at)
      )
        return refuse('HISTORICAL_REQUEST_MISMATCH');
      stableAuthority();
      return finish(
        historical.command_id,
        historical.recorded_at,
        historical.command_identity_sha256,
        true
      );
    }
    const expected = prepareFinancialProviderCommand(input);
    const journal = new PostgresFinancialProviderCommandJournal({
      transaction: (work) =>
        this.database.transaction(async (query) => {
          await readTarget(query, preparation.target_authority_id);
          const guarded: QueryFn = async <Row>(sql: string, params?: unknown[]) => {
            const result = await query<Row>(sql, params);
            if (result.rowCount !== 1 || result.rows.length !== 1)
              return refuse('REQUEST_CARDINALITY');
            rawRequestedSchema.parse(result.rows[0]);
            return result;
          };
          const result = await work(guarded),
            receipt = requestedSchema.parse(result);
          if (
            receipt.operationId !== p.operation_id ||
            receipt.idempotencyKey !== p.idempotency_key ||
            receipt.requestSha256 !== p.provider_request_sha256 ||
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
    return finish(
      requested.commandId,
      requested.recordedAt,
      requested.commandIdentitySha256,
      requested.idempotencyReplayed
    );
  }
}
