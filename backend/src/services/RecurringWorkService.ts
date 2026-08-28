import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { generateControlledRecurringOccurrence } from './RecurringOccurrenceService.js';
import { createRecurringTemplateAuthorized } from './RecurringTemplateCreationService.js';
import { recurringInvalid } from './RecurringWorkErrors.js';
import type {
  ControlledRecurringTemplateInput,
  ControlledRecurringTemplateSummary,
  RecurringPattern,
} from './RecurringWorkTypes.js';

export { generateControlledRecurringOccurrence } from './RecurringOccurrenceService.js';
export type {
  ControlledRecurringTemplateInput,
  ControlledRecurringTemplateSummary,
  GenerateControlledOccurrenceInput,
  RecurringPattern,
} from './RecurringWorkTypes.js';

const log = logger.child({ service: 'RecurringWorkService' });

export async function listControlledRecurringTemplates(
  posterId: string,
): Promise<ServiceResult<ControlledRecurringTemplateSummary[]>> {
  try {
    const result = await db.query<{
      id: string; title: string; category: string; rough_location: string;
      status: ControlledRecurringTemplateSummary['status']; pause_code: string | null;
      current_revision_id: string; next_occurrence_at: string; pattern: RecurringPattern;
      service_window_start: string; service_window_end: string; timezone: string;
      budget_cap_cents: number; budget_spend_cents: number; preferred_worker_id: string | null;
      backup_provider_count: number; occurrence_count: number; completed_count: number;
      automation_mode: string;
    }>(
      `SELECT id,title,category,rough_location,status,pause_code,current_revision_id,
              next_occurrence_at,pattern,service_window_start,service_window_end,timezone,
              budget_cap_cents,budget_spend_cents,preferred_worker_id,
              cardinality(backup_worker_ids) AS backup_provider_count,
              occurrence_count,completed_count,automation_mode
       FROM recurring_task_series
       WHERE poster_id=$1 AND contract_version >= 2
       ORDER BY created_at DESC`,
      [posterId],
    );
    return {
      success: true,
      data: result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        category: row.category,
        roughLocation: row.rough_location,
        status: row.status,
        pauseCode: row.pause_code,
        currentRevisionId: row.current_revision_id,
        nextOccurrenceAt: row.next_occurrence_at,
        pattern: row.pattern,
        serviceWindowStart: row.service_window_start,
        serviceWindowEnd: row.service_window_end,
        timezone: row.timezone,
        budgetCapCents: row.budget_cap_cents,
        budgetSpendCents: row.budget_spend_cents,
        preferredWorkerId: row.preferred_worker_id,
        backupProviderCount: Number(row.backup_provider_count),
        occurrenceCount: row.occurrence_count,
        completedCount: row.completed_count,
        automationMode: row.automation_mode,
      })),
    };
  } catch {
    return recurringInvalid('Recurring templates could not be loaded.', 'RECURRING_LIST_FAILED');
  }
}

export async function createControlledRecurringTemplate(
  input: ControlledRecurringTemplateInput,
): Promise<ServiceResult<{ id: string; status: 'active'; revisionId: string }>> {
  return createRecurringTemplateAuthorized(input, false);
}

/**
 * Internal Business-workspace boundary. Callers must first derive private
 * location, economics, role authority, and provider preference from the DB.
 * The database trigger independently rechecks organization membership/scope.
 */
export async function createAuthorizedOrganizationRecurringTemplate(
  input: ControlledRecurringTemplateInput,
): Promise<ServiceResult<{ id: string; status: 'active'; revisionId: string }>> {
  return createRecurringTemplateAuthorized(input, true);
}

