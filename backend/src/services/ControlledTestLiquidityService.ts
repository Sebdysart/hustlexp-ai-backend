import { createHash, createHmac, randomUUID } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';

export const CONTROLLED_TEST_LIQUIDITY_POLICY_VERSION = 'hxos-local-certification-liquidity-v1';
export const CONTROLLED_TEST_PROVIDER_EARNINGS_POLICY_VERSION = 'hxos-provider-economics-test-v1';
export const CONTROLLED_TEST_MINIMUM_PROVIDER_NET_HOURLY_CENTS = 2_000;
const TEST_REASONS = [
  'controlled_test_only',
  'one_eligible_provider',
  'not_public_liquidity',
  'no_production_coverage_claim',
] as const;
type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

interface TaskRow {
  id: string;
  state: string;
  worker_id: string | null;
  category: string;
  rough_location: string | null;
  region_code: string | null;
  risk_level: string;
  trust_tier_required: number | null;
  price: number;
  hustler_payout_cents: number | null;
  platform_margin_cents: number | null;
  automation_classification: string | null;
  background_check_required: boolean;
  license_required: boolean;
  insurance_required: boolean;
  escrow_state: string | null;
}

interface WorkerRow {
  id: string;
  default_mode: string;
  account_status: string;
  is_minor: boolean;
  is_banned: boolean | null;
  trust_hold: boolean;
  trust_hold_until: string | Date | null;
  trust_tier: number;
  is_verified: boolean;
  identity_verification_status: string | null;
  identity_verification_environment: string | null;
  identity_verification_expires_at: string | Date | null;
  phone: string | null;
  plan: string;
  risk_clearance: string[];
  background_check_valid: boolean;
  background_check_expires_at: string | Date | null;
  background_check_source_id: string | null;
  background_check_provider: string | null;
  background_check_environment: string | null;
  background_check_is_test: boolean;
  screening_status: string | null;
  screening_provider: string | null;
  screening_environment: string | null;
  screening_is_test: boolean;
  screening_report_status: string | null;
  screening_report_is_test: boolean;
  payout_destination_id: string | null;
  payout_destination_status: string | null;
  payout_destination_is_test: boolean;
  provider_capability_evidence_id: string | null;
  active_commitments: string;
  active_disputes: boolean;
  license_ready: boolean;
  insurance_ready: boolean;
  high_entitlement: boolean;
}

interface ReplayRow {
  id: string;
  task_id: string;
  worker_id: string;
  cell_id: string;
  request_hash: string;
  created_at: string | Date;
  geo_zone: string;
  state: 'LIMITED';
  active_verified_providers: number;
  average_contribution_cents: number;
  public_instant_requests_allowed: false;
  expansion_eligible: false;
  is_test: true;
}

export interface PrepareControlledTestLiquidityParams {
  taskId: string;
  workerId: string;
  actorId: string;
  idempotencyKey: string;
}

export interface ControlledTestLiquidityResult {
  taskId: string;
  workerId: string;
  cellId: string;
  witnessId: string;
  geoZone: string;
  state: 'LIMITED';
  activeVerifiedProviders: 1;
  averageContributionCents: number;
  publicInstantRequestsAllowed: false;
  expansionEligible: false;
  isTest: true;
  idempotencyReplayed: boolean;
}

function failure(code: string, message: string): ServiceResult<never> {
  return { success: false, error: { code, message } };
}

function secret(env: Environment = process.env): string {
  return env.HXOS_LOCAL_TEST_LIQUIDITY_SECRET?.trim() ?? '';
}

