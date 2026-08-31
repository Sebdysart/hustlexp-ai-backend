import { TRPCError } from '@trpc/server';

import { db, type QueryFn } from '../db.js';
import { requireFreshOperatorIdentity } from './OperatorAuthorityService.js';
import type { Context } from '../trpc-context.js';

export const universalV1OpsCaseCategories = [
  'SAFETY',
  'MONEY',
  'FULFILLMENT',
  'CREDENTIAL',
  'COMMUNICATION',
  'DATA_INTEGRITY',
  'POLICY',
] as const;
export type UniversalV1OpsCaseCategory = (typeof universalV1OpsCaseCategories)[number];

export const universalV1OpsCaseSeverities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type UniversalV1OpsCaseSeverity = (typeof universalV1OpsCaseSeverities)[number];

export const universalV1OpsCaseStatuses = [
  'OPEN',
  'ACKNOWLEDGED',
  'CONTAINED',
  'RESOLVED',
] as const;
export type UniversalV1OpsCaseStatus = (typeof universalV1OpsCaseStatuses)[number];

export const universalV1OpsCaseTransitionKinds = ['CONTAIN', 'RESOLVE'] as const;
export type UniversalV1OpsCaseTransitionKind = (typeof universalV1OpsCaseTransitionKinds)[number];

/**
 * Current actor proof is intentionally explicit. The application binds the
 * verified named token to actorId and the database rechecks current RBAC, but
 * the shared runtime login does not yet let PostgreSQL attest that actorId is
 * the physical database caller. Direct command-role invocation therefore
 * remains held pending dedicated runtime/command roles.
 */
export const universalV1OpsCaseActorAuthority = {
  contractVersion: 'HX_UNIVERSAL_V1_OPS_CASE_ACTOR_AUTHORITY_V1',
  applicationNamedIdentityRequired: true,
  freshMfaStepUpRequired: true,
  databaseRoleRechecked: true,
  independentAdminForConsequentialTransitions: true,
  databaseCallerIdentityAttested: false,
  directFunctionInvocation: 'HELD_PENDING_DEDICATED_COMMAND_ROLE',
} as const;

export interface OpenUniversalV1OpsCaseInput {
  occurrenceId: string;
  occurrenceEventName: string;
  occurrenceVersion: number;
  aggregateKind: string;
  aggregateId: string;
  aggregateVersion: number;
  category: UniversalV1OpsCaseCategory;
  severity: UniversalV1OpsCaseSeverity;
  reason: string;
  evidenceDigest: string;
  idempotencyKey: string;
}

export interface AcknowledgeUniversalV1OpsCaseInput {
  caseId: string;
  expectedVersion: number;
  reason: string;
  evidenceDigest: string;
  idempotencyKey: string;
}

export interface RequestUniversalV1OpsCaseTransitionInput {
  caseId: string;
  expectedCaseVersion: number;
  transitionKind: UniversalV1OpsCaseTransitionKind;
  reason: string;
  evidenceDigest: string;
  idempotencyKey: string;
}

export interface DecideUniversalV1OpsCaseTransitionInput {
  transitionRequestId: string;
  expectedRequestVersion: number;
  expectedCaseVersion: number;
  decision: 'APPROVE' | 'REJECT';
  reason: string;
  evidenceDigest: string;
  idempotencyKey: string;
}

interface CaseResultRow {
  case_id: string;
  case_status: UniversalV1OpsCaseStatus;
  case_version: number | string;
  idempotency_replayed: boolean;
}

interface TransitionResultRow {
  transition_request_id: string;
  request_status: 'PENDING' | 'APPROVED' | 'REJECTED';
  request_version: number | string;
  case_version: number | string;
  idempotency_replayed: boolean;
}

interface DecisionResultRow extends CaseResultRow {
  request_status: 'APPROVED' | 'REJECTED';
  request_version: number | string;
}

interface OpsCaseDetailRow {
  id: string;
  occurrence_id: string;
  occurrence_event_name: string;
  occurrence_version: number;
  aggregate_kind: string;
  aggregate_id: string;
  aggregate_version: number | string;
  category: UniversalV1OpsCaseCategory;
  severity: UniversalV1OpsCaseSeverity;
  opening_reason: string;
  opening_evidence_digest: string;
  status: UniversalV1OpsCaseStatus;
  opened_at: Date | string;
  acknowledged_at: Date | string | null;
  contained_at: Date | string | null;
  resolved_at: Date | string | null;
  last_transition_at: Date | string;
  version: number | string;
  opened_by_display_name: string;
  acknowledged_by_display_name: string | null;
  contained_by_display_name: string | null;
  resolved_by_display_name: string | null;
}