export async function recordControlledRecurringSafeguard(input: {
  seriesId: string;
  signal: string;
  evidence: Record<string, unknown>;
  actorId: string;
}): Promise<ServiceResult<{ pauseCode: string | null }>> {
  try {
    const result = await db.query<{ reason: string | null }>(
      `SELECT record_recurring_safeguard_signal($1,$2,$3::jsonb,$4) AS reason`,
      [input.seriesId, input.signal, JSON.stringify(input.evidence), input.actorId],
    );
    return { success: true, data: { pauseCode: result.rows[0]?.reason ?? null } };
  } catch {
    return recurringInvalid(
      'Recurring safeguard signal was not recorded.',
      'RECURRING_SIGNAL_FAILED',
    );
  }
}

export async function recoverControlledRecurringTemplate(input: {
  seriesId: string;
  actorId: string;
  reason: string;
  evidence: Record<string, unknown>;
}): Promise<ServiceResult<{ recoveryRevision: number }>> {
  try {
    const result = await db.query<{ recovery_revision: number }>(
      `SELECT recover_recurring_template($1,$2,$3,$4::jsonb) AS recovery_revision`,
      [input.seriesId, input.actorId, input.reason, JSON.stringify(input.evidence)],
    );
    return { success: true, data: { recoveryRevision: result.rows[0].recovery_revision } };
  } catch {
    return recurringInvalid(
      'Recurring template recovery was rejected.',
      'RECURRING_RECOVERY_REJECTED',
    );
  }
}

export async function generateDueControlledRecurringOccurrences(
  limit = 100,
): Promise<{ scanned: number; generated: number; replayed: number; paused: number; failed: number }> {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const due = await db.query<{ id: string }>(
    `SELECT id FROM recurring_task_series
     WHERE contract_version >= 2 AND status='active'
       AND next_occurrence_at <= NOW() + INTERVAL '24 hours'
     ORDER BY next_occurrence_at,id LIMIT $1`,
    [boundedLimit],
  );
  const summary = { scanned: due.rows.length, generated: 0, replayed: 0, paused: 0, failed: 0 };
  for (const row of due.rows) {
    const result = await generateControlledRecurringOccurrence({
      seriesId: row.id,
      actorId: null,
      lookaheadHours: 24,
    });
    if (!result.success) {
      summary.failed += 1;
      log.error({ seriesId: row.id, code: result.error.code }, 'due recurring generation failed');
      continue;
    }
    if (result.data.outcome === 'generated') summary.generated += 1;
    else if (result.data.outcome === 'replayed') summary.replayed += 1;
    else if (result.data.outcome === 'paused') summary.paused += 1;
  }
  return summary;
}

type ExpiredReservationRow = {
  reservation_id: string;
  occurrence_id: string;
  series_id: string;
  backup_worker_ids: string[];
};

type FundedReservationOfferRow = {
  reservation_id: string;
  occurrence_id: string;
  pool_type: 'PREFERRED' | 'BACKUP';
};

/**
 * Recurring provider timeboxes start only after the canonical escrow is
 * funded. Generating an occurrence is not permission to dispatch it.
 */
export async function activateFundedControlledReservationOffers(
  limit = 100,
): Promise<{ activated: number }> {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  let activated = 0;
  for (let index = 0; index < boundedLimit; index += 1) {
    const didActivate = await db.transaction(async (query) => {
      const ready = await query<FundedReservationOfferRow>(
        `SELECT r.id AS reservation_id,r.occurrence_id,r.pool_type
         FROM recurring_provider_reservations r
         JOIN recurring_task_occurrences occurrence ON occurrence.id=r.occurrence_id
         JOIN tasks task ON task.id=occurrence.task_id
         JOIN escrows escrow ON escrow.task_id=task.id
         WHERE r.status='AWAITING_PAYMENT' AND escrow.state='FUNDED'
           AND task.state IN ('OPEN','MATCHING') AND task.worker_id IS NULL
         ORDER BY occurrence.scheduled_start,r.wave_rank,r.id
         LIMIT 1 FOR UPDATE OF r,occurrence,task SKIP LOCKED`,
      );
      const row = ready.rows[0];
      if (!row) return false;
      await query(
        `UPDATE recurring_provider_reservations
         SET status='PENDING',offered_at=NOW(),expires_at=NOW()+INTERVAL '30 minutes'
         WHERE id=$1 AND status='AWAITING_PAYMENT'`,
        [row.reservation_id],
      );
      await query(
        `UPDATE recurring_task_occurrences
         SET reservation_state=$2,updated_at=NOW() WHERE id=$1`,
        [row.occurrence_id, `${row.pool_type}_PENDING`],
      );
      return true;
    });
    if (!didActivate) break;
    activated += 1;
  }
  return { activated };
}

