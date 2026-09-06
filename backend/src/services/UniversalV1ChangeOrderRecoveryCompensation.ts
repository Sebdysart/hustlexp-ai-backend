import { z } from 'zod';
import { db, type Database } from '../db.js';
import {
  authorizedChangeOrderRecoveryClaims,
  type ChangeOrderRecoveryClaimAuthority,
  type ChangeOrderRecoveryLease,
} from './UniversalV1ChangeOrderRecoveryClaims.js';
import type { UniversalV1ChangeOrderCompensationResolution } from './UniversalV1ChangeOrderRecovery.js';

const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .refine((value) => value !== '0'.repeat(64));
const manifest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u)
  .refine((value) => value !== 'sha256:' + '0'.repeat(64));
// Keep PostgreSQL JSON timestamps at their original microsecond precision.
const timestamp = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.string().datetime({ offset: true })
);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const environment = z.enum(['local', 'preview', 'staging']);
const reason = z.enum([
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
]);
const authoritySchema = z
  .object({
    databaseName: z.string().min(1).max(63),
    serviceLogin: z.string().min(1).max(63),
    environment,
    manifestDigest: manifest,
    targetDigest: manifest,
  })
  .strict();
const leaseSchema = z
  .object({
    proposal_id: uuid,
    recovery_lease_id: uuid,
    lease_owner_id: uuid,
    witness_request_sha256: digest,
    work_order_id: uuid,
    acquired_at: timestamp,
    expires_at: timestamp,
    target_authority_id: uuid,
    release_manifest_digest: manifest,
  })
  .strict();
const metadataSchema = z
  .object({
    session_database_role: z.string(),
    target_authority_id: uuid,
    target_database_name: z.string(),
    environment,
    release_manifest_sha256: manifest,
  })
  .strict();
const commandSchema = z
  .object({
    compensation_command_id: uuid,
    proposal_id: uuid,
    witness_request_sha256: digest,
    recovery_lease_id: uuid,
    lease_owner_id: uuid,
    task_draft_id: uuid,
    task_id: uuid,
    work_order_id: uuid,
    eligibility_decision_id: uuid,
    base_scope_version_id: uuid,
    adjustment_event_id: uuid,
    adjustment_operation_id: uuid,
    reversal_operation_id: uuid,
    reversal_idempotency_key: z.string().regex(/^[A-Za-z0-9:_-]{16,128}$/u),
    lifecycle_expected_version: positive,
    amount_cents: positive,
    currency: z.string().regex(/^[A-Z]{3}$/u),
    requested_by: uuid,
    reason_code: z.literal('FINALIZATION_AUTHORITY_REVOKED'),
    authority_revocation_reason: reason,
    semantic_limitation: z.literal('PRIOR_SECURED_STATE_NOT_RESTORED'),
    created_at: timestamp,
  })
  .strict();
const originSchema = z
  .object({
    compensation_command_id: uuid,
    proposal_id: uuid,
    recovery_lease_id: uuid,
    lease_owner_id: uuid,
    target_authority_id: uuid,
    release_environment: environment,
    release_manifest_digest: manifest,
    service_database_role: z.string().min(1).max(63),
    witness_request_sha256: digest,
    adjustment_event_id: uuid,
    revocation_reason: reason,
    recorded_at: timestamp,
  })
  .strict();
const resolutionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('AMENDMENT_MATERIALIZED'),
      amendmentId: uuid,
      adjustmentEventId: uuid,
    })
    .strict(),
  z
    .object({
      kind: z.literal('COMPENSATE'),
      command: commandSchema,
      workerOrigin: originSchema.nullable(),
      created: z.boolean(),
    })
    .strict(),
]);
const receiptSchema = z
  .object({
    resolution: resolutionSchema,
    observed_at: timestamp,
    target_authority_id: uuid,
    release_manifest_digest: manifest,
  })
  .strict();
export type ChangeOrderCompensationWorkerOrigin = Readonly<z.infer<typeof originSchema>>;
export interface ChangeOrderCompensationWinnerReceipt {
  readonly resolution: UniversalV1ChangeOrderCompensationResolution;
  readonly workerOrigin: ChangeOrderCompensationWorkerOrigin | null;
  readonly created: boolean;
  readonly observedAt: string;
}
function refuse(reason: string): never {
  throw Error('CHANGE_ORDER_RECOVERY_COMPENSATION_' + reason);
}

/** Records a recovery winner only. Financial execution and terminal writes need
 * their own current authority; a legacy winner never gains fabricated worker origin. */
export class PostgresUniversalV1ChangeOrderRecoveryCompensation {
  constructor(
    private readonly database: Pick<Database, 'transaction'> = db,
    private readonly authorize: () => ChangeOrderRecoveryClaimAuthority = authorizedChangeOrderRecoveryClaims
  ) {}