function fail(
  code: 'FORBIDDEN' | 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL_SERVER_ERROR',
  message: string
): never {
  throw new TRPCError({ code, message });
}

function exactVersion(value: number | string, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return fail('INTERNAL_SERVER_ERROR', `${label} returned an invalid version.`);
  }
  return parsed;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return fail('INTERNAL_SERVER_ERROR', 'Operations case returned an invalid timestamp.');
  }
  return timestamp.toISOString();
}

function translateDatabaseError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/HXUOC(?:1|2|16):/.test(message)) {
    return fail('FORBIDDEN', 'Current independent Operations authority is insufficient.');
  }
  if (/HXUOC(?:4|22|31):/.test(message)) {
    return fail('NOT_FOUND', 'The exact Operations case authority record was not found.');
  }
  if (/HXUOC(?:3|5|8|13|26|30):/.test(message)) {
    return fail('BAD_REQUEST', 'The Operations case command is outside its bounded contract.');
  }
  if (/HXUOC\d+:/.test(message)) {
    return fail('CONFLICT', 'The Operations case or its exact authority version changed.');
  }
  throw error;
}

async function assertDatabaseOperator(query: QueryFn, actorId: string): Promise<void> {
  await query('SELECT public.assert_universal_v1_ops_case_operator_v1($1, FALSE)', [actorId]);
}

function caseResult(row: CaseResultRow | undefined) {
  if (!row) return fail('INTERNAL_SERVER_ERROR', 'Operations case command returned no result.');
  return {
    caseId: row.case_id,
    status: row.case_status,
    version: exactVersion(row.case_version, 'Operations case'),
    idempotencyReplayed: row.idempotency_replayed,
    actorAuthority: universalV1OpsCaseActorAuthority,
  };
}

export async function openUniversalV1OpsCase(context: Context, input: OpenUniversalV1OpsCaseInput) {
  const identity = requireFreshOperatorIdentity(context);
  try {
    const result = await db.query<CaseResultRow>(
      `SELECT * FROM public.open_universal_v1_ops_case_v1(
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12
       )`,
      [
        input.occurrenceId,
        input.occurrenceEventName,
        input.occurrenceVersion,
        input.aggregateKind,
        input.aggregateId,
        input.aggregateVersion,
        input.category,
        input.severity,
        input.reason,
        input.evidenceDigest,
        identity.userId,
        input.idempotencyKey,
      ]
    );
    return caseResult(result.rows[0]);
  } catch (error) {
    return translateDatabaseError(error);
  }
}

export async function acknowledgeUniversalV1OpsCase(
  context: Context,
  input: AcknowledgeUniversalV1OpsCaseInput
) {
  const identity = requireFreshOperatorIdentity(context);
  try {
    const result = await db.query<CaseResultRow>(
      `SELECT * FROM public.acknowledge_universal_v1_ops_case_v1(
         $1, $2, $3, $4, $5, $6
       )`,
      [
        input.caseId,
        input.expectedVersion,
        input.reason,
        input.evidenceDigest,
        identity.userId,
        input.idempotencyKey,
      ]
    );
    return caseResult(result.rows[0]);
  } catch (error) {
    return translateDatabaseError(error);
  }
}

