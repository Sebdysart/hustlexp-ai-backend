import { TRPCError } from '@trpc/server';

import { db } from '../db.js';
import type { Context } from '../trpc-context.js';
import { requireFreshOperatorIdentity } from './OperatorAuthorityService.js';
import {
  universalV1DisputeActorAuthority,
  type UniversalV1DisputeIncidentKind,
  type UniversalV1DisputeState,
} from './UniversalV1DisputeRecoveryService.js';

interface ParticipantDetailRow {
  dispute_id: string;
  task_draft_id: string;
  task_id: string;
  task_version: number | string;
  routing_outcome: string;
  routing_decision_version: number | string;
  work_order_id: string;
  work_order_materialization_version: number | string;
  completion_fact_id: string;
  completion_version: number | string;
  execution_fact_id: string;
  execution_version: number | string;
  opened_by_role: 'CUSTOMER' | 'PROVIDER';
  incident_kind: UniversalV1DisputeIncidentKind;
  materiality: 'MATERIAL';
  opening_evidence_sha256: string;
  opened_at: Date | string;
  dispute_state: UniversalV1DisputeState;
  dispute_version: number | string;
  last_transition_at: Date | string;
  viewer_role: 'CUSTOMER' | 'PROVIDER';
  timeline: unknown;
  evidence: unknown;
  recovery: unknown;
}

interface MineRow {
  dispute_id: string;
  task_id: string;
  work_order_id: string;
  completion_fact_id: string;
  incident_kind: UniversalV1DisputeIncidentKind;
  materiality: 'MATERIAL';
  dispute_state: UniversalV1DisputeState;
  dispute_version: number | string;
  opened_at: Date | string;
  last_transition_at: Date | string;
  viewer_role: 'CUSTOMER' | 'PROVIDER';
}

function fail(
  code: 'UNAUTHORIZED' | 'NOT_FOUND' | 'FORBIDDEN' | 'INTERNAL_SERVER_ERROR',
  message: string,
): never {
  throw new TRPCError({ code, message });
}

function activeUserId(context: Context): string {
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

function exactVersion(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return fail('INTERNAL_SERVER_ERROR', 'Dispute read model returned an invalid version.');
  }
  return parsed;
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fail('INTERNAL_SERVER_ERROR', 'Dispute read model returned an invalid timestamp.');
  }
  return parsed.toISOString();
}

function safeArray(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}

function participantDetail(row: ParticipantDetailRow) {
  return {
    disputeId: row.dispute_id,
    authority: {
      taskDraftId: row.task_draft_id,
      taskId: row.task_id,
      taskVersion: exactVersion(row.task_version),
      routingOutcome: row.routing_outcome,
      routingDecisionVersion: exactVersion(row.routing_decision_version),
      workOrderId: row.work_order_id,
      workOrderMaterializationVersion: exactVersion(row.work_order_materialization_version),
      completionFactId: row.completion_fact_id,
      completionVersion: exactVersion(row.completion_version),
      executionFactId: row.execution_fact_id,
      executionVersion: exactVersion(row.execution_version),
    },
    incident: {
      kind: row.incident_kind,
      materiality: row.materiality,
      openedByRole: row.opened_by_role,
      openingEvidenceDigest: row.opening_evidence_sha256,
      openedAt: iso(row.opened_at),
    },
    state: row.dispute_state,
    version: exactVersion(row.dispute_version),
    lastTransitionAt: iso(row.last_transition_at),
    viewerRole: row.viewer_role,
    timeline: safeArray(row.timeline),
    evidence: safeArray(row.evidence),
    recovery: safeArray(row.recovery),
    redaction: {
      rawNarrativeReturned: false,
      rawEvidenceReturned: false,
      addressReturned: false,
      providerReferenceReturned: false,
      otherPartyIdentityReturned: false,
    },
    actorAuthority: universalV1DisputeActorAuthority,
  };
}

