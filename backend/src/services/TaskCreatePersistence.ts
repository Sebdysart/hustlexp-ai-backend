import { db } from '../db.js';
import type { Task } from '../types.js';
import type { RegionPolicyTaskSnapshot } from './RegionPolicyService.js';
import { deriveRoughArea, redactPrivateLocation } from './TaskLocationService.js';
import { encryptTaskLocation } from './TaskLocationCrypto.js';
import type { CreateTaskParams } from './TaskServiceShared.js';

type Query = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface TaskInitialScope {
  id: string;
  hash: string;
  checklist: string[];
}

export interface TaskPersistenceInput {
  params: CreateTaskParams;
  money: { price: number; xp: number };
  instantMode: boolean;
  scope: TaskInitialScope;
  regionPolicy: RegionPolicyTaskSnapshot;
}

export interface TaskDependentInput {
  params: CreateTaskParams;
  requestHash: string | null;
  task: Task;
  price: number;
  scope: TaskInitialScope;
}

function baseTaskValues(input: TaskPersistenceInput): unknown[] {
  const { params, money, instantMode } = input;
  const location = deriveRoughArea(params.location, params.roughArea);
  return [
    params.posterId,
    redactPrivateLocation(params.title) ?? params.title,
    redactPrivateLocation(params.description) ?? params.description,
    money.price,
    money.xp,
    redactPrivateLocation(params.requirements),
    location,
    params.category,
    params.deadline,
    params.requiresProof ?? true,
    params.riskLevel || 'LOW',
    params.mode ?? 'STANDARD',
    params.liveBroadcastRadiusMiles,
    instantMode,
    params.sensitive ?? false,
    instantMode ? 'MATCHING' : 'OPEN',
    params.templateSlug || null,
    location,
    params.dispatchExpiresAt,
    params.automationClassification ?? 'PRODUCTION',
  ];
}

function quoteEconomicsValues(params: CreateTaskParams): [number | null, number | null] {
  return [params.hustlerPayoutCents ?? null, params.platformMarginCents ?? null];
}

function templatePolicyValues(params: CreateTaskParams): unknown[] {
  return [
    params.trustTierRequired ?? 1,
    JSON.stringify(params.completionCriteria ?? { type: 'photo_proof' }),
    params.contentRelease ?? false,
    params.mutualConsentRequired ?? false,
    params.cancellationWindowHours ?? 24,
    params.lateCancelPct ?? 0,
    params.cancellationPolicyVersion ?? 'task-template-v2:internal:0',
    params.illegalRiskScore ?? 0,
    JSON.stringify(params.complianceGuardianNotes ?? {}),
  ];
}

function regionPolicyValues(policy: RegionPolicyTaskSnapshot, category: string | undefined): unknown[] {
  return [
    policy.regionCode,
    policy.policyId,
    policy.policyVersion,
    policy.policyHash,
    JSON.stringify(policy),
    category,
    policy.locationState,
    policy.licenseRequired,
    policy.insuranceRequired,
    policy.backgroundCheckRequired,
    policy.proofMinPhotos,
    policy.proofMaxPhotos,
    policy.proofGpsRequired,
    policy.currency,
  ];
}

function trailingTaskValues(input: TaskPersistenceInput): unknown[] {
  const { params, scope } = input;
  return [
    scope.hash,
    scope.id,
    params.estimatedDurationMinutes ?? null,
    params.requiredTools ?? [],
    ...regionPolicyValues(input.regionPolicy, params.category),
    params.repeatSourceTaskId ?? null,
    params.preferredWorkerId ?? null,
    params.retentionConversion ?? null,
    params.counterSourceTaskId ?? null,
    params.counterOfferId ?? null,
    params.counterCandidateId ?? null,
    params.aiScopeObservationId ?? null,
  ];
}

function publicTaskValues(input: TaskPersistenceInput): unknown[] {
  return [
    ...baseTaskValues(input),
    ...quoteEconomicsValues(input.params),
    ...templatePolicyValues(input.params),
    ...trailingTaskValues(input),
  ];
}

export async function insertCanonicalTask(query: Query, input: TaskPersistenceInput): Promise<Task> {
  const result = await query<Task>(
    `INSERT INTO tasks (
      poster_id, title, description, price, xp_reward, requirements, location, category,
      deadline, requires_proof, risk_level, mode, live_broadcast_radius_miles, instant_mode,
      sensitive, state, template_slug, rough_location, dispatch_expires_at,
      automation_classification, hustler_payout_cents, platform_margin_cents,
      trust_tier_required, completion_criteria, content_release,
      mutual_consent_required, cancellation_window_hours, late_cancel_pct,
      cancellation_policy_version, illegal_risk_score, compliance_guardian_notes,
      scope_hash, active_scope_version_id, estimated_duration_minutes, required_tools,
      region_code, region_policy_id, region_policy_version, region_policy_hash,
      region_policy_snapshot, trade_type, location_state, license_required,
      insurance_required, background_check_required, proof_min_photos,
      proof_max_photos, proof_gps_required, currency, repeat_source_task_id,
      preferred_worker_id, retention_conversion, counter_source_task_id,
      counter_offer_id, counter_candidate_id, ai_scope_observation_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25,$26,$27,$28,$29,$30,$31::jsonb,$32,$33,$34,$35,$36,$37,$38,$39,$40::jsonb,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56)
    RETURNING *`,
    publicTaskValues(input),
  );
  return result.rows[0];
}

async function insertCreateWitness(query: Query, input: TaskDependentInput): Promise<void> {
  if (!input.params.clientIdempotencyKey || !input.requestHash) return;
  await query(
    `INSERT INTO task_create_requests (poster_id, idempotency_key, request_hash, task_id)
     VALUES ($1, $2, $3, $4)`,
    [input.params.posterId, input.params.clientIdempotencyKey, input.requestHash, input.task.id],
  );
}

export async function insertTaskDependents(query: Query, input: TaskDependentInput): Promise<void> {
  const { params, task, price, scope } = input;
  if (params.location) {
    const encrypted = encryptTaskLocation(task.id, params.location);
    await query(
      `INSERT INTO task_location_vault (
         task_id, exact_location, location_ciphertext, location_nonce,
         location_auth_tag, location_key_id, location_fingerprint
       ) VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
      [
        task.id,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        encrypted.keyId,
        encrypted.fingerprint,
      ],
    );
  }
  await query(
    `INSERT INTO escrows (task_id, amount, state, platform_fee_cents) VALUES ($1, $2, 'PENDING', $3)`,
    [task.id, price, params.platformMarginCents ?? null],
  );
  await insertCreateWitness(query, input);
  await query(
    `INSERT INTO task_scope_versions (
       id, task_id, version, scope_hash, title, description, requirements,
       checklist, customer_total_cents, hustler_payout_cents, source,
       change_summary, created_by
     ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7::jsonb, $8, $9, 'INITIAL', $10, $11)`,
    [
      scope.id,
      task.id,
      scope.hash,
      task.title,
      task.description,
      task.requirements ?? null,
      JSON.stringify(scope.checklist),
      price,
      params.hustlerPayoutCents ?? null,
      'Initial approved execution scope',
      params.posterId,
    ],
  );
}
