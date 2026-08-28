import { createHash, randomBytes } from 'node:crypto';
import type { QueryFn } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';

export const WORKER_STANDING_POLICY_VERSION = 'worker-standing-appeals-v1';
export const WORKER_STANDING_APPEAL_DAYS = 30;

export function workerStandingTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function workerStandingDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export type DeactivationAppealRight = {
  decisionId: string;
  appealDeadlineAt: string;
  appealPath: string | null;
  newlyIssued: boolean;
};

export async function issueDeactivationAppealRight(params: {
  query: QueryFn;
  workerId: string;
  currentTier: number;
  decidedBy: string | null;
  decisionSource: 'SYSTEM' | 'ADMIN';
  reason: string;
  sourceIdempotencyKey: string;
}): Promise<DeactivationAppealRight> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = workerStandingTokenHash(token);
  const explanation = params.reason.trim().length >= 10
    ? `Your HustleXP work access was deactivated for this stated reason: ${params.reason.trim()}`.slice(0, 2000)
    : 'Your HustleXP work access was deactivated under the worker standing policy.';
  const inserted = await params.query<{ id: string; appeal_deadline_at: string }>(
    `INSERT INTO worker_standing_decisions (
       worker_id,decision_type,decision_state,current_tier,target_tier,reason_codes,
       public_explanation,policy_version,decision_source,decided_by,
       source_idempotency_key,appeal_deadline_at
     ) VALUES ($1,'DEACTIVATION','WORK_ACCESS_DEACTIVATED',$2,NULL,$3,$4,$5,$6,$7,$8,
       NOW()+($9::INTEGER*INTERVAL '1 day'))
     ON CONFLICT (source_idempotency_key) DO NOTHING
     RETURNING id,appeal_deadline_at`,
    [params.workerId, Math.max(0, Math.min(4, params.currentTier)), ['WORK_ACCESS_DEACTIVATED'],
      explanation, WORKER_STANDING_POLICY_VERSION, params.decisionSource, params.decidedBy,
      params.sourceIdempotencyKey, WORKER_STANDING_APPEAL_DAYS],
  );

  if (!inserted.rows[0]) {
    const existing = await params.query<{ id: string; appeal_deadline_at: string }>(
      `SELECT id,appeal_deadline_at FROM worker_standing_decisions
       WHERE source_idempotency_key=$1`,
      [params.sourceIdempotencyKey],
    );
    if (!existing.rows[0]) throw new Error('Worker standing decision replay could not be recovered.');
    return {
      decisionId: existing.rows[0].id,
      appealDeadlineAt: existing.rows[0].appeal_deadline_at,
      appealPath: null,
      newlyIssued: false,
    };
  }

  const decision = inserted.rows[0];
  await params.query(
    `INSERT INTO worker_standing_appeal_access(decision_id,token_hash,expires_at)
     VALUES ($1,$2,$3)`,
    [decision.id, tokenHash, decision.appeal_deadline_at],
  );
  const appealPath = `/earn/appeal/${token}`;
  await writeToOutbox({
    eventType: 'worker.standing_decision_notice',
    aggregateType: 'worker_standing_decision',
    aggregateId: decision.id,
    eventVersion: 1,
    idempotencyKey: `worker-standing-notice:${decision.id}`,
    payload: {
      workerId: params.workerId,
      decisionId: decision.id,
      decisionType: 'DEACTIVATION',
      explanation,
      appealDeadlineAt: decision.appeal_deadline_at,
      appealPath,
      deliveryTruth: 'QUEUED_NOT_DELIVERED',
    },
    queueName: 'critical_trust',
  }, params.query);
  return {
    decisionId: decision.id,
    appealDeadlineAt: decision.appeal_deadline_at,
    appealPath,
    newlyIssued: true,
  };
}