export async function requestUniversalV1OpsCaseTransition(
  context: Context,
  input: RequestUniversalV1OpsCaseTransitionInput
) {
  const identity = requireFreshOperatorIdentity(context);
  try {
    const result = await db.query<TransitionResultRow>(
      `SELECT * FROM public.request_universal_v1_ops_case_transition_v1(
         $1, $2, $3, $4, $5, $6, $7
       )`,
      [
        input.caseId,
        input.expectedCaseVersion,
        input.transitionKind,
        input.reason,
        input.evidenceDigest,
        identity.userId,
        input.idempotencyKey,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      return fail(
        'INTERNAL_SERVER_ERROR',
        'Operations case transition request returned no result.'
      );
    }
    return {
      transitionRequestId: row.transition_request_id,
      status: row.request_status,
      version: exactVersion(row.request_version, 'Operations case transition request'),
      caseVersion: exactVersion(row.case_version, 'Operations case'),
      idempotencyReplayed: row.idempotency_replayed,
      actorAuthority: universalV1OpsCaseActorAuthority,
    };
  } catch (error) {
    return translateDatabaseError(error);
  }
}

export async function decideUniversalV1OpsCaseTransition(
  context: Context,
  input: DecideUniversalV1OpsCaseTransitionInput
) {
  const identity = requireFreshOperatorIdentity(context);
  try {
    const result = await db.query<DecisionResultRow>(
      `SELECT * FROM public.decide_universal_v1_ops_case_transition_v1(
         $1, $2, $3, $4, $5, $6, $7, $8
       )`,
      [
        input.transitionRequestId,
        input.expectedRequestVersion,
        input.expectedCaseVersion,
        input.decision,
        input.reason,
        input.evidenceDigest,
        identity.userId,
        input.idempotencyKey,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      return fail('INTERNAL_SERVER_ERROR', 'Operations case transition returned no result.');
    }
    return {
      caseId: row.case_id,
      status: row.case_status,
      version: exactVersion(row.case_version, 'Operations case'),
      requestStatus: row.request_status,
      requestVersion: exactVersion(row.request_version, 'Operations case transition request'),
      idempotencyReplayed: row.idempotency_replayed,
      actorAuthority: universalV1OpsCaseActorAuthority,
    };
  } catch (error) {
    return translateDatabaseError(error);
  }
}

export async function listUniversalV1OpsCases(
  context: Context,
  input: { status?: UniversalV1OpsCaseStatus; limit: number; offset: number }
) {
  const identity = requireFreshOperatorIdentity(context);
  try {
    await assertDatabaseOperator(db.query, identity.userId);
    const result = await db.query<OpsCaseDetailRow>(
      `SELECT ops_case.id,
              ops_case.occurrence_id,
              ops_case.occurrence_event_name,
              ops_case.occurrence_version,
              ops_case.aggregate_kind,
              ops_case.aggregate_id,
              ops_case.aggregate_version,
              ops_case.category,
              ops_case.severity,
              ops_case.status,
              ops_case.opened_at,
              ops_case.acknowledged_at,
              ops_case.contained_at,
              ops_case.resolved_at,
              ops_case.last_transition_at,
              ops_case.version
         FROM public.universal_v1_ops_cases ops_case
        WHERE ($1::text IS NULL OR ops_case.status = $1)
        ORDER BY
          CASE ops_case.severity
            WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
            WHEN 'MEDIUM' THEN 3 ELSE 4
          END,
          ops_case.opened_at,
          ops_case.id
        LIMIT $2 OFFSET $3`,
      [input.status ?? null, input.limit, input.offset]
    );
    return {
      actorAuthority: universalV1OpsCaseActorAuthority,
      cases: result.rows.map((row) => ({
        id: row.id,
        occurrenceId: row.occurrence_id,
        occurrenceEventName: row.occurrence_event_name,
        occurrenceVersion: row.occurrence_version,
        aggregateKind: row.aggregate_kind,
        aggregateId: row.aggregate_id,
        aggregateVersion: exactVersion(row.aggregate_version, 'Operations aggregate'),
        category: row.category,
        severity: row.severity,
        status: row.status,
        openedAt: iso(row.opened_at),
        acknowledgedAt: iso(row.acknowledged_at),
        containedAt: iso(row.contained_at),
        resolvedAt: iso(row.resolved_at),
        lastTransitionAt: iso(row.last_transition_at),
        version: exactVersion(row.version, 'Operations case'),
      })),
    };
  } catch (error) {
    return translateDatabaseError(error);
  }
}

export async function getUniversalV1OpsCase(
  context: Context,
  input: { caseId: string; purpose: string }
) {
  const identity = requireFreshOperatorIdentity(context);
  try {
    return await db.transaction(async (query) => {
      await assertDatabaseOperator(query, identity.userId);
      const result = await query<OpsCaseDetailRow>(
        `SELECT ops_case.id,
                ops_case.occurrence_id,
                ops_case.occurrence_event_name,
                ops_case.occurrence_version,
                ops_case.aggregate_kind,
                ops_case.aggregate_id,
                ops_case.aggregate_version,
                ops_case.category,
                ops_case.severity,
                ops_case.opening_reason,
                ops_case.opening_evidence_digest,
                ops_case.status,
                ops_case.opened_at,
                ops_case.acknowledged_at,
                ops_case.contained_at,
                ops_case.resolved_at,
                ops_case.last_transition_at,
                ops_case.version,
                COALESCE(NULLIF(BTRIM(opened.full_name), ''), opened.email) AS opened_by_display_name,
                CASE WHEN acknowledged.id IS NULL THEN NULL
                  ELSE COALESCE(NULLIF(BTRIM(acknowledged.full_name), ''), acknowledged.email)
                END AS acknowledged_by_display_name,
                CASE WHEN contained.id IS NULL THEN NULL
                  ELSE COALESCE(NULLIF(BTRIM(contained.full_name), ''), contained.email)
                END AS contained_by_display_name,
                CASE WHEN resolved.id IS NULL THEN NULL
                  ELSE COALESCE(NULLIF(BTRIM(resolved.full_name), ''), resolved.email)
                END AS resolved_by_display_name
           FROM public.universal_v1_ops_cases ops_case
           JOIN public.users opened ON opened.id = ops_case.opened_by
           LEFT JOIN public.users acknowledged ON acknowledged.id = ops_case.acknowledged_by
           LEFT JOIN public.users contained ON contained.id = ops_case.contained_by
           LEFT JOIN public.users resolved ON resolved.id = ops_case.resolved_by
          WHERE ops_case.id = $1
          FOR SHARE OF ops_case`,
        [input.caseId]
      );
      const row = result.rows[0];
      if (!row) return fail('NOT_FOUND', 'Operations case was not found.');

      await query(
        `INSERT INTO public.universal_v1_ops_case_access_audit(
           case_id, case_version, actor_id, purpose
         ) VALUES ($1, $2, $3, $4)`,
        [row.id, row.version, identity.userId, input.purpose]
      );
      const timeline = await query(
        `SELECT event.sequence,
                event.case_version,
                event.event_type,
                event.from_status,
                event.to_status,
                event.requested_status,
                event.reason,
                event.evidence_digest,
                event.created_at,
                COALESCE(NULLIF(BTRIM(actor.full_name), ''), actor.email) AS actor_display_name,
                event.actor_id = $2 AS acted_by_current_operator
           FROM public.universal_v1_ops_case_timeline event
           JOIN public.users actor ON actor.id = event.actor_id
          WHERE event.case_id = $1
          ORDER BY event.sequence, event.id`,
        [row.id, identity.userId]
      );
      const transitionRequests = await query(
        `SELECT request.id,
                request.transition_kind,
                request.target_status,
                request.case_expected_version,
                request.reason,
                request.evidence_digest,
                request.status,
                request.requested_at,
                request.decided_at,
                request.version,
                COALESCE(NULLIF(BTRIM(requester.full_name), ''), requester.email)
                  AS requester_display_name,
                CASE WHEN decider.id IS NULL THEN NULL
                  ELSE COALESCE(NULLIF(BTRIM(decider.full_name), ''), decider.email)
                END AS decider_display_name,
                request.requested_by = $2 AS requested_by_current_operator,
                request.decided_by = $2 AS decided_by_current_operator
           FROM public.universal_v1_ops_case_transition_requests request
           JOIN public.users requester ON requester.id = request.requested_by
           LEFT JOIN public.users decider ON decider.id = request.decided_by
          WHERE request.case_id = $1
          ORDER BY request.requested_at, request.id`,
        [row.id, identity.userId]
      );

      return {
        actorAuthority: universalV1OpsCaseActorAuthority,
        id: row.id,
        occurrence: {
          id: row.occurrence_id,
          eventName: row.occurrence_event_name,
          version: row.occurrence_version,
        },
        aggregate: {
          kind: row.aggregate_kind,
          id: row.aggregate_id,
          version: exactVersion(row.aggregate_version, 'Operations aggregate'),
        },
        category: row.category,
        severity: row.severity,
        openingReason: row.opening_reason,
        openingEvidenceDigest: row.opening_evidence_digest,
        status: row.status,
        version: exactVersion(row.version, 'Operations case'),
        openedAt: iso(row.opened_at),
        acknowledgedAt: iso(row.acknowledged_at),
        containedAt: iso(row.contained_at),
        resolvedAt: iso(row.resolved_at),
        lastTransitionAt: iso(row.last_transition_at),
        operators: {
          openedBy: row.opened_by_display_name,
          acknowledgedBy: row.acknowledged_by_display_name,
          containedBy: row.contained_by_display_name,
          resolvedBy: row.resolved_by_display_name,
        },
        timeline: timeline.rows,
        transitionRequests: transitionRequests.rows,
      };
    });
  } catch (error) {
    return translateDatabaseError(error);
  }
}

export const UniversalV1OpsCaseService = {
  open: openUniversalV1OpsCase,
  acknowledge: acknowledgeUniversalV1OpsCase,
  requestTransition: requestUniversalV1OpsCaseTransition,
  decideTransition: decideUniversalV1OpsCaseTransition,
  list: listUniversalV1OpsCases,
  get: getUniversalV1OpsCase,
};