function hmac(value: string, env: Environment = process.env): string {
  return createHmac('sha256', secret(env)).update(value).digest('hex');
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function deterministicUuid(value: string): string {
  const hex = hmac(value).slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!;
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function geoZone(task: TaskRow): string | null {
  const region = slug(task.region_code ?? '');
  const rough = slug(task.rough_location ?? '');
  if (!region || !rough) return null;
  return `hxos-test-${region}-${rough}`.slice(0, 80).replace(/-+$/g, '');
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validParams(params: PrepareControlledTestLiquidityParams): boolean {
  return validUuid(params.taskId)
    && validUuid(params.workerId)
    && params.actorId.trim().length >= 1
    && params.actorId.trim().length <= 128
    && params.idempotencyKey.trim().length >= 8
    && params.idempotencyKey.length <= 200
    && /^[A-Za-z0-9:_-]+$/.test(params.idempotencyKey);
}

export function controlledTestLiquidityEnabled(env: Environment = process.env): boolean {
  return env.NODE_ENV !== 'production'
    && env.HXOS_ALLOW_LOCAL_TEST_LIQUIDITY === 'true'
    && env.ENGINE_API_MODE === 'test'
    && env.STRIPE_MODE === 'test'
    && secret(env).length >= 32;
}

function requestHash(params: PrepareControlledTestLiquidityParams): string {
  return digest({ taskId: params.taskId, workerId: params.workerId });
}

function trustPriceAuthority(tier: number): number {
  if (tier === 1) return 5_000;
  if (tier === 2) return 20_000;
  return 9_999_900;
}

function taskEligible(task: TaskRow): boolean {
  return ['OPEN', 'MATCHING'].includes(task.state)
    && task.worker_id === null
    && task.automation_classification === 'CONTROLLED_TEST'
    && task.escrow_state === 'FUNDED'
    && Boolean(task.category.trim())
    && Boolean(task.rough_location?.trim())
    && Boolean(task.region_code?.trim())
    && (task.platform_margin_cents ?? 0) > 0
    && (task.hustler_payout_cents ?? 0) > 0
    && task.price === (task.hustler_payout_cents ?? 0) + (task.platform_margin_cents ?? 0);
}

function providerEligible(task: TaskRow, worker: WorkerRow, at: Date): boolean {
  const expiry = worker.background_check_expires_at == null
    ? Number.POSITIVE_INFINITY
    : new Date(worker.background_check_expires_at).getTime();
  const riskFloor = task.risk_level === 'HIGH'
    ? 3
    : task.risk_level === 'MEDIUM'
      ? 2
      : 1;
  const trustFloor = Math.max(task.trust_tier_required ?? 1, riskFloor);
  return worker.default_mode === 'worker'
    && worker.account_status === 'ACTIVE'
    && worker.is_minor === false
    && worker.is_banned !== true
    && !(worker.trust_hold && (
      worker.trust_hold_until == null || new Date(worker.trust_hold_until).getTime() > at.getTime()
    ))
    && worker.trust_tier >= trustFloor
    && worker.is_verified === true
    && worker.identity_verification_status === 'VERIFIED'
    && worker.identity_verification_environment === 'CONTROLLED_TEST'
    && worker.identity_verification_expires_at != null
    && new Date(worker.identity_verification_expires_at).getTime() > at.getTime()
    && Boolean(worker.phone?.trim())
    && task.risk_level !== 'IN_HOME'
    && worker.risk_clearance.includes(task.risk_level.toLowerCase())
    && task.price <= trustPriceAuthority(worker.trust_tier)
    && (task.risk_level !== 'HIGH' || worker.plan === 'pro' || worker.high_entitlement === true)
    && (!task.license_required || worker.license_ready === true)
    && (!task.insurance_required || worker.insurance_ready === true)
    && worker.background_check_valid === true
    && expiry > at.getTime()
    && Boolean(worker.background_check_source_id)
    && worker.background_check_provider === 'local_certification_test'
    && worker.background_check_environment === 'CONTROLLED_TEST'
    && worker.background_check_is_test === true
    && worker.screening_status === 'CLEAR'
    && worker.screening_provider === 'local_certification_test'
    && worker.screening_environment === 'CONTROLLED_TEST'
    && worker.screening_is_test === true
    && worker.screening_report_status === 'CLEAR'
    && worker.screening_report_is_test === true
    && Boolean(worker.payout_destination_id)
    && worker.payout_destination_status === 'ACTIVE'
    && worker.payout_destination_is_test === true
    && Boolean(worker.provider_capability_evidence_id)
    && Number(worker.active_commitments) === 0
    && worker.active_disputes === false;
}

function replayResult(row: ReplayRow): ControlledTestLiquidityResult {
  return {
    taskId: row.task_id,
    workerId: row.worker_id,
    cellId: row.cell_id,
    witnessId: row.id,
    geoZone: row.geo_zone,
    state: row.state,
    activeVerifiedProviders: 1,
    averageContributionCents: row.average_contribution_cents,
    publicInstantRequestsAllowed: false,
    expansionEligible: false,
    isTest: true,
    idempotencyReplayed: true,
  };
}

async function enableMarker(query: QueryFn): Promise<void> {
  await query(`SELECT set_config('hustlexp.local_test_liquidity_enabled', 'true', true)`);
}

export const ControlledTestLiquidityService = {
  prepareAndBind: async (
    params: PrepareControlledTestLiquidityParams,
    evaluatedAt: Date = new Date(),
  ): Promise<ServiceResult<ControlledTestLiquidityResult>> => {
    if (!controlledTestLiquidityEnabled()) {
      return failure('LOCAL_TEST_LIQUIDITY_DISABLED', 'Controlled TEST liquidity is disabled.');
    }
    if (!validParams(params) || !Number.isFinite(evaluatedAt.getTime())) {
      return failure('LOCAL_TEST_LIQUIDITY_INVALID', 'Controlled TEST liquidity input is invalid.');
    }
    const hash = requestHash(params);
    try {
      return await db.transaction(async (query) => {
        await query(`SELECT pg_advisory_xact_lock(hashtext('local-test-liquidity'), hashtext($1))`, [params.taskId]);
        await enableMarker(query);

        const replay = await query<ReplayRow>(
          `SELECT witness.id,witness.task_id,witness.worker_id,witness.cell_id,
                  witness.request_hash,witness.created_at,cell.geo_zone,cell.state,
                  cell.active_verified_providers,cell.average_contribution_cents,
                  cell.public_instant_requests_allowed,cell.expansion_eligible,cell.is_test
           FROM hxos_local_test_liquidity_witnesses witness
           JOIN zone_category_cells cell ON cell.id = witness.cell_id
           WHERE witness.actor_id = $1 AND witness.idempotency_key = $2
           FOR SHARE OF witness, cell`,
          [params.actorId, params.idempotencyKey],
        );
        if (replay.rows[0]) {
          const row = replay.rows[0];
          if (row.request_hash !== hash || row.task_id !== params.taskId || row.worker_id !== params.workerId) {
            return failure('LOCAL_TEST_LIQUIDITY_IDEMPOTENCY_CONFLICT', 'Controlled TEST liquidity idempotency conflict.');
          }
          return { success: true as const, data: replayResult(row) };
        }

        const taskResult = await query<TaskRow>(
          `SELECT t.id,t.state,t.worker_id,t.category,t.rough_location,t.region_code,
                  t.risk_level,t.trust_tier_required,t.price,t.hustler_payout_cents,
                  t.platform_margin_cents,t.automation_classification,
                  t.background_check_required,t.license_required,t.insurance_required,
                  (SELECT escrow.state FROM escrows escrow
                    WHERE escrow.task_id=t.id ORDER BY escrow.created_at DESC LIMIT 1) AS escrow_state
           FROM tasks t WHERE t.id=$1 FOR UPDATE OF t`,
          [params.taskId],
        );
        const task = taskResult.rows[0];
        if (!task || !taskEligible(task)) {
          return failure('LOCAL_TEST_LIQUIDITY_TASK_INELIGIBLE', 'The funded controlled TEST task is not eligible for liquidity derivation.');
        }

        const workerResult = await query<WorkerRow>(
          `SELECT worker.id,worker.default_mode,worker.account_status,worker.is_minor,
                  worker.is_banned,worker.trust_hold,worker.trust_hold_until,
                  worker.trust_tier,worker.is_verified,
                  worker.identity_verification_status,worker.identity_verification_environment,
                  worker.identity_verification_expires_at,worker.phone,worker.plan,
                  profile.risk_clearance,profile.background_check_valid,
                  profile.background_check_expires_at,profile.background_check_source_id,
                  profile.background_check_provider,profile.background_check_environment,
                  profile.background_check_is_test,
                  background.status AS screening_status,background.provider AS screening_provider,
                  background.provider_environment AS screening_environment,
                  background.is_test AS screening_is_test,
                  report.status AS screening_report_status,report.is_test AS screening_report_is_test,
                  destination.id AS payout_destination_id,destination.status AS payout_destination_status,
                  destination.is_test AS payout_destination_is_test,
                  capability.id AS provider_capability_evidence_id,
                  (SELECT COUNT(*)::text FROM tasks active_task
                    WHERE active_task.worker_id=worker.id AND active_task.id<>$2
                      AND active_task.state IN ('ACCEPTED','PROOF_SUBMITTED','DISPUTED')) AS active_commitments,
                  EXISTS (SELECT 1 FROM disputes dispute WHERE dispute.worker_id=worker.id
                    AND dispute.state IN ('OPEN','EVIDENCE_REQUESTED','ESCALATED')) AS active_disputes,
                  (NOT task.license_required OR EXISTS (
                    SELECT 1 FROM license_verifications license
                    WHERE license.user_id=worker.id AND license.trade_type=task.trade_type
                      AND license.issuing_state=task.location_state
                      AND lower(license.status) IN ('approved','verified')
                      AND (license.expiration_date IS NULL OR license.expiration_date >= CURRENT_DATE)
                  )) AS license_ready,
                  (NOT task.insurance_required OR EXISTS (
                    SELECT 1 FROM insurance_verifications insurance
                    WHERE insurance.user_id=worker.id
                      AND lower(insurance.status) IN ('approved','verified')
                      AND (insurance.expiration_date IS NULL OR insurance.expiration_date >= CURRENT_DATE)
                  )) AS insurance_ready,
                  EXISTS (SELECT 1 FROM plan_entitlements entitlement
                    WHERE entitlement.user_id=worker.id
                      AND (entitlement.task_id IS NULL OR entitlement.task_id=task.id)
                      AND entitlement.risk_level='HIGH'
                      AND entitlement.expires_at > NOW()) AS high_entitlement
           FROM users worker
           JOIN tasks task ON task.id=$2
           JOIN capability_profiles profile ON profile.user_id=worker.id
           JOIN background_checks background ON background.id=profile.background_check_source_id
           JOIN hxos_local_test_screening_reports report
             ON report.background_check_id=background.id AND report.worker_id=worker.id
           JOIN LATERAL (
             SELECT candidate.id,candidate.status,candidate.is_test
             FROM hxos_local_test_payout_destinations candidate
             WHERE candidate.worker_id=worker.id AND candidate.status='ACTIVE' AND candidate.is_test IS TRUE
             ORDER BY candidate.activated_at DESC LIMIT 1
           ) destination ON TRUE
           JOIN LATERAL (
             SELECT evidence.id
             FROM hxos_local_test_provider_capability_evidence evidence
             WHERE evidence.task_id=task.id AND evidence.worker_id=worker.id
               AND evidence.category=task.category
               AND evidence.environment='CONTROLLED_TEST' AND evidence.is_test IS TRUE
               AND evidence.expires_at>NOW()
             ORDER BY evidence.created_at DESC LIMIT 1
           ) capability ON TRUE
           WHERE worker.id=$1
           FOR UPDATE OF worker`,
          [params.workerId, params.taskId],
        );
        const worker = workerResult.rows[0];
        if (!worker || !providerEligible(task, worker, evaluatedAt)) {
          return failure('LOCAL_TEST_LIQUIDITY_PROVIDER_INELIGIBLE', 'No currently eligible controlled TEST provider supports this task.');
        }

        const zone = geoZone(task);
        if (!zone) {
          return failure('LOCAL_TEST_LIQUIDITY_TASK_INELIGIBLE', 'Controlled TEST task geography is incomplete.');
        }
        const contribution = task.platform_margin_cents!;
        const metrics = {
          taskId: task.id,
          workerId: worker.id,
          backgroundCheckId: worker.background_check_source_id,
          payoutDestinationId: worker.payout_destination_id,
          providerCapabilityEvidenceId: worker.provider_capability_evidence_id,
          activeVerifiedProviders: 1,
          anchorDemandAccounts: 1,
          averageContributionCents: contribution,
          minimumProviderNetHourlyCents: CONTROLLED_TEST_MINIMUM_PROVIDER_NET_HOURLY_CENTS,
          providerEarningsPolicyVersion: CONTROLLED_TEST_PROVIDER_EARNINGS_POLICY_VERSION,
          providerEarningsPolicyState: 'TEST_HYPOTHESIS',
          publicInstantRequestsAllowed: false,
          expansionEligible: false,
          evaluatedAt: evaluatedAt.toISOString(),
        };
        const metricHash = digest(metrics);
        const stableCellId = deterministicUuid(`liquidity-cell:${zone}:${task.category}:controlled-certification`);
        const geographyLabel = `${task.rough_location!.trim()} controlled TEST cell`.slice(0, 120);
        const cellResult = await query<{ id: string; state: 'LIMITED'; inserted: boolean }>(
          `INSERT INTO zone_category_cells (
             id,geo_zone,geography_label,category,operating_window,state,policy_version,
             environment,is_test,launch_cell_enabled,green_category,
             metrics_computed_at,evaluated_at,stable_since,state_reasons,
             completed_tasks_total,paid_tasks_30d,fill_rate_30d,
             active_verified_providers,anchor_demand_accounts,average_contribution_cents,
             minimum_provider_net_hourly_cents,provider_earnings_policy_version,
             provider_earnings_policy_state,provider_earnings_sample_size,
             average_provider_net_hourly_cents,
             dispute_rate_30d,no_show_rate_30d,cancellation_rate_30d,repeat_demand_rate_30d,
             dispatch_allowed,public_instant_requests_allowed,expansion_eligible,
             max_concurrent_dispatches,created_at,updated_at
           ) VALUES (
             $1,$2,$3,$4,'controlled-certification','LIMITED',$5,
             'CONTROLLED_TEST',TRUE,FALSE,FALSE,
             $6,$6,$6,$7::jsonb,0,0,0,1,1,$8,$9,$10,'TEST_HYPOTHESIS',0,0,
             0,0,0,0,TRUE,FALSE,FALSE,1,$6,$6
           ) ON CONFLICT (geo_zone,category,operating_window) DO UPDATE SET
             geography_label=EXCLUDED.geography_label,state='LIMITED',policy_version=EXCLUDED.policy_version,
             environment='CONTROLLED_TEST',is_test=TRUE,launch_cell_enabled=FALSE,green_category=FALSE,
             metrics_computed_at=EXCLUDED.metrics_computed_at,evaluated_at=EXCLUDED.evaluated_at,
             stable_since=EXCLUDED.stable_since,state_reasons=EXCLUDED.state_reasons,
             completed_tasks_total=0,paid_tasks_30d=0,fill_rate_30d=0,
             active_verified_providers=1,anchor_demand_accounts=1,
             average_contribution_cents=EXCLUDED.average_contribution_cents,
             minimum_provider_net_hourly_cents=EXCLUDED.minimum_provider_net_hourly_cents,
             provider_earnings_policy_version=EXCLUDED.provider_earnings_policy_version,
             provider_earnings_policy_state='TEST_HYPOTHESIS',
             provider_earnings_sample_size=0,average_provider_net_hourly_cents=0,
             dispute_rate_30d=0,no_show_rate_30d=0,cancellation_rate_30d=0,repeat_demand_rate_30d=0,
             dispatch_allowed=TRUE,public_instant_requests_allowed=FALSE,
             expansion_eligible=FALSE,max_concurrent_dispatches=1,updated_at=EXCLUDED.updated_at
             WHERE zone_category_cells.environment='CONTROLLED_TEST'
               AND zone_category_cells.is_test IS TRUE
           RETURNING id,state,(xmax=0) AS inserted`,
          [stableCellId, zone, geographyLabel, task.category, CONTROLLED_TEST_LIQUIDITY_POLICY_VERSION,
            evaluatedAt.toISOString(), JSON.stringify(TEST_REASONS), contribution,
            CONTROLLED_TEST_MINIMUM_PROVIDER_NET_HOURLY_CENTS,
            CONTROLLED_TEST_PROVIDER_EARNINGS_POLICY_VERSION],
        );
        const cell = cellResult.rows[0];
        if (!cell) {
          return failure('LOCAL_TEST_LIQUIDITY_CELL_CONFLICT', 'Controlled TEST cell conflicts with non-TEST liquidity state.');
        }

        const witnessId = randomUUID();
        const witness = await query<{ id: string }>(
          `INSERT INTO hxos_local_test_liquidity_witnesses (
             id,cell_id,task_id,worker_id,background_check_id,payout_destination_id,
             provider_capability_evidence_id,
             provider_count,contribution_cents,policy_version,request_hash,metrics_hash,
             idempotency_key,actor_id,is_test,created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,TRUE,$14)
           RETURNING id`,
          [witnessId, cell.id, task.id, worker.id, worker.background_check_source_id,
            worker.payout_destination_id, worker.provider_capability_evidence_id,
            contribution, CONTROLLED_TEST_LIQUIDITY_POLICY_VERSION,
            hash, metricHash, params.idempotencyKey, params.actorId, evaluatedAt.toISOString()],
        );
        if (!witness.rows[0]) {
          return failure('LOCAL_TEST_LIQUIDITY_WITNESS_FAILED', 'Controlled TEST liquidity witness was not recorded.');
        }

        const bound = await query<{ id: string; liquidity_cell_id: string }>(
          `UPDATE tasks SET liquidity_cell_id=$2,geo_zone=$3,updated_at=NOW()
           WHERE id=$1 AND state IN ('OPEN','MATCHING') AND worker_id IS NULL
             AND automation_classification='CONTROLLED_TEST'
           RETURNING id,liquidity_cell_id`,
          [task.id, cell.id, zone],
        );
        if (!bound.rows[0]) {
          return failure('LOCAL_TEST_LIQUIDITY_BIND_FAILED', 'Controlled TEST task could not be bound to the derived cell.');
        }
        await query(
          `INSERT INTO zone_category_cell_events (
             cell_id,from_state,to_state,policy_version,metrics_hash,reasons,actor_type,actor_id,created_at
           ) VALUES ($1,$2,'LIMITED',$3,$4,$5::jsonb,'SYSTEM',$6,$7)`,
          [cell.id, cell.inserted ? null : 'LIMITED', CONTROLLED_TEST_LIQUIDITY_POLICY_VERSION,
            metricHash, JSON.stringify(TEST_REASONS), params.actorId, evaluatedAt.toISOString()],
        );
        return {
          success: true as const,
          data: {
            taskId: task.id,
            workerId: worker.id,
            cellId: cell.id,
            witnessId,
            geoZone: zone,
            state: 'LIMITED' as const,
            activeVerifiedProviders: 1 as const,
            averageContributionCents: contribution,
            publicInstantRequestsAllowed: false as const,
            expansionEligible: false as const,
            isTest: true as const,
            idempotencyReplayed: false,
          },
        };
      });
    } catch {
      return failure('LOCAL_TEST_LIQUIDITY_FAILED', 'Controlled TEST liquidity preparation failed.');
    }
  },
};
