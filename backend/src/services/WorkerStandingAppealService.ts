import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../db.js';
import { authCache } from '../auth-cache.js';
import { redis } from '../cache/redis.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { TrustTier, TrustTierService, trustTierName } from './TrustTierService.js';
import {
  WORKER_STANDING_POLICY_VERSION,
  workerStandingDigest,
  workerStandingTokenHash,
} from './WorkerStandingDecisionService.js';

type AppealStatus = 'OPEN' | 'UNDER_REVIEW' | 'NEEDS_INFORMATION' | 'OVERTURNED' | 'UPHELD' | 'WITHDRAWN';
type DecisionType = 'DEACTIVATION' | 'PROGRESSION';

type DecisionRow = {
  id: string;
  worker_id: string;
  decision_type: DecisionType;
  decision_state: string;
  current_tier: number;
  target_tier: number | null;
  reason_codes: string[];
  public_explanation: string;
  policy_version: string;
  decided_by: string | null;
  appeal_deadline_at: string;
  created_at: string;
};

type AppealRow = {
  id: string;
  decision_id: string;
  worker_id: string;
  status: AppealStatus;
  reason: string;
  request_hash: string;
  idempotency_key: string;
  review_due_at: string;
  assigned_reviewer_id: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  opened_at: string;
  updated_at: string;
};

function fail(code: 'BAD_REQUEST' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT', message: string): never {
  throw new TRPCError({ code, message });
}

function normalizedTier(value: number): number {
  return Math.max(0, Math.min(4, Math.trunc(Number.isFinite(value) ? value : 0)));
}

function targetTier(currentTier: number): TrustTier | null {
  if (currentTier >= TrustTier.LICENSED_SPECIALIST) return null;
  return (currentTier + 1) as TrustTier;
}

function progressionExternallyBlocked(reasons: string[]): boolean {
  return reasons.some((reason) => reason.includes('not enabled in the Build-Now release'));
}

function publicAppeal(row: AppealRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    reviewDueAt: row.review_due_at,
    assignedToHuman: row.assigned_reviewer_id !== null,
    resolutionNote: row.resolution_note,
    resolvedAt: row.resolved_at,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    rankingPenalty: 0 as const,
  };
}

async function appealForDecision(query: QueryFn, decisionId: string): Promise<AppealRow | null> {
  const result = await query<AppealRow>(
    `SELECT id,decision_id,worker_id,status,reason,request_hash,idempotency_key,
            review_due_at,assigned_reviewer_id,resolution_note,resolved_by,resolved_at,
            opened_at,updated_at
     FROM worker_standing_appeals WHERE decision_id=$1 ORDER BY opened_at DESC LIMIT 1`,
    [decisionId],
  );
  return result.rows[0] ?? null;
}