  async claim(
    rawLease: ChangeOrderRecoveryLease,
    rawAdjustmentEventId: string
  ): Promise<ChangeOrderCompensationWinnerReceipt | null> {
    const lease = Object.freeze(leaseSchema.parse(rawLease)),
      adjustmentEventId = uuid.parse(rawAdjustmentEventId);
    const authority = Object.freeze(authoritySchema.parse(this.authorize()));
    if (
      lease.release_manifest_digest !== authority.manifestDigest ||
      Date.parse(lease.acquired_at) >= Date.parse(lease.expires_at)
    )
      return refuse('LEASE_BINDING_MISMATCH');
    return this.database.transaction(async (query) => {
      const metadata = await query(
        'SELECT session_database_role,target_authority_id,target_database_name,environment,release_manifest_sha256 FROM public.hxos_read_universal_v1_fake_financial_runtime_authority_v13()'
      );
      if (metadata.rowCount !== 1 || metadata.rows.length !== 1)
        return refuse('TARGET_CARDINALITY');
      const target = metadataSchema.parse(metadata.rows[0]);
      if (
        target.session_database_role !== authority.serviceLogin ||
        target.target_database_name !== authority.databaseName ||
        target.environment !== authority.environment ||
        target.release_manifest_sha256 !== authority.manifestDigest ||
        target.target_authority_id !== lease.target_authority_id
      )
        return refuse('TARGET_BINDING_MISMATCH');
      const result = await query(
        'SELECT * FROM public.hxos_claim_fake_financial_change_order_compensation_v13($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          lease.target_authority_id,
          authority.databaseName,
          authority.environment,
          authority.manifestDigest,
          lease.proposal_id,
          lease.recovery_lease_id,
          lease.lease_owner_id,
          lease.witness_request_sha256,
          lease.work_order_id,
          adjustmentEventId,
        ]
      );
      if (result.rowCount !== result.rows.length || result.rows.length > 1)
        return refuse('RECEIPT_CARDINALITY');
      let decoded: ChangeOrderCompensationWinnerReceipt | null = null;
      if (result.rows.length) {
        const receipt = receiptSchema.parse(result.rows[0]),
          row = receipt.resolution;
        const observed = Date.parse(receipt.observed_at);
        if (
          receipt.target_authority_id !== lease.target_authority_id ||
          receipt.release_manifest_digest !== authority.manifestDigest ||
          observed < Date.parse(lease.acquired_at) ||
          observed >= Date.parse(lease.expires_at)
        )
          return refuse('RECEIPT_BINDING_MISMATCH');
        if (row.kind === 'AMENDMENT_MATERIALIZED') {
          if (row.adjustmentEventId !== adjustmentEventId)
            return refuse('ADJUSTMENT_BINDING_MISMATCH');
          decoded = {
            resolution: Object.freeze(row),
            workerOrigin: null,
            created: false,
            observedAt: receipt.observed_at,
          };
        } else {
          const c = row.command,
            o = row.workerOrigin;
          if (
            c.proposal_id !== lease.proposal_id ||
            c.work_order_id !== lease.work_order_id ||
            c.witness_request_sha256 !== lease.witness_request_sha256 ||
            c.adjustment_event_id !== adjustmentEventId ||
            Date.parse(c.created_at) > observed
          )
            return refuse('WINNER_BINDING_MISMATCH');
          if (
            o &&
            (o.compensation_command_id !== c.compensation_command_id ||
              o.proposal_id !== c.proposal_id ||
              o.recovery_lease_id !== c.recovery_lease_id ||
              o.lease_owner_id !== c.lease_owner_id ||
              o.witness_request_sha256 !== c.witness_request_sha256 ||
              o.adjustment_event_id !== c.adjustment_event_id ||
              o.revocation_reason !== c.authority_revocation_reason ||
              Date.parse(o.recorded_at) < Date.parse(c.created_at) ||
              Date.parse(o.recorded_at) > observed)
          )
            return refuse('ORIGIN_BINDING_MISMATCH');
          if (
            row.created &&
            (!o ||
              c.recovery_lease_id !== lease.recovery_lease_id ||
              c.lease_owner_id !== lease.lease_owner_id ||
              Date.parse(c.created_at) < Date.parse(lease.acquired_at) ||
              o.target_authority_id !== target.target_authority_id ||
              o.release_environment !== authority.environment ||
              o.release_manifest_digest !== authority.manifestDigest ||
              o.service_database_role !== authority.serviceLogin)
          )
            return refuse('NEW_WINNER_ORIGIN_MISMATCH');
          decoded = {
            resolution: Object.freeze({
              kind: 'COMPENSATE',
              command: Object.freeze({
                compensationCommandId: c.compensation_command_id,
                proposalId: c.proposal_id,
                witnessRequestSha256: c.witness_request_sha256,
                taskDraftId: c.task_draft_id,
                taskId: c.task_id,
                eligibilityDecisionId: c.eligibility_decision_id,
                baseScopeVersionId: c.base_scope_version_id,
                adjustmentEventId: c.adjustment_event_id,
                adjustmentOperationId: c.adjustment_operation_id,
                reversalOperationId: c.reversal_operation_id,
                reversalIdempotencyKey: c.reversal_idempotency_key,
                lifecycleExpectedVersion: c.lifecycle_expected_version,
                amountCents: c.amount_cents,
                currency: c.currency,
                requestedBy: c.requested_by,
                createdAt: c.created_at,
                semanticLimitation: c.semantic_limitation,
              }),
            }),
            workerOrigin: o ? Object.freeze(o) : null,
            created: row.created,
            observedAt: receipt.observed_at,
          };
        }
        Object.freeze(decoded);
      }
      if (JSON.stringify(authoritySchema.parse(this.authorize())) !== JSON.stringify(authority))
        return refuse('RELEASE_AUTHORITY_CHANGED');
      return decoded;
    });
  }
}