const PARTICIPANT_DETAIL_SQL = `
  SELECT current_state.dispute_id,
         current_state.task_draft_id,
         current_state.task_id,
         current_state.task_version,
         current_state.routing_outcome,
         current_state.routing_decision_version,
         current_state.work_order_id,
         current_state.work_order_materialization_version,
         current_state.completion_fact_id,
         current_state.completion_version,
         current_state.execution_fact_id,
         current_state.execution_version,
         current_state.opened_by_role,
         current_state.incident_kind,
         current_state.materiality,
         current_state.opening_evidence_sha256,
         current_state.opened_at,
         current_state.dispute_state,
         current_state.dispute_version,
         current_state.last_transition_at,
         public.assert_universal_v1_dispute_participant_v1(
           current_state.work_order_id, $2
         ) AS viewer_role,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'version', event.event_version,
             'kind', event.event_kind,
             'fromState', event.from_state,
             'toState', event.to_state,
             'actorRole', event.actor_role,
             'evidenceDigest', event.evidence_sha256,
             'recordedAt', event.recorded_at
           ) ORDER BY event.event_version)
           FROM public.universal_v1_dispute_timeline_events event
           WHERE event.dispute_id = current_state.dispute_id
         ), '[]'::jsonb) AS timeline,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'evidenceFactId', evidence.evidence_fact_id,
             'version', evidence.evidence_version,
             'kind', evidence.evidence_kind,
             'digest', evidence.evidence_sha256,
             'contentType', evidence.content_type,
             'byteSize', evidence.byte_size,
             'submittedByRole', evidence.submitted_by_role,
             'recordedAt', evidence.recorded_at
           ) ORDER BY evidence.evidence_version)
           FROM public.universal_v1_dispute_evidence_facts evidence
           WHERE evidence.dispute_id = current_state.dispute_id
         ), '[]'::jsonb) AS evidence,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'recoveryIntentId', intent.recovery_intent_id,
             'version', intent.proposal_version,
             'kind', intent.recovery_kind,
             'evidenceDigest', intent.proposal_evidence_sha256,
             'authorityState', intent.authority_state,
             'proposedAt', intent.proposed_at,
             'independentlyReviewed', EXISTS (
               SELECT 1
               FROM public.universal_v1_dispute_recovery_approval_facts approval
               WHERE approval.recovery_intent_id = intent.recovery_intent_id
             )
           ) ORDER BY intent.proposal_version)
           FROM public.universal_v1_dispute_recovery_intents intent
           WHERE intent.dispute_id = current_state.dispute_id
         ), '[]'::jsonb) AS recovery
  FROM public.universal_v1_dispute_current_v1 current_state
  WHERE current_state.dispute_id = $1
`;

const OPERATOR_DETAIL_SQL = PARTICIPANT_DETAIL_SQL.replace(
  'public.assert_universal_v1_dispute_participant_v1(\n           current_state.work_order_id, $2\n         )',
  "'CUSTOMER'::TEXT",
);

if (OPERATOR_DETAIL_SQL.includes('$2')) {
  throw new Error('Operator dispute read projection retained a participant-only parameter.');
}

export async function getUniversalV1DisputeForParticipant(
  context: Context,
  disputeId: string,
) {
  const actorId = activeUserId(context);
  try {
    const result = await db.query<ParticipantDetailRow>(PARTICIPANT_DETAIL_SQL, [
      disputeId,
      actorId,
    ]);
    const row = result.rows[0];
    if (!row) return fail('NOT_FOUND', 'Dispute not found.');
    return participantDetail(row);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/HXUDR1:/.test(message)) return fail('NOT_FOUND', 'Dispute not found.');
    throw error;
  }
}