async function insertAppeal(query: QueryFn, params: {
  decision: DecisionRow;
  reason: string;
  idempotencyKey: string;
}): Promise<AppealRow> {
  const requestHash = workerStandingDigest({
    decisionId: params.decision.id,
    workerId: params.decision.worker_id,
    reason: params.reason,
  });
  const replay = await query<AppealRow>(
    `SELECT id,decision_id,worker_id,status,reason,request_hash,idempotency_key,
            review_due_at,assigned_reviewer_id,resolution_note,resolved_by,resolved_at,
            opened_at,updated_at
     FROM worker_standing_appeals
     WHERE worker_id=$1 AND idempotency_key=$2 FOR UPDATE`,
    [params.decision.worker_id, params.idempotencyKey],
  );
  if (replay.rows[0]) {
    if (replay.rows[0].request_hash !== requestHash) {
      fail('CONFLICT', 'That appeal key was already used for a different request.');
    }
    return replay.rows[0];
  }
  const existing = await query<AppealRow>(
    `SELECT id,decision_id,worker_id,status,reason,request_hash,idempotency_key,
            review_due_at,assigned_reviewer_id,resolution_note,resolved_by,resolved_at,
            opened_at,updated_at
     FROM worker_standing_appeals
     WHERE decision_id=$1 AND status IN ('OPEN','UNDER_REVIEW','NEEDS_INFORMATION')
     FOR UPDATE`,
    [params.decision.id],
  );
  if (existing.rows[0]) return existing.rows[0];

  const inserted = await query<AppealRow>(
    `INSERT INTO worker_standing_appeals(
       decision_id,worker_id,reason,request_hash,idempotency_key,review_due_at
     ) VALUES ($1,$2,$3,$4,$5,NOW()+INTERVAL '7 days')
     RETURNING id,decision_id,worker_id,status,reason,request_hash,idempotency_key,
       review_due_at,assigned_reviewer_id,resolution_note,resolved_by,resolved_at,
       opened_at,updated_at`,
    [params.decision.id, params.decision.worker_id, params.reason, requestHash, params.idempotencyKey],
  );
  const appeal = inserted.rows[0];
  await query(
    `INSERT INTO worker_standing_appeal_events(
       appeal_id,event_type,actor_role,actor_id,public_message,idempotency_key
     ) VALUES ($1,'OPENED','WORKER',$2,$3,$4)`,
    [appeal.id, params.decision.worker_id,
      'Your appeal is recorded and awaits an independent human review.',
      `worker-standing-appeal-opened:${appeal.id}`],
  );
  await writeToOutbox({
    eventType: 'worker.standing_appeal_opened',
    aggregateType: 'worker_standing_appeal',
    aggregateId: appeal.id,
    eventVersion: 1,
    idempotencyKey: `worker-standing-review-queue:${appeal.id}`,
    payload: {
      appealId: appeal.id,
      decisionId: params.decision.id,
      workerId: params.decision.worker_id,
      decisionType: params.decision.decision_type,
      reviewDueAt: appeal.review_due_at,
      appealNarrativeExcluded: true,
    },
    queueName: 'critical_trust',
  }, query);
  return appeal;
}

async function decisionByAccessToken(query: QueryFn, token: string, lock = false): Promise<DecisionRow> {
  if (token.length < 32 || token.length > 200) fail('NOT_FOUND', 'Appeal link is invalid or expired.');
  const result = await query<DecisionRow>(
    `SELECT d.id,d.worker_id,d.decision_type,d.decision_state,d.current_tier,d.target_tier,
            d.reason_codes,d.public_explanation,d.policy_version,d.decided_by,
            d.appeal_deadline_at,d.created_at
     FROM worker_standing_appeal_access access
     JOIN worker_standing_decisions d ON d.id=access.decision_id
     WHERE access.token_hash=$1 AND access.expires_at>NOW()
       AND d.appeal_deadline_at>NOW()
     ${lock ? 'FOR UPDATE OF access,d' : ''}`,
    [workerStandingTokenHash(token)],
  );
  if (!result.rows[0] || result.rows[0].decision_type !== 'DEACTIVATION') {
    fail('NOT_FOUND', 'Appeal link is invalid or expired.');
  }
  return result.rows[0];
}

export async function getDeactivationAppealByToken(token: string) {
  const decision = await decisionByAccessToken(db.query, token);
  const appeal = await appealForDecision(db.query, decision.id);
  const events = appeal ? await db.query<{ event_type: string; public_message: string; created_at: string }>(
    `SELECT event_type,public_message,created_at
     FROM worker_standing_appeal_events WHERE appeal_id=$1 ORDER BY created_at,id`,
    [appeal.id],
  ) : { rows: [] };
  return {
    decision: {
      id: decision.id,
      type: decision.decision_type,
      state: decision.decision_state,
      explanation: decision.public_explanation,
      reasonCodes: decision.reason_codes,
      currentTier: decision.current_tier,
      targetTier: decision.target_tier,
      policyVersion: decision.policy_version,
      decidedAt: decision.created_at,
      appealDeadlineAt: decision.appeal_deadline_at,
      rankingPenalty: 0 as const,
    },
    appeal: publicAppeal(appeal),
    timeline: events.rows.map((event) => ({
      type: event.event_type,
      message: event.public_message,
      at: event.created_at,
    })),
  };
}

export async function openDeactivationAppeal(params: {
  token: string;
  reason: string;
  idempotencyKey: string;
}) {
  return db.transaction(async (query) => {
    const decision = await decisionByAccessToken(query, params.token, true);
    const appeal = await insertAppeal(query, { decision, reason: params.reason, idempotencyKey: params.idempotencyKey });
    return publicAppeal(appeal)!;
  });
}

