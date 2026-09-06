import { z } from 'zod';
import { db, type Database } from '../db.js';
import { authorizedChangeOrderReversalRequests } from './payment/UniversalV1ChangeOrderReversalRequest.js';

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
const environment = z.enum(['local', 'preview', 'staging']);
// JSON timestamps preserve the original PostgreSQL fractional seconds. Only the
// driver's top-level timestamptz and lease Date values need normalization.
const timestamp = z.string().datetime({ offset: true });
const driverTimestamp = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  timestamp
);
const revocationReason = z.enum([
  'PROPOSAL_NOT_APPROVED',
  'TASK_AUTHORITY_REVOKED',
  'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
  'CUSTOMER_APPROVAL_AUTHORITY_REVOKED',
  'PROVIDER_ACTOR_AUTHORITY_REVOKED',
  'PROVIDER_APPROVAL_AUTHORITY_REVOKED',
  'PROVIDER_ELIGIBILITY_REVOKED',
  'EXECUTION_AUTHORITY_REVOKED',
  'FINANCIAL_SECURITY_EXPIRED',
]);
const authoritySchema = z
  .object({
    databaseName: z.string().min(1).max(63),
    serviceLogin: z.string().min(1).max(63),
    environment,
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
    acquired_at: driverTimestamp,
    expires_at: driverTimestamp,
    target_authority_id: uuid,
    release_manifest_digest: manifestDigest,
  })
  .strict();
const commonInput = { lease: leaseSchema, actorUserId: uuid };
const commandSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...commonInput,
        kind: z.literal('MATERIALIZED'),
        amendmentId: uuid,
        adjustmentEventId: uuid,
      })
      .strict(),
    z
      .object({
        ...commonInput,
        kind: z.literal('COMPENSATED'),
        compensationCommandId: uuid,
        compensationEventId: uuid,
        adjustmentEventId: uuid,
      })
      .strict(),
    z
      .object({
        ...commonInput,
        kind: z.literal('NO_EFFECT'),
        adjustmentEventId: uuid.nullable(),
        noEffectOutcomeFactId: uuid.nullable(),
        authorityRevocationReason: revocationReason.nullable(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (Date.parse(value.lease.expires_at) <= Date.parse(value.lease.acquired_at))
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'LEASE_WINDOW_INVALID' });
    if (
      value.kind === 'NO_EFFECT' &&
      (value.noEffectOutcomeFactId === null) === (value.authorityRevocationReason === null)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'EXACT_NO_EFFECT_EVIDENCE_REQUIRED',
      });
    if (
      value.kind === 'NO_EFFECT' &&
      value.authorityRevocationReason !== null &&
      value.adjustmentEventId !== null
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'NO_DISPATCH_EVENT_FORBIDDEN' });
  });
const metadataSchema = z
  .object({
    session_database_role: z.string(),
    target_authority_id: uuid,
    target_database_name: z.string(),
    environment,
    release_manifest_sha256: manifestDigest,
  })
  .strict();
const commonFact = {
  terminal_fact_id: uuid,
  proposal_id: uuid,
  witness_request_sha256: digest,
  recovery_lease_id: uuid,
  lease_owner_id: uuid,
  prior_secured_state_restored: z.literal(false),
  capture_resume_authorized: z.literal(false),
  payment_creation_performed: z.literal(false),
  hard_assignment_created: z.literal(false),
  recorded_by: uuid,
  recorded_at: timestamp,
  terminal_fact_sha256: digest,
};
const cancellation = {
  outcome_state: z.literal('CANCELLED'),
  recovery_state: z.literal('RECOVERY_REQUIRED'),
  hold_clearance_kind: z.literal('BOUNDED_CANCELLATION_RECOVERY'),
  execution_resume_authorized: z.literal(false),
};
const terminalSchema = z.discriminatedUnion('resolution_evidence_kind', [
  z
    .object({
      ...commonFact,
      resolution_evidence_kind: z.literal('AMENDMENT'),
      outcome_state: z.literal('MATERIALIZED'),
      recovery_state: z.literal('NOT_REQUIRED'),
      amendment_id: uuid,
      adjustment_event_id: uuid,
      compensation_command_id: z.null(),
      compensation_event_id: z.null(),
      no_effect_outcome_fact_id: z.null(),
      authority_revocation_reason: z.null(),
      hold_clearance_kind: z.literal('EXACT_AMENDMENT'),
      execution_resume_authorized: z.literal(true),
    })
    .strict(),
  z
    .object({
      ...commonFact,
      ...cancellation,
      resolution_evidence_kind: z.literal('REVERSAL'),
      amendment_id: z.null(),
      adjustment_event_id: uuid,
      compensation_command_id: uuid,
      compensation_event_id: uuid,
      no_effect_outcome_fact_id: z.null(),
      authority_revocation_reason: z.null(),
    })
    .strict(),
  z
    .object({
      ...commonFact,
      ...cancellation,
      resolution_evidence_kind: z.literal('NO_EFFECT'),
      amendment_id: z.null(),
      adjustment_event_id: uuid.nullable(),
      compensation_command_id: z.null(),
      compensation_event_id: z.null(),
      no_effect_outcome_fact_id: uuid.nullable(),
      authority_revocation_reason: revocationReason.nullable(),
    })
    .strict(),
]);
const receiptSchema = z
  .object({
    terminal_fact: terminalSchema,
    idempotency_replayed: z.boolean(),
    observed_at: driverTimestamp,
    target_authority_id: uuid,
    release_manifest_digest: manifestDigest,
  })
  .strict();
