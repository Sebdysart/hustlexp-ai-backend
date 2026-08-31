import { TRPCError } from '@trpc/server';

import { db } from '../db.js';
import type { Context } from '../trpc-context.js';
import { requireFreshOperatorIdentity } from './OperatorAuthorityService.js';

export const universalV1DisputeIncidentKinds = [
  'QUALITY',
  'SAFETY',
  'SCOPE',
  'PROPERTY_DAMAGE',
  'ACCESS',
  'CONDUCT',
  'OTHER',
] as const;
export type UniversalV1DisputeIncidentKind =
  (typeof universalV1DisputeIncidentKinds)[number];

export const universalV1DisputeEvidenceKinds = [
  'PHOTO',
  'VIDEO',
  'DOCUMENT',
  'MESSAGE',
  'SYSTEM_EVENT',
  'OTHER',
] as const;
export type UniversalV1DisputeEvidenceKind =
  (typeof universalV1DisputeEvidenceKinds)[number];

export const universalV1RecoveryKinds = [
  'REFUND',
  'REVERSAL',
  'REWORK',
  'REPLACEMENT',
  'CANCEL',
  'NO_EFFECT',
] as const;
export type UniversalV1RecoveryKind = (typeof universalV1RecoveryKinds)[number];

export const universalV1DisputeStates = [
  'OPEN',
  'UNDER_REVIEW',
  'RESOLUTION_PROPOSED',
  'RESOLVED',
  'DISMISSED',
] as const;
export type UniversalV1DisputeState = (typeof universalV1DisputeStates)[number];

export const universalV1DisputeActorAuthority = {
  contractVersion: 'universal-v1-dispute-recovery-1.0.0',
  applicationAuthenticatedParticipantRequired: true,
  participantRoleRecheckedByDatabase: true,
  operatorFreshMfaRequired: true,
  operatorCapabilitiesRecheckedByDatabase: true,
  databaseCallerIdentityAttested: false,
  terminalTransitions: 'HELD_PENDING_DEDICATED_CALLER_ATTESTED_COMMAND_ROLE',
  providerOrMoneyEffects: 'NONE',
} as const;

export interface OpenUniversalV1DisputeInput {
  taskId: string;
  expectedTaskVersion: number;
  workOrderId: string;
  expectedWorkOrderVersion: number;
  completionFactId: string;
  expectedCompletionVersion: number;
  expectedExecutionVersion: number;
  incidentKind: UniversalV1DisputeIncidentKind;
  evidenceDigest: string;
  idempotencyKey: string;
}

export interface AddUniversalV1DisputeEvidenceInput {
  disputeId: string;
  expectedDisputeVersion: number;
  evidenceKind: UniversalV1DisputeEvidenceKind;
  evidenceDigest: string;
  contentType: string;
  byteSize: number;
  idempotencyKey: string;
}

export interface BeginUniversalV1DisputeReviewInput {
  disputeId: string;
  expectedDisputeVersion: number;
  evidenceDigest: string;
  idempotencyKey: string;
}

export interface ProposeUniversalV1RecoveryInput {
  disputeId: string;
  expectedDisputeVersion: number;
  recoveryKind: UniversalV1RecoveryKind;
  evidenceDigest: string;
  idempotencyKey: string;
}

export interface RecordUniversalV1RecoveryApprovalInput {
  recoveryIntentId: string;
  expectedDisputeVersion: number;
  evidenceDigest: string;
  idempotencyKey: string;
}

interface DisputeResultRow {
  dispute_id: string;
  dispute_state: UniversalV1DisputeState;
  dispute_version: number | string;
  idempotency_replayed: boolean;
}

interface EvidenceResultRow {
  evidence_fact_id: string;
  dispute_state: UniversalV1DisputeState;
  dispute_version: number | string;
  idempotency_replayed: boolean;
}

interface RecoveryResultRow {
  recovery_intent_id: string;
  dispute_state: UniversalV1DisputeState;
  dispute_version: number | string;
  authority_state: 'HELD_TWO_PERSON_DATABASE_CALLER_UNATTESTED';
  idempotency_replayed: boolean;
}

interface ApprovalResultRow {
  approval_fact_id: string;
  dispute_state: UniversalV1DisputeState;
  dispute_version: number | string;
  authority_state: 'HELD_TWO_PERSON_DATABASE_CALLER_UNATTESTED';
  idempotency_replayed: boolean;
}

function fail(
  code:
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'BAD_REQUEST'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'PRECONDITION_FAILED'
    | 'INTERNAL_SERVER_ERROR',
  message: string,
): never {
  throw new TRPCError({ code, message });
}

function participantId(context: Context): string {
  const user = context.user;
  if (
    !user
    || user.is_banned
    || user.account_status !== 'ACTIVE'
    || user.is_minor !== false
  ) {
    return fail('UNAUTHORIZED', 'An active authenticated participant is required.');
  }
  return user.id;
}

function exactVersion(value: number | string | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return fail('INTERNAL_SERVER_ERROR', 'Dispute authority returned an invalid version.');
  }
  return parsed;
}

function translateDatabaseError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/HXUDR1:/.test(message)) {
    return fail('NOT_FOUND', 'The exact participant-bound Work Order was not found.');
  }
  if (/HXUDR(?:7|11):/.test(message)) {
    return fail('FORBIDDEN', 'Current independent dispute authority is insufficient.');
  }
  if (/HXUDR5:/.test(message)) {
    return fail('NOT_FOUND', 'The exact dispute authority record was not found.');
  }
  if (/HXUDR(?:2|10):/.test(message)) {
    return fail('BAD_REQUEST', 'The dispute command is outside its bounded contract.');
  }
  if (/HXUDR(?:8|9):/.test(message)) {
    return fail(
      'PRECONDITION_FAILED',
      'The material dispute hold prevents this consequential transition.',
    );
  }
  if (/HXUDR(?:3|4|6):/.test(message)) {
    return fail('CONFLICT', 'The dispute or its exact authority version changed.');
  }
  throw error;
}

