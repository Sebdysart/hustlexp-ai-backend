import { z } from 'zod';
import { db, type Database } from '../db.js';
import { releaseManifestDigest } from '../releaseManifest.js';
import { configuredRuntimeDatabaseStartup } from '../jobs/runtime-database-startup-config.js';
import { assertNonproductionFakeFinanceAuthorized } from './payment/NonproductionFinancialAuthorization.js';

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
  z.string().datetime()
);
const inputSchema = z
  .object({
    leaseOwnerId: uuid,
    limit: z.number().int().min(1).max(100),
    leaseDurationSeconds: z.number().int().min(5).max(900),
    minimumAgeSeconds: z.number().int().min(5).max(3600),
  })
  .strict();
const authoritySchema = z
  .object({
    databaseName: z.string().min(1).max(63),
    serviceLogin: z.string().min(1).max(63),
    environment: z.enum(['local', 'preview', 'staging']),
    manifestDigest,
    targetDigest: manifestDigest,
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
const receiptSchema = z
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
export type ChangeOrderRecoveryClaimInput = z.infer<typeof inputSchema>;
export type ChangeOrderRecoveryClaimAuthority = z.infer<typeof authoritySchema>;
export type ChangeOrderRecoveryLease = Readonly<z.infer<typeof receiptSchema>>;
function refuse(reason: string): never {
  throw Error('CHANGE_ORDER_RECOVERY_CLAIM_' + reason);
}

export function authorizedChangeOrderRecoveryClaims(): ChangeOrderRecoveryClaimAuthority {
  const manifest = assertNonproductionFakeFinanceAuthorized({ component: 'worker' });
  const runtime = configuredRuntimeDatabaseStartup('worker');
  if (manifest.environment !== runtime.expectedTarget.environment)
    return refuse('WORKER_RELEASE_REQUIRED');
  return Object.freeze(
    authoritySchema.parse({
      databaseName: runtime.expectedTarget.databaseName,
      serviceLogin: runtime.target.serviceLogin,
      environment: manifest.environment,
      manifestDigest: releaseManifestDigest(manifest),
      targetDigest: runtime.targetDigest,
    })
  );
}

/** Worker-only lease port. Each later observation or write must revalidate this
 * identity and current authority; a lease alone authorizes no financial effect. */
export class PostgresUniversalV1ChangeOrderRecoveryClaims {
  constructor(
    private readonly database: Pick<Database, 'transaction'> = db,
    private readonly authorize: () => ChangeOrderRecoveryClaimAuthority = authorizedChangeOrderRecoveryClaims
  ) {}
  async claimDue(raw: ChangeOrderRecoveryClaimInput): Promise<readonly ChangeOrderRecoveryLease[]> {
    const input = Object.freeze(inputSchema.parse(raw));
    const authority = Object.freeze(authoritySchema.parse(this.authorize()));
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
        target.release_manifest_sha256 !== authority.manifestDigest
      )
        return refuse('TARGET_BINDING_MISMATCH');
      const result = await query(
        'SELECT * FROM public.hxos_claim_fake_financial_change_order_recovery_v13($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          target.target_authority_id,
          authority.databaseName,
          authority.environment,
          authority.manifestDigest,
          input.leaseOwnerId,
          input.limit,
          input.leaseDurationSeconds,
          input.minimumAgeSeconds,
        ]
      );
      if (result.rowCount !== result.rows.length || result.rows.length > input.limit)
        return refuse('RECEIPT_CARDINALITY');
      const proposals = new Set<string>(),
        leases = new Set<string>();
      const claims = result.rows.map((rawRow) => {
        const row = receiptSchema.parse(rawRow);
        if (
          row.lease_owner_id !== input.leaseOwnerId ||
          row.target_authority_id !== target.target_authority_id ||
          row.release_manifest_digest !== authority.manifestDigest ||
          Date.parse(row.expires_at) - Date.parse(row.acquired_at) !==
            input.leaseDurationSeconds * 1000 ||
          proposals.has(row.proposal_id) ||
          leases.has(row.recovery_lease_id)
        )
          return refuse('RECEIPT_BINDING_MISMATCH');
        proposals.add(row.proposal_id);
        leases.add(row.recovery_lease_id);
        return Object.freeze(row);
      });
      // A mismatched receipt or changed installed release must roll back its leases.
      if (JSON.stringify(authoritySchema.parse(this.authorize())) !== JSON.stringify(authority))
        return refuse('RELEASE_AUTHORITY_CHANGED');
      return Object.freeze(claims);
    });
  }
}
