import { createHash, createHmac } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';
import { recomputeCapabilityProfile } from './CapabilityRecomputeService.js';
import {
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
  LOCAL_CERTIFICATION_SCREENING_PROVIDER,
} from './WorkerScreeningRightsPolicy.js';

const REPORT_RE = /^scr_hxos_test_[a-f0-9]{32}$/;
const RESULT_SUMMARY = 'Controlled TEST eligibility fixture passed. No external criminal-history or consumer report was ordered.';
type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

interface ConsentRow {
  id: string;
  worker_id: string;
  provider: string;
  disclosure_version: string;
  disclosure_hash: string;
  revoked_at: Date | string | null;
}

interface InitiationReplayRow {
  id: string;
  background_check_id: string;
  worker_id: string;
  consent_id: string;
  status: 'PENDING' | 'PROCESSING' | 'CLEAR';
  check_status: 'PENDING' | 'IN_PROGRESS' | 'CLEAR';
  request_hash: string;
  idempotency_key: string;
  is_test: boolean;
}

interface CompletionRow {
  id: string;
  background_check_id: string;
  worker_id: string;
  consent_id: string;
  report_status: 'PENDING' | 'PROCESSING' | 'CLEAR';
  check_status: 'PENDING' | 'IN_PROGRESS' | 'CLEAR';
  is_test: boolean;
}

export interface InitiateLocalTestScreeningParams {
  workerId: string;
  consentId: string;
  idempotencyKey: string;
}

export interface CompleteLocalTestScreeningParams {
  backgroundCheckId: string;
  workerId: string;
  actorId: string;
  idempotencyKey: string;
}

function failure(code: string, message: string): ServiceResult<never> {
  return { success: false, error: { code, message } };
}

function secret(env: Environment = process.env): string {
  return env.HXOS_LOCAL_TEST_SCREENING_SECRET?.trim() ?? '';
}