export type ChangeOrderTerminalCommand = z.infer<typeof commandSchema>;
export type ChangeOrderTerminalAuthority = Readonly<z.infer<typeof authoritySchema>>;
export interface ChangeOrderTerminalReceipt {
  readonly terminalFact: Readonly<z.infer<typeof terminalSchema>>;
  readonly idempotencyReplayed: boolean;
  readonly observedAt: string;
  readonly targetAuthorityId: string;
  readonly releaseManifestDigest: string;
}
function refuse(reason: string): never {
  throw new Error('CHANGE_ORDER_TERMINAL_' + reason);
}

export function authorizedChangeOrderRecoveryTerminals(): ChangeOrderTerminalAuthority {
  // Reuse the installed worker manifest/signature and runtime identity check.
  const verified = authorizedChangeOrderReversalRequests();
  return Object.freeze(
    authoritySchema.parse({
      databaseName: verified.databaseName,
      serviceLogin: verified.serviceLogin,
      environment: verified.environment,
      manifestDigest: verified.manifestDigest,
      targetDigest: verified.targetDigest,
    })
  );
}

/** Records one exact terminal outcome. It performs no financial request,
 * provider execution, amendment, assignment, or capture resumption. */
export class PostgresUniversalV1ChangeOrderRecoveryTerminals {
  constructor(
    private readonly database: Pick<Database, 'transaction'> = db,
    private readonly authorize: () => ChangeOrderTerminalAuthority = authorizedChangeOrderRecoveryTerminals
  ) {}
  async record(raw: ChangeOrderTerminalCommand): Promise<ChangeOrderTerminalReceipt> {
    const input = commandSchema.parse(raw);
    Object.freeze(input.lease);
    Object.freeze(input);
    const authority = Object.freeze(authoritySchema.parse(this.authorize()));
    const stableAuthority = () => {
      if (JSON.stringify(authoritySchema.parse(this.authorize())) !== JSON.stringify(authority))
        return refuse('AUTHORITY_CHANGED');
    };
    const result = await this.database.transaction(async (query) => {
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
        target.release_manifest_sha256 !== authority.manifestDigest
      )
        return refuse('TARGET_BINDING_MISMATCH');
      const evidence =
        input.kind === 'MATERIALIZED'
          ? [input.amendmentId, input.adjustmentEventId]
          : input.kind === 'COMPENSATED'
            ? [input.compensationCommandId, input.compensationEventId]
            : [input.noEffectOutcomeFactId, input.authorityRevocationReason];
      const sql =
        input.kind === 'MATERIALIZED'
          ? 'SELECT * FROM public.hxos_record_fake_financial_change_order_materialized_v13($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)'
          : input.kind === 'COMPENSATED'
            ? 'SELECT * FROM public.hxos_record_fake_financial_change_order_compensated_v13($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)'
            : 'SELECT * FROM public.hxos_record_fake_financial_change_order_no_effect_v13($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)';
      // A historical lease may precede the current target. SQL validates both the
      // immutable lease and each branch's historical evidence under current custody.
      const reply = await query(sql, [
        target.target_authority_id,
        authority.databaseName,
        authority.environment,
        authority.manifestDigest,
        input.lease.proposal_id,
        input.lease.recovery_lease_id,
        input.lease.lease_owner_id,
        input.lease.witness_request_sha256,
        input.lease.work_order_id,
        ...evidence,
      ]);
      if (reply.rowCount !== 1 || reply.rows.length !== 1) return refuse('RECEIPT_CARDINALITY');
      const receipt = receiptSchema.parse(reply.rows[0]);
      const fact = receipt.terminal_fact;
      const observed = Date.parse(receipt.observed_at);
      const recorded = Date.parse(fact.recorded_at);
      if (
        receipt.target_authority_id !== target.target_authority_id ||
        receipt.release_manifest_digest !== authority.manifestDigest ||
        fact.proposal_id !== input.lease.proposal_id ||
        fact.recovery_lease_id !== input.lease.recovery_lease_id ||
        fact.lease_owner_id !== input.lease.lease_owner_id ||
        fact.witness_request_sha256 !== input.lease.witness_request_sha256 ||
        fact.recorded_by !== input.actorUserId ||
        fact.adjustment_event_id !== input.adjustmentEventId ||
        recorded < Date.parse(input.lease.acquired_at) ||
        recorded >= Date.parse(input.lease.expires_at) ||
        recorded > observed ||
        (!receipt.idempotency_replayed && observed >= Date.parse(input.lease.expires_at))
      )
        return refuse('RECEIPT_BINDING_MISMATCH');
      if (input.kind === 'MATERIALIZED') {
        if (
          fact.resolution_evidence_kind !== 'AMENDMENT' ||
          fact.amendment_id !== input.amendmentId
        )
          return refuse('AMENDMENT_BINDING_MISMATCH');
      } else if (input.kind === 'COMPENSATED') {
        if (
          fact.resolution_evidence_kind !== 'REVERSAL' ||
          fact.compensation_command_id !== input.compensationCommandId ||
          fact.compensation_event_id !== input.compensationEventId
        )
          return refuse('COMPENSATION_BINDING_MISMATCH');
      } else if (
        fact.resolution_evidence_kind !== 'NO_EFFECT' ||
        fact.no_effect_outcome_fact_id !== input.noEffectOutcomeFactId ||
        fact.authority_revocation_reason !== input.authorityRevocationReason
      )
        return refuse('NO_EFFECT_BINDING_MISMATCH');
      stableAuthority();
      return Object.freeze({
        terminalFact: Object.freeze(fact),
        idempotencyReplayed: receipt.idempotency_replayed,
        observedAt: receipt.observed_at,
        targetAuthorityId: receipt.target_authority_id,
        releaseManifestDigest: receipt.release_manifest_digest,
      });
    });
    // A post-COMMIT authority change is an uncertain result; exact replay recovers
    // the original fact, including after its lease or participant access expires.
    stableAuthority();
    return result;
  }
}