export async function listUniversalV1DisputesForParticipant(
  context: Context,
  limit: number,
  offset: number,
) {
  const actorId = activeUserId(context);
  const result = await db.query<MineRow>(
    `SELECT current_state.dispute_id,
            current_state.task_id,
            current_state.work_order_id,
            current_state.completion_fact_id,
            current_state.incident_kind,
            current_state.materiality,
            current_state.dispute_state,
            current_state.dispute_version,
            current_state.opened_at,
            current_state.last_transition_at,
            CASE
              WHEN task.poster_id = $1 THEN 'CUSTOMER'
              ELSE 'PROVIDER'
            END AS viewer_role
       FROM public.universal_v1_dispute_current_v1 current_state
       JOIN public.task_work_orders work_order
         ON work_order.id = current_state.work_order_id
       JOIN public.tasks task ON task.id = work_order.task_id
       JOIN public.users viewer ON viewer.id = $1
        AND viewer.account_status = 'ACTIVE'
        AND viewer.is_minor IS FALSE
        AND COALESCE(viewer.is_banned, FALSE) IS FALSE
      WHERE (
        task.poster_id = viewer.id
        OR work_order.provider_user_id = viewer.id
        OR EXISTS (
          SELECT 1 FROM public.business_memberships membership
          WHERE membership.organization_id = work_order.provider_organization_id
            AND membership.user_id = viewer.id
            AND membership.status = 'ACTIVE'
            AND membership.role IN ('OWNER', 'ADMIN', 'DISPATCHER', 'CREW')
        )
      )
      ORDER BY current_state.opened_at DESC, current_state.dispute_id
      LIMIT $2 OFFSET $3`,
    [actorId, limit, offset],
  );
  return result.rows.map((row) => ({
    disputeId: row.dispute_id,
    taskId: row.task_id,
    workOrderId: row.work_order_id,
    completionFactId: row.completion_fact_id,
    incidentKind: row.incident_kind,
    materiality: row.materiality,
    state: row.dispute_state,
    version: exactVersion(row.dispute_version),
    openedAt: iso(row.opened_at),
    lastTransitionAt: iso(row.last_transition_at),
    viewerRole: row.viewer_role,
  }));
}

export async function getUniversalV1DisputeForOperator(
  context: Context,
  disputeId: string,
) {
  const identity = requireFreshOperatorIdentity(context);
  try {
    const result = await db.query<ParticipantDetailRow & {
      opened_by_user_id: string;
      operator_timeline: unknown;
      operator_authority: string;
    }>(
      `SELECT participant.*,
            current_state.opened_by_user_id,
            public.assert_universal_v1_dispute_operator_v1($2)
              AS operator_authority,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'version', event.event_version,
                'kind', event.event_kind,
                'fromState', event.from_state,
                'toState', event.to_state,
                'actorUserId', event.actor_user_id,
                'actorDisplayName', COALESCE(NULLIF(btrim(actor.full_name), ''), 'Named participant'),
                'actorRole', event.actor_role,
                'evidenceDigest', event.evidence_sha256,
                'recordedAt', event.recorded_at
              ) ORDER BY event.event_version)
              FROM public.universal_v1_dispute_timeline_events event
              JOIN public.users actor ON actor.id = event.actor_user_id
              WHERE event.dispute_id = current_state.dispute_id
            ), '[]'::jsonb) AS operator_timeline
       FROM (${OPERATOR_DETAIL_SQL}) participant
       JOIN public.universal_v1_dispute_current_v1 current_state
         ON current_state.dispute_id = participant.dispute_id`,
      [disputeId, identity.userId],
    );
    const row = result.rows[0];
    if (!row) return fail('NOT_FOUND', 'Dispute not found.');
    const redacted = participantDetail(row);
    return {
      ...redacted,
      openedByUserId: row.opened_by_user_id,
      timeline: safeArray(row.operator_timeline),
      viewerRole: 'NAMED_OPERATOR' as const,
      redaction: {
        ...redacted.redaction,
        otherPartyIdentityReturned: true,
      },
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/HXUDR7:/.test(message)) {
      return fail('FORBIDDEN', 'Current dispute operator authority is required.');
    }
    throw error;
  }
}
