import { z } from 'zod';
import { db, type Database } from '../db.js';
import {
  authorizedChangeOrderRecoveryClaims,
  type ChangeOrderRecoveryClaimAuthority,
  type ChangeOrderRecoveryLease,
} from './UniversalV1ChangeOrderRecoveryClaims.js';
import {
  mapChangeOrderRecoveryObservation,
  type UniversalV1ChangeOrderRecoveryClaim,
} from './UniversalV1ChangeOrderRecovery.js';

const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .refine((value) => value !== '0'.repeat(64));
const manifestDigest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u)
  .refine((value) => value !== 'sha256:' + '0'.repeat(64));
const timestamp = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z
    .string()
    .datetime({ offset: true })
    .transform((value) => new Date(value).toISOString())
);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const key = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/u);
const currency = z.string().regex(/^[A-Z]{3}$/u);
const authoritySchema = z
  .object({
    databaseName: z.string().min(1).max(63),
    serviceLogin: z.string().min(1).max(63),
    environment: z.enum(['local', 'preview', 'staging']),
    manifestDigest,
    targetDigest: manifestDigest,
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
    release_manifest_digest: manifestDigest,
  })
  .strict();
const metadataSchema = z
  .object({
    session_database_role: z.string(),
    target_authority_id: uuid,
    target_database_name: z.string(),
    environment: z.enum(['local', 'preview', 'staging']),
    release_manifest_sha256: manifestDigest,
  })
  .strict();
const projectionSchema = z
  .object({
    proposal_id: uuid,
    recovery_lease_id: uuid,
    lease_owner_id: uuid,
    recovery_state: z.enum([
      'ADJUST_READY',
      'ADJUST_REPLAYABLE',
      'ADJUST_RECONCILE_ONLY',
      'ADJUST_TERMINAL_NO_EFFECT',
      'ADJUST_NO_EFFECT_AUTHORITY_REVOKED',
      'ADJUSTMENT_SUCCEEDED',
      'COMPENSATION_READY',
      'COMPENSATION_REPLAYABLE',
      'COMPENSATION_RECONCILE_ONLY',
      'COMPENSATION_TERMINAL_NO_EFFECT',
      'COMPENSATION_SUCCEEDED',
      'AMENDMENT_MATERIALIZED',
      'WAITING',
    ]),
    idempotency_key: key,
    request_sha256: digest,
    actor_user_id: uuid,
    work_order_id: uuid,
    task_id: uuid,
    task_draft_id: uuid,
    eligibility_decision_id: uuid,
    base_scope_version_id: uuid,
    replacement_scope_version_id: uuid,
    replacement_scope_version: integer.positive(),
    expected_financial_version: integer,
    predecessor_event_id: uuid,
    predecessor_operation_id: uuid,
    adjustment_operation_id: uuid,
    customer_total_cents: integer.positive(),
    currency,
    occurred_at: timestamp,
    adjustment_event_id: uuid.nullable(),
    amendment_id: uuid.nullable(),
    compensation_event_id: uuid.nullable(),
    adjustment_outcome_fact_id: uuid.nullable(),
    authority_revocation_reason: z.string().min(1).max(96).nullable(),
    compensation_command_id: uuid.nullable(),
    compensation_reversal_operation_id: uuid.nullable(),
    compensation_reversal_idempotency_key: key.nullable(),
    compensation_lifecycle_expected_version: integer.nullable(),
    compensation_amount_cents: integer.positive().nullable(),
    compensation_currency: currency.nullable(),
    compensation_requested_by: uuid.nullable(),
    compensation_created_at: timestamp.nullable(),
    compensation_semantic_limitation: z.literal('PRIOR_SECURED_STATE_NOT_RESTORED').nullable(),
  })
  .strict();
const receiptSchema = z
  .object({
    observation: projectionSchema,
    observed_at: timestamp,
    target_authority_id: uuid,
    release_manifest_digest: manifestDigest,
  })
  .strict();
function refuse(reason: string): never {
  throw Error('CHANGE_ORDER_RECOVERY_OBSERVATION_' + reason);
}

/** Observation does not authorize financial effects. Later commands must validate
 * their own live authority and exact evidence, even when this receipt is current. */
export class PostgresUniversalV1ChangeOrderRecoveryObservation {
  constructor(
    private readonly database: Pick<Database, 'transaction'> = db,
    private readonly authorize: () => ChangeOrderRecoveryClaimAuthority = authorizedChangeOrderRecoveryClaims
  ) {}

  async observe(
    raw: ChangeOrderRecoveryLease
  ): Promise<UniversalV1ChangeOrderRecoveryClaim | null> {
    const lease = Object.freeze(leaseSchema.parse(raw));
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
        'SELECT * FROM public.hxos_observe_fake_financial_change_order_recovery_v13($1,$2,$3,$4,$5,$6,$7,$8,$9)',
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
        ]
      );
      if (result.rowCount !== result.rows.length || result.rows.length > 1)
        return refuse('RECEIPT_CARDINALITY');
      let claim: UniversalV1ChangeOrderRecoveryClaim | null = null;
      if (result.rows.length) {
        const receipt = receiptSchema.parse(result.rows[0]),
          row = receipt.observation;
        if (
          receipt.target_authority_id !== lease.target_authority_id ||
          receipt.release_manifest_digest !== authority.manifestDigest ||
          row.proposal_id !== lease.proposal_id ||
          row.recovery_lease_id !== lease.recovery_lease_id ||
          row.lease_owner_id !== lease.lease_owner_id ||
          row.work_order_id !== lease.work_order_id ||
          row.request_sha256 !== lease.witness_request_sha256 ||
          Date.parse(receipt.observed_at) < Date.parse(lease.acquired_at) ||
          Date.parse(receipt.observed_at) >= Date.parse(lease.expires_at)
        )
          return refuse('RECEIPT_BINDING_MISMATCH');
        const compensationValues = Object.entries(row).filter(
          ([name]) => name.startsWith('compensation_') && name !== 'compensation_event_id'
        );
        if (
          row.compensation_command_id === null &&
          compensationValues.some(([, value]) => value !== null)
        )
          return refuse('COMPENSATION_IDENTITY_INVALID');
        if (
          (row.recovery_state.startsWith('COMPENSATION_') &&
            row.compensation_command_id === null) ||
          (row.recovery_state === 'COMPENSATION_SUCCEEDED' && row.compensation_event_id === null) ||
          (row.recovery_state === 'AMENDMENT_MATERIALIZED' &&
            (row.amendment_id === null || row.adjustment_event_id === null)) ||
          (row.recovery_state === 'ADJUSTMENT_SUCCEEDED' && row.adjustment_event_id === null)
        )
          return refuse('STATE_EVIDENCE_INCOMPLETE');
        claim = mapChangeOrderRecoveryObservation(row);
        if (claim.compensationCommand) Object.freeze(claim.compensationCommand);
        Object.freeze(claim);
      }
      if (JSON.stringify(authoritySchema.parse(this.authorize())) !== JSON.stringify(authority))
        return refuse('RELEASE_AUTHORITY_CHANGED');
      return claim;
    });
  }
}