export async function getMyWorkerStanding(workerId: string) {
  const user = await db.query<{ trust_tier: number; is_banned: boolean; account_status: string }>(
    `SELECT trust_tier,is_banned,account_status FROM users WHERE id=$1`,
    [workerId],
  );
  if (!user.rows[0]) fail('NOT_FOUND', 'Worker account was not found.');
  const currentTier = normalizedTier(user.rows[0].trust_tier);
  const nextTier = targetTier(currentTier);
  const eligibility = nextTier ? await TrustTierService.evaluatePromotion(workerId) : {
    eligible: false,
    reasons: ['Already at maximum tier'],
  };
  const appeals = await db.query<AppealRow & DecisionRow>(
    `SELECT a.id,a.decision_id,a.worker_id,a.status,a.reason,a.request_hash,a.idempotency_key,
            a.review_due_at,a.assigned_reviewer_id,a.resolution_note,a.resolved_by,
            a.resolved_at,a.opened_at,a.updated_at,
            d.decision_type,d.decision_state,d.current_tier,d.target_tier,d.reason_codes,
            d.public_explanation,d.policy_version,d.decided_by,d.appeal_deadline_at,d.created_at
     FROM worker_standing_appeals a
     JOIN worker_standing_decisions d ON d.id=a.decision_id
     WHERE a.worker_id=$1 ORDER BY a.opened_at DESC LIMIT 20`,
    [workerId],
  );
  return {
    currentTier,
    currentTierName: trustTierName(currentTier),
    targetTier: nextTier,
    targetTierName: nextTier ? trustTierName(nextTier) : null,
    eligibleForAutomaticProgression: eligibility.eligible,
    criteria: eligibility.reasons,
    canAppealProgression: Boolean(
      nextTier
      && !eligibility.eligible
      && !progressionExternallyBlocked(eligibility.reasons)
    ),
    progressionExternallyBlocked: progressionExternallyBlocked(eligibility.reasons),
    rights: {
      rankingPenalty: 0 as const,
      independentHumanReview: true as const,
      reviewTargetDays: 7 as const,
      noPayToWin: true as const,
    },
    appeals: appeals.rows.map((row) => ({
      ...publicAppeal(row)!,
      decisionType: row.decision_type,
      explanation: row.public_explanation,
      targetTier: row.target_tier,
    })),
  };
}

export async function openProgressionAppeal(params: {
  workerId: string;
  reason: string;
  idempotencyKey: string;
}) {
  return db.serializableTransaction(async (query) => {
    const user = await query<{ trust_tier: number; is_banned: boolean; account_status: string }>(
      `SELECT trust_tier,is_banned,account_status FROM users WHERE id=$1 FOR UPDATE`,
      [params.workerId],
    );
    const row = user.rows[0];
    if (!row || row.is_banned || row.account_status !== 'ACTIVE') fail('FORBIDDEN', 'Worker account is not eligible for progression review.');
    const currentTier = normalizedTier(row.trust_tier);
    const nextTier = targetTier(currentTier);
    if (!nextTier) fail('BAD_REQUEST', 'You are already at the maximum trust tier.');
    const eligibility = await TrustTierService.evaluatePromotion(params.workerId, query);
    if (eligibility.eligible) fail('BAD_REQUEST', 'You currently qualify for automatic progression; no adverse decision exists to appeal.');
    if (progressionExternallyBlocked(eligibility.reasons)) {
      fail('BAD_REQUEST', 'That progression tier is not enabled in the Build-Now release and has no automatic standing decision to appeal.');
    }
    const snapshotHash = workerStandingDigest({ currentTier, nextTier, reasons: eligibility.reasons });
    const explanation = `Progression to ${trustTierName(nextTier)} was not granted because: ${eligibility.reasons.join('; ')}`.slice(0, 2000);
    const sourceKey = `progression:${params.workerId}:${currentTier}:${nextTier}:${snapshotHash}`;
    let decisionResult = await query<DecisionRow>(
      `INSERT INTO worker_standing_decisions(
         worker_id,decision_type,decision_state,current_tier,target_tier,reason_codes,
         public_explanation,policy_version,decision_source,decided_by,
         source_idempotency_key,appeal_deadline_at
       ) VALUES ($1,'PROGRESSION','PROGRESSION_NOT_GRANTED',$2,$3,$4,$5,$6,'POLICY',NULL,$7,
         NOW()+INTERVAL '30 days')
       ON CONFLICT (source_idempotency_key) DO NOTHING
       RETURNING id,worker_id,decision_type,decision_state,current_tier,target_tier,
         reason_codes,public_explanation,policy_version,decided_by,appeal_deadline_at,created_at`,
      [params.workerId, currentTier, nextTier, ['PROGRESSION_CRITERIA_NOT_MET'], explanation,
        WORKER_STANDING_POLICY_VERSION, sourceKey],
    );
    if (!decisionResult.rows[0]) {
      decisionResult = await query<DecisionRow>(
        `SELECT id,worker_id,decision_type,decision_state,current_tier,target_tier,
                reason_codes,public_explanation,policy_version,decided_by,appeal_deadline_at,created_at
         FROM worker_standing_decisions WHERE source_idempotency_key=$1 FOR UPDATE`,
        [sourceKey],
      );
    }
    const decision = decisionResult.rows[0];
    if (!decision) throw new Error('Progression decision could not be recorded.');
    const appeal = await insertAppeal(query, { decision, reason: params.reason, idempotencyKey: params.idempotencyKey });
    return publicAppeal(appeal)!;
  });
}

