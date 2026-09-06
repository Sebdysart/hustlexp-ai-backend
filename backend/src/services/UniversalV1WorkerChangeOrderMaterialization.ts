import { z } from 'zod';
import { db, type Database } from '../db.js';
import { MaterializedChangeOrderResultSchema } from '../auth/change-order-materialization-command-contract.js';
import { FinancialProgressUuidSchema as uuid } from '../auth/financial-progress-command-contract.js';
import {
  authorizedChangeOrderRecoveryTerminals,
  type ChangeOrderTerminalAuthority,
} from './UniversalV1ChangeOrderRecoveryTerminals.js';

const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .refine((value) => value !== '0'.repeat(64));
const manifest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u)
  .refine((value) => value !== 'sha256:' + '0'.repeat(64));
const environment = z.enum(['local', 'preview', 'staging']);
const timestamp = z.string().datetime({ offset: true });
const driverTimestamp = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  timestamp
);
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
    acquired_at: driverTimestamp,
    expires_at: driverTimestamp,
    target_authority_id: uuid,
    release_manifest_digest: manifest,
  })
  .strict();
const commandSchema = z
  .object({
    lease: leaseSchema,
    adjustmentEventId: uuid,
    actorUserId: uuid,
    replacementScopeVersionId: uuid,
    replacementScopeVersion: z.number().int().positive().max(2147483647),
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
const originSchema = z
  .object({
    amendment_id: uuid,
    execution_fact_id: uuid,
    proposal_id: uuid,
    recovery_lease_id: uuid,
    lease_owner_id: uuid,
    target_authority_id: uuid,
    release_environment: environment,
    release_manifest_digest: manifest,
    service_database_role: z.string().min(1).max(63),
    witness_request_sha256: digest,
    adjustment_event_id: uuid,
    recorded_at: timestamp,
  })
  .strict();
const receiptSchema = z
  .object({
    result: MaterializedChangeOrderResultSchema,
    worker_origin: originSchema.nullable(),
    actor_user_id: uuid,
    observed_at: driverTimestamp,
    target_authority_id: uuid,
    release_manifest_digest: manifest,
  })
  .strict();

export type WorkerChangeOrderMaterializationCommand = Readonly<z.infer<typeof commandSchema>>;
export type WorkerChangeOrderMaterializationOrigin = Readonly<z.infer<typeof originSchema>>;
export interface WorkerChangeOrderMaterializationReceipt {
  readonly result: Readonly<z.infer<typeof MaterializedChangeOrderResultSchema>>;
  readonly workerOrigin: WorkerChangeOrderMaterializationOrigin | null;
  readonly observedAt: string;
}

function refuse(reason: string): never {
  throw Error('WORKER_CHANGE_ORDER_MATERIALIZATION_' + reason);
}

/** Materializes only the exact approved amendment following an admitted ADJUST.
 * The existing worker release authority applies; SQL owns ancestry, current
 * domain gates and historical replay. Financial execution and terminal recording
 * remain separate commands. */
export class PostgresUniversalV1WorkerChangeOrderMaterialization {
  constructor(
    private readonly database: Pick<Database, 'transaction'> = db,
    private readonly authorize: () => ChangeOrderTerminalAuthority = authorizedChangeOrderRecoveryTerminals
  ) {}

  async materialize(
    raw: WorkerChangeOrderMaterializationCommand
  ): Promise<WorkerChangeOrderMaterializationReceipt> {
    const parsed = commandSchema.parse(raw);
    const command = Object.freeze({ ...parsed, lease: Object.freeze(parsed.lease) });
    const lease = command.lease;
    if (Date.parse(lease.acquired_at) >= Date.parse(lease.expires_at))
      return refuse('LEASE_WINDOW_INVALID');
    const authority = Object.freeze(authoritySchema.parse(this.authorize()));
    const assertAuthority = () => {
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
      // A fresh process may legitimately see a successor target. The immutable
      // input lease and stored worker origin are never retargeted.
      const rows = await query(
        'SELECT * FROM public.hxos_finalize_worker_change_order_v13($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
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
          command.adjustmentEventId,
        ]
      );
      if (rows.rowCount !== 1 || rows.rows.length !== 1) return refuse('RECEIPT_CARDINALITY');
      const receipt = receiptSchema.parse(rows.rows[0]),
        materialized = receipt.result,
        origin = receipt.worker_origin;
      const observed = Date.parse(receipt.observed_at);
      if (
        receipt.actor_user_id !== command.actorUserId ||
        receipt.target_authority_id !== target.target_authority_id ||
        receipt.release_manifest_digest !== authority.manifestDigest ||
        materialized.proposal_id !== lease.proposal_id ||
        materialized.adjustment_event_id !== command.adjustmentEventId ||
        materialized.provider_kind !== 'FAKE' ||
        materialized.scope_version_id !== command.replacementScopeVersionId ||
        materialized.scope_version !== command.replacementScopeVersion ||
        observed < Date.parse(lease.acquired_at)
      )
        return refuse('RECEIPT_BINDING_MISMATCH');
      if (
        origin &&
        (origin.amendment_id !== materialized.amendment_id ||
          origin.proposal_id !== lease.proposal_id ||
          origin.adjustment_event_id !== command.adjustmentEventId ||
          origin.witness_request_sha256 !== lease.witness_request_sha256 ||
          origin.release_environment !== authority.environment ||
          Date.parse(origin.recorded_at) > observed)
      )
        return refuse('ORIGIN_BINDING_MISMATCH');
      if (
        !materialized.replayed &&
        (!origin ||
          origin.recovery_lease_id !== lease.recovery_lease_id ||
          origin.lease_owner_id !== lease.lease_owner_id ||
          origin.target_authority_id !== target.target_authority_id ||
          origin.release_manifest_digest !== authority.manifestDigest ||
          origin.service_database_role !== authority.serviceLogin ||
          Date.parse(origin.recorded_at) < Date.parse(lease.acquired_at) ||
          observed >= Date.parse(lease.expires_at))
      )
        return refuse('NEW_EFFECT_BINDING_MISMATCH');
      assertAuthority();
      return Object.freeze({
        result: Object.freeze(materialized),
        workerOrigin: origin ? Object.freeze(origin) : null,
        observedAt: receipt.observed_at,
      });
    });
    // A failure here is an uncertain acknowledgement. Retry exact immutable
    // command identity and let SQL return the original committed amendment.
    assertAuthority();
    return result;
  }
}
