import { createHash, createHmac } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';

export const LOCAL_CERTIFICATION_IDENTITY_PROVIDER = 'local_certification_identity';
export const LOCAL_CERTIFICATION_IDENTITY_POLICY_VERSION = 'hxos-private-identity-local-test-v1';
export const LOCAL_CERTIFICATION_IDENTITY_PURPOSE =
  'Exercise the private identity evidence, expiry, revocation, and environment gates for CONTROLLED_TEST work only; no external identity document is collected or verified.';
export const LOCAL_CERTIFICATION_IDENTITY_DISCLOSURE_HASH = createHash('sha256')
  .update(LOCAL_CERTIFICATION_IDENTITY_PURPOSE)
  .digest('hex');

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface PrepareLocalTestIdentityParams {
  userId: string;
  idempotencyKey: string;
}

export interface CompleteLocalTestIdentityParams {
  userId: string;
  caseId: string;
  actorId: string;
  idempotencyKey: string;
}

export interface LocalTestIdentityResult {
  caseId: string;
  status: 'PENDING' | 'PROCESSING' | 'VERIFIED' | 'REVOKED';
  provider: typeof LOCAL_CERTIFICATION_IDENTITY_PROVIDER;
  environment: 'CONTROLLED_TEST';
  isTest: true;
  idempotencyReplayed: boolean;
}

interface ConsentRow { id: string; disclosure_hash: string; }
interface BeginRow { case_id: string; case_status: LocalTestIdentityResult['status']; idempotency_replayed: boolean; }
interface CaseRow {
  id: string;
  user_id: string;
  status: LocalTestIdentityResult['status'];
  provider_case_id: string;
  request_hash: string;
  is_test: boolean;
}
interface EventRow { case_status: LocalTestIdentityResult['status']; identity_verified: boolean; idempotency_replayed: boolean; }

function failure(code: string, message: string): ServiceResult<never> {
  return { success: false, error: { code, message } };
}

function secret(env: Environment = process.env): string {
  return env.HXOS_LOCAL_TEST_IDENTITY_SECRET?.trim() ?? '';
}

