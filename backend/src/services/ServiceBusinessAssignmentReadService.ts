import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { serviceBusinessFailure } from './ServiceBusinessErrors.js';
import type {
  ServiceBusinessAssignment,
  ServiceBusinessEligibleCrew,
} from './ServiceBusinessExecutionTypes.js';

function failure<T>(error: unknown): ServiceResult<T> {
  return serviceBusinessFailure(
    error,
    'SERVICE_BUSINESS_FAILED',
    'Service Business work could not be read.',
  );
}

export async function listServiceBusinessEligibleCrew(input: {
  actorId: string;
  organizationId: string;
  serviceProfileId: string;
  taskId: string;
}): Promise<ServiceResult<ServiceBusinessEligibleCrew[]>> {
  try {
    const result = await db.query<{
      crew_assignment_id: string;
      fulfiller_name: string;
      member_role: ServiceBusinessEligibleCrew['memberRole'];
    }>(
      `WITH authority AS (
         SELECT business_require_action($1,$2,'ASSIGN_CREW')
       )
       SELECT crew.id AS crew_assignment_id,
              COALESCE(NULLIF(BTRIM(fulfiller.full_name),''),'Verified crew member') AS fulfiller_name,
              membership.role AS member_role
         FROM business_service_crew_assignments crew
         JOIN business_memberships membership
           ON membership.id=crew.membership_id AND membership.status='ACTIVE'
         JOIN users fulfiller ON fulfiller.id=membership.user_id
         CROSS JOIN authority
         CROSS JOIN LATERAL evaluate_service_business_assignment(
           $1,$2,$3,crew.id,$4,NULL
         ) evaluation
        WHERE crew.organization_id=$1
          AND crew.service_profile_id=$3
          AND evaluation.ready=TRUE
        ORDER BY fulfiller.full_name ASC,crew.id ASC`,
      [input.organizationId,input.actorId,input.serviceProfileId,input.taskId],
    );
    return {
      success: true,
      data: result.rows.map((row) => ({
        crewAssignmentId: row.crew_assignment_id,
        fulfillerName: row.fulfiller_name,
        memberRole: row.member_role,
      })),
    };
  } catch (error) {
    return failure(error);
  }
}

interface ServiceBusinessAssignmentRow {
  task_id: string;
  title: string;
  category: string;
  rough_location: string;
  task_state: string;
  progress_state: string;
  fulfiller_name: string;
  payout_cents: number | string;
  escrow_state: string;
  stripe_transfer_id: string | null;
  provider_transfer_status: string | null;
  accepted_at: string | Date;
  completed_at: string | Date | null;
}

function assignmentPayoutState(
  row: ServiceBusinessAssignmentRow,
): ServiceBusinessAssignment['payoutState'] {
  if (
    row.escrow_state === 'RELEASED'
    && (row.stripe_transfer_id !== null || row.provider_transfer_status === 'paid')
  ) return 'CONNECTED_BALANCE_CONFIRMED';
  if (row.escrow_state === 'LOCKED_DISPUTE' || row.task_state === 'DISPUTED') return 'HELD';
  if (row.escrow_state === 'REFUND_PARTIAL') return 'PARTIALLY_SETTLED_OR_REFUNDED';
  if (row.escrow_state === 'REFUNDED') return 'REFUNDED_OR_REVERSED';
  if (
    row.escrow_state === 'FUNDED'
    && ['PROOF_SUBMITTED', 'COMPLETED'].includes(row.task_state)
  ) return 'PENDING_CLEARANCE';
  return 'NOT_AVAILABLE';
}

function iso(value: string | Date): string;
function iso(value: string | Date | null): string | null;
function iso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export async function listServiceBusinessAssignments(
  actorId: string,
  organizationId: string,
): Promise<ServiceResult<ServiceBusinessAssignment[]>> {
  try {
    const result = await db.query<ServiceBusinessAssignmentRow>(
      `WITH authority AS (
         SELECT business_require_action($1,$2,'READ_WORKSPACE')
       )
       SELECT task.id AS task_id,task.title,task.category,task.rough_location,
              task.state AS task_state,task.progress_state,
              COALESCE(NULLIF(BTRIM(fulfiller.full_name),''),'Verified crew member') AS fulfiller_name,
              task.hustler_payout_cents AS payout_cents,
              escrow.state AS escrow_state,escrow.stripe_transfer_id,
              escrow.provider_transfer_status,task.accepted_at,task.completed_at
         FROM business_service_task_assignments assignment
         JOIN tasks task ON task.id=assignment.task_id
         JOIN users fulfiller ON fulfiller.id=assignment.fulfiller_user_id
         JOIN escrows escrow ON escrow.task_id=task.id
         CROSS JOIN authority
        WHERE assignment.provider_organization_id=$1
        ORDER BY assignment.created_at DESC
        LIMIT 200`,
      [organizationId,actorId],
    );
    return {
      success: true,
      data: result.rows.map((row) => ({
        taskId: row.task_id,
        title: row.title,
        category: row.category,
        roughLocation: row.rough_location,
        taskState: row.task_state,
        progressState: row.progress_state,
        fulfillerName: row.fulfiller_name,
        grossPayoutCents: Number(row.payout_cents),
        payoutState: assignmentPayoutState(row),
        payoutDestination: { kind: 'ORGANIZATION_ACCOUNT' as const },
        acceptedAt: iso(row.accepted_at),
        completedAt: iso(row.completed_at),
      })),
    };
  } catch (error) {
    return failure(error);
  }
}