async function addEvidence(query: QueryFn, params: {
  appealId: string;
  workerId: string;
  statement: string;
  idempotencyKey: string;
}) {
  const requestHash = workerStandingDigest(params);
  const inserted = await query<{ id: string; request_hash: string; created_at: string }>(
    `INSERT INTO worker_standing_appeal_evidence(
       appeal_id,worker_id,statement,request_hash,idempotency_key
     ) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (worker_id,idempotency_key) DO NOTHING
     RETURNING id,request_hash,created_at`,
    [params.appealId, params.workerId, params.statement, requestHash, params.idempotencyKey],
  );
  let evidence = inserted.rows[0];
  if (!evidence) {
    const replay = await query<{ id: string; request_hash: string; created_at: string }>(
      `SELECT id,request_hash,created_at FROM worker_standing_appeal_evidence
       WHERE worker_id=$1 AND idempotency_key=$2`,
      [params.workerId, params.idempotencyKey],
    );
    evidence = replay.rows[0];
    if (!evidence || evidence.request_hash !== requestHash) fail('CONFLICT', 'That evidence key was already used for different information.');
    return { evidenceId: evidence.id, createdAt: evidence.created_at };
  }
  await query(
    `INSERT INTO worker_standing_appeal_events(
       appeal_id,event_type,actor_role,actor_id,public_message,idempotency_key
     ) VALUES ($1,'EVIDENCE_ADDED','WORKER',$2,$3,$4)`,
    [params.appealId, params.workerId, 'Additional information was added to your appeal.',
      `worker-standing-evidence-added:${evidence.id}`],
  );
  return { evidenceId: evidence.id, createdAt: evidence.created_at };
}

export async function addDeactivationAppealEvidence(params: {
  token: string;
  appealId: string;
  statement: string;
  idempotencyKey: string;
}) {
  return db.transaction(async (query) => {
    const decision = await decisionByAccessToken(query, params.token, true);
    const appeal = await query<{ worker_id: string; decision_id: string }>(
      `SELECT worker_id,decision_id FROM worker_standing_appeals WHERE id=$1 FOR UPDATE`,
      [params.appealId],
    );
    if (!appeal.rows[0] || appeal.rows[0].decision_id !== decision.id) fail('NOT_FOUND', 'Appeal was not found for this link.');
    return addEvidence(query, { ...params, workerId: decision.worker_id });
  });
}

export async function addProgressionAppealEvidence(params: {
  workerId: string;
  appealId: string;
  statement: string;
  idempotencyKey: string;
}) {
  return db.transaction(async (query) => addEvidence(query, params));
}