function disputeResult(row: DisputeResultRow | undefined) {
  if (!row) return fail('INTERNAL_SERVER_ERROR', 'Dispute command returned no result.');
  return {
    disputeId: row.dispute_id,
    state: row.dispute_state,
    version: exactVersion(row.dispute_version),
    idempotencyReplayed: row.idempotency_replayed,
    actorAuthority: universalV1DisputeActorAuthority,
  };
}

export async function openUniversalV1Dispute(
  context: Context,
  input: OpenUniversalV1DisputeInput,
) {
  const actorId = participantId(context);
  try {
    const result = await db.query<DisputeResultRow>(
      `SELECT * FROM public.open_universal_v1_dispute_v1(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       )`,
      [
        input.taskId,
        input.expectedTaskVersion,
        input.workOrderId,
        input.expectedWorkOrderVersion,
        input.completionFactId,
        input.expectedCompletionVersion,
        input.expectedExecutionVersion,
        input.incidentKind,
        input.evidenceDigest,
        actorId,
        input.idempotencyKey,
      ],
    );
    return disputeResult(result.rows[0]);
  } catch (error) {
    return translateDatabaseError(error);
  }
}

export async function addUniversalV1DisputeEvidence(
  context: Context,
  input: AddUniversalV1DisputeEvidenceInput,
) {
  const actorId = participantId(context);
  try {
    const result = await db.query<EvidenceResultRow>(
      `SELECT * FROM public.add_universal_v1_dispute_evidence_v1(
         $1, $2, $3, $4, $5, $6, $7, $8
       )`,
      [
        input.disputeId,
        input.expectedDisputeVersion,
        input.evidenceKind,
        input.evidenceDigest,
        input.contentType,
        input.byteSize,
        actorId,
        input.idempotencyKey,
      ],
    );
    const row = result.rows[0];
    if (!row) return fail('INTERNAL_SERVER_ERROR', 'Evidence command returned no result.');
    return {
      evidenceFactId: row.evidence_fact_id,
      state: row.dispute_state,
      version: exactVersion(row.dispute_version),
      idempotencyReplayed: row.idempotency_replayed,
      rawEvidenceStored: false as const,
    };
  } catch (error) {
    return translateDatabaseError(error);
  }
}

export async function beginUniversalV1DisputeReview(
  context: Context,
  input: BeginUniversalV1DisputeReviewInput,
) {
  const identity = requireFreshOperatorIdentity(context);
  try {
    const result = await db.query<DisputeResultRow>(
      `SELECT * FROM public.begin_universal_v1_dispute_review_v1(
         $1, $2, $3, $4, $5
       )`,
      [
        input.disputeId,
        input.expectedDisputeVersion,
        input.evidenceDigest,
        identity.userId,
        input.idempotencyKey,
      ],
    );
    return disputeResult(result.rows[0]);
  } catch (error) {
    return translateDatabaseError(error);
  }
}

export async function proposeUniversalV1Recovery(
  context: Context,
  input: ProposeUniversalV1RecoveryInput,
) {
  const identity = requireFreshOperatorIdentity(context);
  try {
    const result = await db.query<RecoveryResultRow>(
      `SELECT * FROM public.propose_universal_v1_dispute_recovery_v1(
         $1, $2, $3, $4, $5, $6
       )`,
      [
        input.disputeId,
        input.expectedDisputeVersion,
        input.recoveryKind,
        input.evidenceDigest,
        identity.userId,
        input.idempotencyKey,
      ],
    );
    const row = result.rows[0];
    if (!row) return fail('INTERNAL_SERVER_ERROR', 'Recovery proposal returned no result.');
    return {
      recoveryIntentId: row.recovery_intent_id,
      state: row.dispute_state,
      version: exactVersion(row.dispute_version),
      authorityState: row.authority_state,
      idempotencyReplayed: row.idempotency_replayed,
      effectCreated: false as const,
      actorAuthority: universalV1DisputeActorAuthority,
    };
  } catch (error) {
    return translateDatabaseError(error);
  }
}

export async function recordUniversalV1RecoveryApproval(
  context: Context,
  input: RecordUniversalV1RecoveryApprovalInput,
) {
  const identity = requireFreshOperatorIdentity(context);
  try {
    const result = await db.query<ApprovalResultRow>(
      `SELECT * FROM public.record_universal_v1_recovery_approval_v1(
         $1, $2, $3, $4, $5
       )`,
      [
        input.recoveryIntentId,
        input.expectedDisputeVersion,
        input.evidenceDigest,
        identity.userId,
        input.idempotencyKey,
      ],
    );
    const row = result.rows[0];
    if (!row) return fail('INTERNAL_SERVER_ERROR', 'Recovery approval returned no result.');
    return {
      approvalFactId: row.approval_fact_id,
      state: row.dispute_state,
      version: exactVersion(row.dispute_version),
      authorityState: row.authority_state,
      idempotencyReplayed: row.idempotency_replayed,
      terminalTransitionCreated: false as const,
      effectCreated: false as const,
      actorAuthority: universalV1DisputeActorAuthority,
    };
  } catch (error) {
    return translateDatabaseError(error);
  }
}