function hmac(value: string, env: Environment = process.env): string {
  return createHmac('sha256', secret(env)).update(value).digest('hex');
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validKey(value: string): boolean {
  return value.trim().length >= 8 && value.length <= 200 && /^[A-Za-z0-9:_-]+$/.test(value);
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function localCertificationIdentityEnabled(env: Environment = process.env): boolean {
  return env.NODE_ENV !== 'production'
    && env.HXOS_ALLOW_LOCAL_TEST_IDENTITY === 'true'
    && env.ENGINE_API_MODE === 'test'
    && env.STRIPE_MODE === 'test'
    && secret(env).length >= 32;
}

function providerCaseId(userId: string, key: string): string {
  return `idv_hxos_test_${hmac(`identity:${userId}:${key}`).slice(0, 32)}`;
}

async function enableTestAuthority(query: QueryFn): Promise<void> {
  await query(`SELECT set_config('hustlexp.local_test_identity_enabled','true',true)`);
}

function result(
  caseId: string,
  status: LocalTestIdentityResult['status'],
  idempotencyReplayed: boolean,
): ServiceResult<LocalTestIdentityResult> {
  return { success: true, data: {
    caseId,
    status,
    provider: LOCAL_CERTIFICATION_IDENTITY_PROVIDER,
    environment: 'CONTROLLED_TEST',
    isTest: true,
    idempotencyReplayed,
  } };
}

export const LocalCertificationIdentityProvider = {
  async prepare(params: PrepareLocalTestIdentityParams): Promise<ServiceResult<LocalTestIdentityResult>> {
    if (!localCertificationIdentityEnabled()) {
      return failure('LOCAL_TEST_IDENTITY_DISABLED', 'Local certification identity is disabled.');
    }
    if (!validUuid(params.userId) || !validKey(params.idempotencyKey)) {
      return failure('LOCAL_TEST_IDENTITY_INVALID', 'Local certification identity input is invalid.');
    }
    const requestHash = digest({ userId: params.userId, policy: LOCAL_CERTIFICATION_IDENTITY_POLICY_VERSION });
    const caseRef = providerCaseId(params.userId, params.idempotencyKey);
    try {
      return await db.transaction(async (query) => {
        await query(`SELECT pg_advisory_xact_lock(hashtext('local-test-identity'),hashtext($1))`, [params.idempotencyKey]);
        await enableTestAuthority(query);
        const existingConsent = await query<ConsentRow>(
          `SELECT id,disclosure_hash FROM identity_verification_consents
            WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [params.userId, `consent:${params.idempotencyKey}`],
        );
        let consent = existingConsent.rows[0];
        if (consent && consent.disclosure_hash !== LOCAL_CERTIFICATION_IDENTITY_DISCLOSURE_HASH) {
          return failure('LOCAL_TEST_IDENTITY_IDEMPOTENCY_CONFLICT', 'Identity consent replay conflicts with prior evidence.');
        }
        if (!consent) {
          const inserted = await query<ConsentRow>(
            `INSERT INTO identity_verification_consents(
               user_id,provider,provider_environment,is_test,policy_version,
               disclosure_hash,purpose,idempotency_key
             ) VALUES($1,$2,'CONTROLLED_TEST',TRUE,$3,$4,$5,$6)
             RETURNING id,disclosure_hash`,
            [params.userId, LOCAL_CERTIFICATION_IDENTITY_PROVIDER,
              LOCAL_CERTIFICATION_IDENTITY_POLICY_VERSION,
              LOCAL_CERTIFICATION_IDENTITY_DISCLOSURE_HASH,
              LOCAL_CERTIFICATION_IDENTITY_PURPOSE, `consent:${params.idempotencyKey}`],
          );
          consent = inserted.rows[0];
        }
        if (!consent) return failure('DB_ERROR', 'Identity consent could not be persisted.');
        const begun = await query<BeginRow>(
          `SELECT * FROM begin_identity_verification_case_v1(
             $1,$2,$3,$4,'CONTROLLED_TEST',TRUE,$5,$6,NOW()+INTERVAL '90 days'
           )`,
          [params.userId, consent.id, LOCAL_CERTIFICATION_IDENTITY_PROVIDER, caseRef,
            LOCAL_CERTIFICATION_IDENTITY_POLICY_VERSION, requestHash],
        );
        const row = begun.rows[0];
        if (!row) return failure('DB_ERROR', 'Identity case could not be persisted.');
        return result(row.case_id, row.case_status, row.idempotency_replayed);
      });
    } catch {
      return failure('DB_ERROR', 'Local certification identity could not be prepared.');
    }
  },

  async completeVerified(params: CompleteLocalTestIdentityParams): Promise<ServiceResult<LocalTestIdentityResult>> {
    if (!localCertificationIdentityEnabled()) {
      return failure('LOCAL_TEST_IDENTITY_DISABLED', 'Local certification identity is disabled.');
    }
    if (!validUuid(params.userId) || !validUuid(params.caseId) || !validUuid(params.actorId)
      || !validKey(params.idempotencyKey)) {
      return failure('LOCAL_TEST_IDENTITY_INVALID', 'Local certification identity input is invalid.');
    }
    try {
      return await db.transaction(async (query) => {
        await query(`SELECT pg_advisory_xact_lock(hashtext('local-test-identity-case'),hashtext($1))`, [params.caseId]);
        await enableTestAuthority(query);
        const found = await query<CaseRow>(
          `SELECT id,user_id,status,provider_case_id,request_hash,is_test
             FROM identity_verification_cases
            WHERE id=$1 AND user_id=$2 AND provider=$3
              AND provider_environment='CONTROLLED_TEST' AND is_test IS TRUE
            FOR UPDATE`,
          [params.caseId, params.userId, LOCAL_CERTIFICATION_IDENTITY_PROVIDER],
        );
        const identityCase = found.rows[0];
        if (!identityCase) return failure('LOCAL_TEST_IDENTITY_NOT_FOUND', 'Controlled TEST identity case not found.');
        if (identityCase.status === 'PENDING') {
          await query<EventRow>(
            `SELECT * FROM record_identity_verification_event_v1(
               $1,$2,$3,'PROCESSING',$4,NULL,NOW(),NULL,$5
             )`,
            [params.userId, params.caseId, `processing:${identityCase.provider_case_id}`,
              digest({ caseId: params.caseId, status: 'PROCESSING' }), params.actorId],
          );
        }
        const evidenceHash = digest({
          caseId: params.caseId,
          providerCaseId: identityCase.provider_case_id,
          requestHash: identityCase.request_hash,
          result: 'CONTROLLED_TEST_VERIFIED',
        });
        const providerEventId = `verified:${hmac(`${params.caseId}:${params.idempotencyKey}`).slice(0, 48)}`;
        const verified = await query<EventRow>(
          `SELECT * FROM record_identity_verification_event_v1(
             $1,$2,$3,'VERIFIED',$4,$5,NOW(),NOW()+INTERVAL '90 days',$6
           )`,
          [params.userId, params.caseId, providerEventId,
            digest({ providerEventId, evidenceHash }), evidenceHash, params.actorId],
        );
        const row = verified.rows[0];
        if (!row || !row.identity_verified) {
          return failure('LOCAL_TEST_IDENTITY_NOT_VERIFIED', 'Controlled TEST identity did not reach verified state.');
        }
        return result(params.caseId, 'VERIFIED', row.idempotency_replayed);
      });
    } catch {
      return failure('DB_ERROR', 'Local certification identity could not be completed.');
    }
  },
};