function hmac(value: string, env: Environment = process.env): string {
  return createHmac('sha256', secret(env)).update(value).digest('hex');
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function providerReportId(workerId: string, consentId: string): string {
  return `scr_hxos_test_${hmac(`screening:${workerId}:${consentId}`).slice(0, 32)}`;
}

function validIdempotencyKey(value: string): boolean {
  return value.trim().length >= 8 && value.length <= 200 && /^[A-Za-z0-9:_-]+$/.test(value);
}

export function localCertificationScreeningEnabled(env: Environment = process.env): boolean {
  return env.NODE_ENV !== 'production'
    && env.HXOS_ALLOW_LOCAL_TEST_SCREENING === 'true'
    && env.ENGINE_API_MODE === 'test'
    && env.STRIPE_MODE === 'test'
    && secret(env).length >= 32;
}

export function isLocalCertificationScreeningReportId(value: string): boolean {
  return REPORT_RE.test(value);
}

async function enableTransactionMarker(query: QueryFn): Promise<void> {
  await query(`SELECT set_config('hustlexp.local_test_screening_enabled', 'true', true)`);
}

async function loadConsent(
  query: QueryFn,
  params: InitiateLocalTestScreeningParams,
): Promise<ConsentRow | null> {
  const result = await query<ConsentRow>(
    `SELECT id, worker_id, provider, disclosure_version, disclosure_hash, revoked_at
     FROM worker_screening_consents
     WHERE id = $1
       AND worker_id = $2
       AND provider = $3
       AND disclosure_version = $4
       AND disclosure_hash = $5
       AND consent_granted IS TRUE
       AND revoked_at IS NULL
     FOR SHARE`,
    [
      params.consentId,
      params.workerId,
      LOCAL_CERTIFICATION_SCREENING_PROVIDER,
      LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
      LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
    ],
  );
  return result.rows[0] ?? null;
}

function initiationHash(params: InitiateLocalTestScreeningParams): string {
  return digest({
    workerId: params.workerId,
    consentId: params.consentId,
    provider: LOCAL_CERTIFICATION_SCREENING_PROVIDER,
  });
}

async function findInitiationReplay(
  query: QueryFn,
  params: InitiateLocalTestScreeningParams,
  reportId: string,
): Promise<InitiationReplayRow | null> {
  const result = await query<InitiationReplayRow>(
    `SELECT report.id, report.background_check_id, report.worker_id, report.consent_id,
            report.status, background.status AS check_status, report.request_hash,
            report.idempotency_key, report.is_test
     FROM hxos_local_test_screening_reports report
     JOIN background_checks background ON background.id = report.background_check_id
     WHERE (report.worker_id = $1 AND report.idempotency_key = $2)
        OR report.id = $3
     ORDER BY CASE WHEN report.idempotency_key = $2 THEN 0 ELSE 1 END
     LIMIT 1
     FOR UPDATE OF report, background`,
    [params.workerId, params.idempotencyKey, reportId],
  );
  return result.rows[0] ?? null;
}

function initiationResult(
  row: InitiationReplayRow,
  replayed: boolean,
): ServiceResult<{
  backgroundCheckId: string;
  providerReportId: string;
  provider: typeof LOCAL_CERTIFICATION_SCREENING_PROVIDER;
  status: 'PENDING' | 'IN_PROGRESS' | 'CLEAR';
  isTest: true;
  idempotencyReplayed: boolean;
}> {
  const status = row.check_status === 'IN_PROGRESS' ? 'IN_PROGRESS' : row.check_status;
  return {
    success: true,
    data: {
      backgroundCheckId: row.background_check_id,
      providerReportId: row.id,
      provider: LOCAL_CERTIFICATION_SCREENING_PROVIDER,
      status,
      isTest: true,
      idempotencyReplayed: replayed,
    },
  };
}

export const LocalCertificationScreeningProvider = {
  initiate: async (
    params: InitiateLocalTestScreeningParams,
  ): Promise<ServiceResult<{
    backgroundCheckId: string;
    providerReportId: string;
    provider: typeof LOCAL_CERTIFICATION_SCREENING_PROVIDER;
    status: 'PENDING' | 'IN_PROGRESS' | 'CLEAR';
    isTest: true;
    idempotencyReplayed: boolean;
  }>> => {
    if (!localCertificationScreeningEnabled()) {
      return failure('LOCAL_TEST_SCREENING_DISABLED', 'Local certification screening is disabled.');
    }
    if (!validIdempotencyKey(params.idempotencyKey)) {
      return failure('LOCAL_TEST_SCREENING_INVALID', 'Local certification screening idempotency key is invalid.');
    }
    const reportId = providerReportId(params.workerId, params.consentId);
    const requestHash = initiationHash(params);
    try {
      return await db.transaction(async (query) => {
        await query(
          `SELECT pg_advisory_xact_lock(hashtext('local-test-screening'), hashtext($1))`,
          [params.idempotencyKey],
        );
        await enableTransactionMarker(query);
        const consent = await loadConsent(query, params);
        if (!consent) {
          return failure(
            'LOCAL_TEST_SCREENING_CONSENT_REQUIRED',
            'Active consent for the named local TEST provider is required.',
          );
        }

        const replay = await findInitiationReplay(query, params, reportId);
        if (replay) {
          if (
            replay.request_hash !== requestHash
            || replay.worker_id !== params.workerId
            || replay.consent_id !== params.consentId
            || replay.is_test !== true
          ) {
            return failure(
              'LOCAL_TEST_SCREENING_IDEMPOTENCY_CONFLICT',
              'Local certification screening idempotency conflict.',
            );
          }
          return initiationResult(replay, true);
        }

        const active = await query<{ id: string; status: string }>(
          `SELECT id, status
           FROM background_checks
           WHERE user_id = $1
             AND status IN ('PENDING', 'IN_PROGRESS', 'CLEAR')
             AND (expires_at IS NULL OR expires_at > CURRENT_DATE + INTERVAL '30 days')
           ORDER BY initiated_at DESC
           LIMIT 1
           FOR UPDATE`,
          [params.workerId],
        );
        if (active.rows[0]) {
          return failure(
            'LOCAL_TEST_SCREENING_ACTIVE_CHECK_EXISTS',
            'A current or in-progress screening record already exists.',
          );
        }

        const inserted = await query<{ id: string; check_id: string; status: 'PENDING' }>(
          `INSERT INTO background_checks (
             user_id, provider, check_id, status, initiated_at, expires_at,
             result_summary, details, screening_consent_id,
             provider_environment, is_test
           ) VALUES (
             $1, $2, $3, 'PENDING', NOW(), NOW() + INTERVAL '1 year',
             NULL, $4::jsonb, $5, 'CONTROLLED_TEST', TRUE
           )
           RETURNING id, check_id, status`,
          [
            params.workerId,
            LOCAL_CERTIFICATION_SCREENING_PROVIDER,
            reportId,
            JSON.stringify({
              providerEnvironment: 'CONTROLLED_TEST',
              isTest: true,
              externalReportOrdered: false,
            }),
            params.consentId,
          ],
        );
        const background = inserted.rows[0];

        await query(
          `INSERT INTO hxos_local_test_screening_reports (
             id, background_check_id, worker_id, consent_id, status,
             request_hash, idempotency_key, expires_at
           ) VALUES ($1,$2,$3,$4,'PENDING',$5,$6,NOW() + INTERVAL '1 year')`,
          [reportId, background.id, params.workerId, params.consentId, requestHash, params.idempotencyKey],
        );
        await query(
          `INSERT INTO hxos_local_test_screening_events (
             report_id, background_check_id, worker_id, from_status, to_status,
             event_type, actor_id, idempotency_key, metadata
           ) VALUES ($1,$2,$3,NULL,'PENDING','report_requested',$3,$4,$5::jsonb)`,
          [
            reportId,
            background.id,
            params.workerId,
            `local-test-screening-requested:${params.idempotencyKey}`,
            JSON.stringify({ external_report_ordered: false, is_test: true }),
          ],
        );
        await query(
          `INSERT INTO worker_screening_events (
             worker_id, background_check_id, consent_id, event_type, actor_id,
             request_hash, idempotency_key, public_message, metadata
           ) VALUES ($1,$2,$3,'CHECK_INITIATED',$1,$4,$5,$6,$7::jsonb)`,
          [
            params.workerId,
            background.id,
            params.consentId,
            requestHash,
            `local-test-check-initiated:${params.idempotencyKey}`,
            'A controlled TEST screening fixture started. No external background report was ordered.',
            JSON.stringify({ provider: LOCAL_CERTIFICATION_SCREENING_PROVIDER, is_test: true }),
          ],
        );
        return initiationResult({
          id: reportId,
          background_check_id: background.id,
          worker_id: params.workerId,
          consent_id: params.consentId,
          status: 'PENDING',
          check_status: 'PENDING',
          request_hash: requestHash,
          idempotency_key: params.idempotencyKey,
          is_test: true,
        }, false);
      });
    } catch {
      return failure('LOCAL_TEST_SCREENING_FAILED', 'Local certification screening could not be initiated.');
    }
  },

  completeClear: async (
    params: CompleteLocalTestScreeningParams,
  ): Promise<ServiceResult<{
    backgroundCheckId: string;
    providerReportId: string;
    provider: typeof LOCAL_CERTIFICATION_SCREENING_PROVIDER;
    status: 'CLEAR';
    isTest: true;
    idempotencyReplayed: boolean;
  }>> => {
    if (!localCertificationScreeningEnabled()) {
      return failure('LOCAL_TEST_SCREENING_DISABLED', 'Local certification screening is disabled.');
    }
    if (!validIdempotencyKey(params.idempotencyKey)) {
      return failure('LOCAL_TEST_SCREENING_INVALID', 'Local certification screening idempotency key is invalid.');
    }
    try {
      const completion = await db.transaction(async (query) => {
        await query(
          `SELECT pg_advisory_xact_lock(hashtext('local-test-screening-clear'), hashtext($1))`,
          [params.backgroundCheckId],
        );
        await enableTransactionMarker(query);
        const selected = await query<CompletionRow>(
          `SELECT report.id, report.background_check_id, report.worker_id, report.consent_id,
                  report.status AS report_status, background.status AS check_status,
                  report.is_test
           FROM hxos_local_test_screening_reports report
           JOIN background_checks background ON background.id = report.background_check_id
           WHERE report.background_check_id = $1
             AND report.worker_id = $2
             AND background.provider = 'local_certification_test'
             AND background.provider_environment = 'CONTROLLED_TEST'
             AND background.is_test IS TRUE
           FOR UPDATE OF report, background`,
          [params.backgroundCheckId, params.workerId],
        );
        const row = selected.rows[0];
        if (!row || row.is_test !== true) {
          return failure('LOCAL_TEST_SCREENING_NOT_FOUND', 'Local certification screening report was not found.');
        }
        if (row.report_status === 'CLEAR' && row.check_status === 'CLEAR') {
          return { success: true as const, data: { row, replayed: true } };
        }
        if (row.report_status !== 'PENDING' || !['PENDING', 'IN_PROGRESS'].includes(row.check_status)) {
          return failure('LOCAL_TEST_SCREENING_STATE_CONFLICT', 'Local certification screening state cannot be cleared.');
        }

        await query(
          `UPDATE hxos_local_test_screening_reports
           SET status = 'PROCESSING', updated_at = NOW()
           WHERE id = $1 AND status = 'PENDING'`,
          [row.id],
        );
        await query(
          `INSERT INTO hxos_local_test_screening_events (
             report_id, background_check_id, worker_id, from_status, to_status,
             event_type, actor_id, idempotency_key, metadata
           ) VALUES ($1,$2,$3,'PENDING','PROCESSING','report_processing',$4,$5,$6::jsonb)`,
          [row.id, row.background_check_id, row.worker_id, params.actorId,
            `local-test-screening-processing:${params.idempotencyKey}`,
            JSON.stringify({ is_test: true })],
        );
        await query(
          `UPDATE hxos_local_test_screening_reports
           SET status = 'CLEAR', result_summary = $2, completed_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND status = 'PROCESSING'`,
          [row.id, RESULT_SUMMARY],
        );
        await query(
          `INSERT INTO hxos_local_test_screening_events (
             report_id, background_check_id, worker_id, from_status, to_status,
             event_type, actor_id, idempotency_key, metadata
           ) VALUES ($1,$2,$3,'PROCESSING','CLEAR','report_cleared',$4,$5,$6::jsonb)`,
          [row.id, row.background_check_id, row.worker_id, params.actorId,
            `local-test-screening-cleared:${params.idempotencyKey}`,
            JSON.stringify({ external_report_ordered: false, is_test: true })],
        );
        const updated = await query<{ id: string; status: 'CLEAR' }>(
          `UPDATE background_checks
           SET status = 'CLEAR', completed_at = NOW(), result_summary = $2,
               details = COALESCE(details, '{}'::jsonb) || $3::jsonb
           WHERE id = $1 AND status IN ('PENDING', 'IN_PROGRESS')
           RETURNING id, status`,
          [row.background_check_id, RESULT_SUMMARY, JSON.stringify({
            providerStatus: 'CLEAR',
            externalReportOrdered: false,
            isTest: true,
          })],
        );
        if (!updated.rows[0]) {
          return failure('LOCAL_TEST_SCREENING_STATE_CONFLICT', 'Canonical screening state did not converge.');
        }
        await query(
          `INSERT INTO worker_screening_events (
             worker_id, background_check_id, consent_id, event_type, actor_id,
             request_hash, idempotency_key, public_message, metadata
           ) VALUES ($1,$2,$3,'REPORT_READY',$4,$5,$6,$7,$8::jsonb),
                    ($1,$2,$3,'CHECK_CLEARED',$4,$5,$9,$10,$8::jsonb)`,
          [
            row.worker_id,
            row.background_check_id,
            row.consent_id,
            params.actorId,
            digest({ backgroundCheckId: row.background_check_id, workerId: row.worker_id }),
            `local-test-report-ready:${params.idempotencyKey}`,
            'The controlled TEST report is available. It is not an external background report.',
            JSON.stringify({ provider: LOCAL_CERTIFICATION_SCREENING_PROVIDER, is_test: true }),
            `local-test-check-cleared:${params.idempotencyKey}`,
            'Controlled TEST eligibility cleared for TEST work only. Production eligibility is unchanged.',
          ],
        );
        return { success: true as const, data: { row, replayed: false } };
      });
      if (!completion.success) return completion;

      try {
        await recomputeCapabilityProfile(params.workerId, {
          reason: 'local_test_background_check_cleared',
          sourceVerificationId: params.backgroundCheckId,
        });
      } catch {
        return failure(
          'LOCAL_TEST_SCREENING_CAPABILITY_RECOMPUTE_FAILED',
          'TEST report cleared, but capability recomputation must be retried.',
        );
      }
      return {
        success: true,
        data: {
          backgroundCheckId: completion.data.row.background_check_id,
          providerReportId: completion.data.row.id,
          provider: LOCAL_CERTIFICATION_SCREENING_PROVIDER,
          status: 'CLEAR',
          isTest: true,
          idempotencyReplayed: completion.data.replayed,
        },
      };
    } catch {
      return failure('LOCAL_TEST_SCREENING_FAILED', 'Local certification screening could not be completed.');
    }
  },
};