export async function advanceControlledReservationWaves(
  limit = 100,
): Promise<{ processed: number; backupsOpened: number; exhausted: number }> {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const summary = { processed: 0, backupsOpened: 0, exhausted: 0 };
  for (let index = 0; index < boundedLimit; index += 1) {
    const outcome = await db.transaction(async (query) => {
      const expired = await query<ExpiredReservationRow>(
        `SELECT r.id AS reservation_id,r.occurrence_id,o.series_id,s.backup_worker_ids
         FROM recurring_provider_reservations r
         JOIN recurring_task_occurrences o ON o.id=r.occurrence_id
         JOIN recurring_task_series s ON s.id=o.series_id
         JOIN tasks task ON task.id=o.task_id
         JOIN escrows escrow ON escrow.task_id=task.id
         WHERE r.status='PENDING' AND r.expires_at <= NOW()
           AND escrow.state='FUNDED'
         ORDER BY r.expires_at,r.id
         LIMIT 1 FOR UPDATE OF r,o,s SKIP LOCKED`,
      );
      const row = expired.rows[0];
      if (!row) return null;
      await query(
        `UPDATE recurring_provider_reservations
         SET status='TIMED_OUT',responded_at=NOW() WHERE id=$1 AND status='PENDING'`,
        [row.reservation_id],
      );
      const next = await query<{ worker_id: string; wave_rank: number }>(
        `SELECT candidate.worker_id,candidate.wave_rank
         FROM unnest($2::uuid[]) WITH ORDINALITY AS candidate(worker_id,wave_rank)
         WHERE NOT EXISTS (
           SELECT 1 FROM recurring_provider_reservations prior
           WHERE prior.occurrence_id=$1 AND prior.worker_id=candidate.worker_id
         )
         ORDER BY candidate.wave_rank LIMIT 1`,
        [row.occurrence_id, row.backup_worker_ids ?? []],
      );
      const backup = next.rows[0];
      if (backup) {
        await query(
          `INSERT INTO recurring_provider_reservations (
             occurrence_id,worker_id,pool_type,wave_rank,status,expires_at
           ) VALUES ($1,$2,'BACKUP',$3,'PENDING',NOW()+INTERVAL '30 minutes')
           ON CONFLICT (occurrence_id,worker_id) DO NOTHING`,
          [row.occurrence_id, backup.worker_id, backup.wave_rank],
        );
        await query(
          `UPDATE recurring_task_occurrences SET reservation_state='BACKUP_PENDING',updated_at=NOW()
           WHERE id=$1`,
          [row.occurrence_id],
        );
        return 'backup' as const;
      }
      await query(
        `UPDATE recurring_task_occurrences SET reservation_state='EXHAUSTED',updated_at=NOW()
         WHERE id=$1`,
        [row.occurrence_id],
      );
      await query(
        `SELECT record_recurring_safeguard_signal(
           $1,'FULFILLMENT_FAILURE',$2::jsonb,NULL
         ) AS reason`,
        [row.series_id, JSON.stringify({
          occurrenceId: row.occurrence_id,
          source: 'reservation_pool_exhausted',
        })],
      );
      return 'exhausted' as const;
    });
    if (!outcome) break;
    summary.processed += 1;
    if (outcome === 'backup') summary.backupsOpened += 1;
    else summary.exhausted += 1;
  }
  return summary;
}