export async function listPendingWorkerStandingAppeals(limit = 50) {
  const result = await db.query<AppealRow & DecisionRow>(
    `SELECT a.id,a.decision_id,a.worker_id,a.status,a.reason,a.request_hash,a.idempotency_key,
            a.review_due_at,a.assigned_reviewer_id,a.resolution_note,a.resolved_by,
            a.resolved_at,a.opened_at,a.updated_at,
            d.decision_type,d.decision_state,d.current_tier,d.target_tier,d.reason_codes,
            d.public_explanation,d.policy_version,d.decided_by,d.appeal_deadline_at,d.created_at
     FROM worker_standing_appeals a
     JOIN worker_standing_decisions d ON d.id=a.decision_id
     WHERE a.status IN ('OPEN','UNDER_REVIEW','NEEDS_INFORMATION')
     ORDER BY a.review_due_at,a.opened_at LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    appealId: row.id,
    workerId: row.worker_id,
    decisionType: row.decision_type,
    status: row.status,
    workerReason: row.reason,
    decisionExplanation: row.public_explanation,
    reasonCodes: row.reason_codes,
    currentTier: row.current_tier,
    targetTier: row.target_tier,
    openedAt: row.opened_at,
    reviewDueAt: row.review_due_at,
    independentReviewerRequired: true as const,
    originalDecisionMakerId: row.decided_by,
  }));
}

export async function resolveWorkerStandingAppeal(params: {
  appealId: string;
  reviewerId: string;
  decision: 'OVERTURNED' | 'UPHELD';
  resolutionNote: string;
  idempotencyKey: string;
}) {
  let restoredFirebaseUid: string | null = null;
  const result = await db.transaction(async (query) => {
    const found = await query<AppealRow & DecisionRow & { firebase_uid: string | null; trust_tier: number; is_banned: boolean }>(
      `SELECT a.id,a.decision_id,a.worker_id,a.status,a.reason,a.request_hash,a.idempotency_key,
              a.review_due_at,a.assigned_reviewer_id,a.resolution_note,a.resolved_by,
              a.resolved_at,a.opened_at,a.updated_at,
              d.decision_type,d.decision_state,d.current_tier,d.target_tier,d.reason_codes,
              d.public_explanation,d.policy_version,d.decided_by,d.appeal_deadline_at,d.created_at,
              u.firebase_uid,u.trust_tier,u.is_banned
       FROM worker_standing_appeals a
       JOIN worker_standing_decisions d ON d.id=a.decision_id
       JOIN users u ON u.id=a.worker_id
       WHERE a.id=$1 FOR UPDATE OF a,u`,
      [params.appealId],
    );
    const row = found.rows[0];
    if (!row) fail('NOT_FOUND', 'Worker standing appeal was not found.');
    if (row.status === params.decision && row.resolved_by === params.reviewerId) {
      if (row.resolution_note !== params.resolutionNote) {
        fail('CONFLICT', 'That resolution replay changed the recorded decision.');
      }
      return { appealId: row.id, status: row.status, effectApplied: true };
    }
    if (!['OPEN','UNDER_REVIEW','NEEDS_INFORMATION'].includes(row.status)) fail('CONFLICT', 'Appeal is already terminal.');
    if (row.worker_id === params.reviewerId || row.decided_by === params.reviewerId) {
      fail('FORBIDDEN', 'A different human reviewer must decide this appeal.');
    }
    if (params.decision === 'OVERTURNED') {
      if (row.decision_type === 'DEACTIVATION') {
        await query(
          `UPDATE users SET is_banned=FALSE,
             account_status=CASE WHEN account_status='SUSPENDED' THEN 'ACTIVE' ELSE account_status END,
             updated_at=NOW() WHERE id=$1`,
          [row.worker_id],
        );
        restoredFirebaseUid = row.firebase_uid;
      } else {
        if (!row.target_tier) throw new Error('Progression appeal is missing its target tier.');
        if (row.is_banned) fail('CONFLICT', 'A deactivated account cannot be promoted by a progression appeal.');
        if (row.trust_tier > row.current_tier) {
          if (row.trust_tier < row.target_tier) fail('CONFLICT', 'Worker tier changed and requires a new review.');
        } else if (row.trust_tier !== row.current_tier) {
          fail('CONFLICT', 'Worker tier changed and requires a new review.');
        } else {
          const eligibility = await TrustTierService.evaluatePromotion(row.worker_id, query);
          if (!eligibility.eligible || eligibility.targetTier !== row.target_tier) {
            fail(
              'CONFLICT',
              'Authoritative evidence still does not support progression. Correct the source record before overturning this decision.',
            );
          }
          await query(
            `SELECT set_config('hustlexp.trust_promotion_authority',$1,TRUE)`,
            [`worker-standing-appeal:${row.id}`],
          );
          await query(
            `UPDATE users SET trust_tier=$1,updated_at=NOW() WHERE id=$2 AND trust_tier=$3`,
            [row.target_tier, row.worker_id, row.current_tier],
          );
          await query(
            `UPDATE capability_profiles
             SET trust_tier=$1,
                 risk_clearance=CASE $1::integer
                   WHEN 0 THEN ARRAY['low']::text[]
                   WHEN 1 THEN ARRAY['low']::text[]
                   WHEN 2 THEN ARRAY['low','medium']::text[]
                   ELSE ARRAY['low','medium','high']::text[]
                 END,
                 updated_at=NOW()
             WHERE user_id=$2`,
            [row.target_tier, row.worker_id],
          );
          await query(
            `INSERT INTO trust_ledger(
               user_id,old_tier,new_tier,reason,reason_details,changed_by,
               idempotency_key,event_source,source_event_id
             ) VALUES($1,$2,$3,$4,$5,$6,$7,'appeal',$8)
             ON CONFLICT(idempotency_key) DO NOTHING`,
            [
              row.worker_id,
              row.current_tier,
              row.target_tier,
              `Progression appeal overturned: ${trustTierName(row.target_tier)}`,
              JSON.stringify({ appealId: row.id, decisionId: row.decision_id }),
              params.reviewerId,
              `worker-standing-progression:${row.id}`,
              row.id,
            ],
          );
        }
      }
    }
    const updated = await query<{ id: string; status: AppealStatus; resolved_at: string }>(
      `UPDATE worker_standing_appeals
       SET status=$1,resolution_note=$2,resolved_by=$3,resolved_at=NOW(),
           assigned_reviewer_id=COALESCE(assigned_reviewer_id,$3),outcome_effect_applied=TRUE
       WHERE id=$4
       RETURNING id,status,resolved_at`,
      [params.decision, params.resolutionNote, params.reviewerId, row.id],
    );
    await query(
      `INSERT INTO worker_standing_appeal_events(
         appeal_id,event_type,actor_role,actor_id,public_message,idempotency_key
       ) VALUES ($1,$2,'ADMIN',$3,$4,$5)`,
      [row.id, params.decision, params.reviewerId,
        params.decision === 'OVERTURNED'
          ? 'A different human reviewer overturned the standing decision and applied the correction.'
          : 'A different human reviewer upheld the standing decision and recorded the reason.',
        `worker-standing-appeal-resolution:${params.idempotencyKey}`],
    );
    await writeToOutbox({
      eventType: 'worker.standing_appeal_resolved',
      aggregateType: 'worker_standing_appeal',
      aggregateId: row.id,
      eventVersion: 1,
      idempotencyKey: `worker-standing-appeal-resolved:${row.id}`,
      payload: {
        workerId: row.worker_id,
        appealId: row.id,
        decisionType: row.decision_type,
        result: params.decision,
        resolvedAt: updated.rows[0].resolved_at,
        deliveryTruth: 'QUEUED_NOT_DELIVERED',
      },
      queueName: 'critical_trust',
    }, query);
    return { appealId: row.id, status: params.decision, effectApplied: true };
  });

  if (restoredFirebaseUid) {
    for (const [key, entry] of authCache.entries()) {
      if (entry.user.firebase_uid === restoredFirebaseUid) authCache.delete(key);
    }
    try {
      await redis.del(`auth:revoked:${restoredFirebaseUid}`);
    } catch {
      // Database correction is authoritative. A stale revocation marker expires;
      // the worker is told to retry sign-in if immediate access is unavailable.
    }
  }
  return result;
}
