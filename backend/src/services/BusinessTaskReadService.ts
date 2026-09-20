import { db } from '../db.js';
import type { TaskState } from '../types.js';
import { businessTaskOwnershipSql } from './BusinessTaskOwnership.js';
import { assignmentPayoutState } from './ServiceBusinessAssignmentReadService.js';

export const BUSINESS_TASK_STATES = [
  'OPEN', 'MATCHING', 'ACCEPTED', 'PROOF_SUBMITTED',
  'DISPUTED', 'COMPLETED', 'CANCELLED', 'EXPIRED',
] as const satisfies readonly TaskState[];

// By default a business list is operational/history work, not an opportunity feed.
export const DEFAULT_BUSINESS_TASK_STATES: readonly TaskState[] = [
  'ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED', 'COMPLETED', 'CANCELLED', 'EXPIRED',
];

export interface BusinessTaskSummary {
  taskId: string;
  title: string;
  category: string | null;
  taskState: TaskState;
  progressState: string | null;
  roughLocation: string | null;
  scheduledServiceDate: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  grossPayoutCents: number | null;
  payoutState: ReturnType<typeof assignmentPayoutState> | null;
  fulfillerName: string | null;
  acquisitionOrigin: string | null;
}

interface TaskRow {
  task_id: string;
  title: string;
  category: string | null;
  task_state: TaskState;
  progress_state: string | null;
  rough_location: string | null;
  scheduled_service_date: Date | string | null;
  accepted_at: Date | string | null;
  completed_at: Date | string | null;
  gross_payout_cents: number | string | null;
  escrow_state: string | null;
  stripe_transfer_id: string | null;
  provider_transfer_status: string | null;
  fulfiller_name: string | null;
  acquisition_origin: string | null;
  sort_at: Date | string;
}

interface Cursor { v: 1; organizationId: string; states: TaskState[]; at: string; id: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeBusinessTaskCursor(value: string, organizationId: string, states: readonly TaskState[]): Cursor {
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (cursor.v !== 1 || cursor.organizationId !== organizationId
      || !Array.isArray(cursor.states) || cursor.states.join(',') !== states.join(',')
      || typeof cursor.at !== 'string' || !Number.isFinite(Date.parse(cursor.at))
      || typeof cursor.id !== 'string' || !uuid.test(cursor.id)
      || Buffer.from(JSON.stringify(cursor)).toString('base64url') !== value) {
      throw new Error('Invalid cursor');
    }
    return cursor;
  } catch {
    throw new Error('Invalid business task cursor.');
  }
}

const iso = (date: Date | string | null): string | null => date === null ? null : new Date(date).toISOString();

export async function listBusinessTasks(input: {
  actorId: string;
  organizationId: string;
  states: readonly TaskState[];
  limit: number;
  cursor: Cursor | null;
}): Promise<{ tasks: BusinessTaskSummary[]; nextCursor: string | null }> {
  const authority = await db.query<{ id: string }>(
    `SELECT organization.id FROM business_organizations organization
      WHERE organization.id=$1 AND organization.status='ACTIVE'
        AND business_membership_has_action(organization.id,$2,'READ_WORKSPACE')`,
    [input.organizationId, input.actorId],
  );
  if (!authority.rows[0]) throw new Error('BUSINESS_TASK_ACCESS_DENIED');

  // Candidate IDs use the direct fulfiller index and the assignment organization
  // index. The outer task query remains the source of lifecycle and read fields.
  const result = await db.query<TaskRow>(
    `WITH candidate_ids AS (
       SELECT id FROM tasks WHERE business_fulfiller_organization_id=$1
       UNION
       SELECT task_id FROM business_service_task_assignments
        WHERE provider_organization_id=$1
     ), page AS (
       SELECT task.id,COALESCE(task.completed_at,task.updated_at,task.accepted_at,task.created_at) AS sort_at
         FROM tasks task
         JOIN candidate_ids candidate ON candidate.id=task.id
        WHERE ${businessTaskOwnershipSql('task', '$1')}
          AND task.accepted_at IS NOT NULL
          AND task.state=ANY($2::text[])
          AND ($3::timestamptz IS NULL OR
            (COALESCE(task.completed_at,task.updated_at,task.accepted_at,task.created_at),task.id)
              < ($3::timestamptz,$4::uuid))
        ORDER BY sort_at DESC,task.id DESC
        LIMIT $5
     )
     SELECT task.id AS task_id,task.title,task.category,task.state AS task_state,
            task.progress_state,task.rough_location,task.scheduled_service_date,
            task.accepted_at,task.completed_at,
            CASE WHEN task.provider_assignment_id IS NOT NULL THEN task.hustler_payout_cents
                 ELSE COALESCE(version.hustler_payout_cents,task.hustler_payout_cents)
            END AS gross_payout_cents,
            escrow.state AS escrow_state,escrow.stripe_transfer_id,escrow.provider_transfer_status,
            NULLIF(BTRIM(fulfiller.full_name),'') AS fulfiller_name,
            CASE WHEN task.provider_assignment_id IS NOT NULL THEN 'service_assignment'
                 ELSE quote.acquisition_origin END AS acquisition_origin,
            page.sort_at
       FROM page
       JOIN tasks task ON task.id=page.id
       LEFT JOIN business_service_task_assignments assignment
         ON assignment.id=task.provider_assignment_id AND assignment.task_id=task.id
       LEFT JOIN users fulfiller ON fulfiller.id=assignment.fulfiller_user_id
       LEFT JOIN LATERAL (
         SELECT draft.quote_id FROM task_drafts draft WHERE draft.task_id=task.id
         ORDER BY draft.created_at DESC,draft.id DESC LIMIT 1
       ) draft ON TRUE
       LEFT JOIN quotes quote ON quote.id=draft.quote_id
         AND quote.business_organization_id=$1
       LEFT JOIN quote_versions version ON version.id=quote.active_version_id
       LEFT JOIN escrows escrow ON escrow.task_id=task.id
      ORDER BY page.sort_at DESC,task.id DESC`,
    [input.organizationId, input.states, input.cursor?.at ?? null, input.cursor?.id ?? null, input.limit + 1],
  );
  const page = result.rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    tasks: page.map((row) => ({
      taskId: row.task_id,
      title: row.title,
      category: row.category,
      taskState: row.task_state,
      progressState: row.progress_state,
      roughLocation: row.rough_location,
      scheduledServiceDate: iso(row.scheduled_service_date)?.slice(0, 10) ?? null,
      acceptedAt: iso(row.accepted_at),
      completedAt: iso(row.completed_at),
      grossPayoutCents: row.gross_payout_cents === null ? null : Number(row.gross_payout_cents),
      payoutState: row.escrow_state === null ? null : assignmentPayoutState(row),
      fulfillerName: row.fulfiller_name,
      acquisitionOrigin: row.acquisition_origin,
    })),
    nextCursor: result.rows.length > input.limit && last
      ? Buffer.from(JSON.stringify({ v: 1, organizationId: input.organizationId,
        states: input.states, at: iso(last.sort_at), id: last.task_id })).toString('base64url')
      : null,
  };
}
