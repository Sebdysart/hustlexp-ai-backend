/**
 * Task Reminder Worker
 *
 * Runs hourly. Sends periodic nudge notifications to posters and hustlers
 * when tasks need attention. Five reminder types:
 *
 *  stale_open            OPEN task with no taker after 24h → poster, every 24h, max 7×
 *  pending_proof         ACCEPTED task, no proof after 6h  → hustler, every 12h, max 4×
 *  proof_awaiting_review PROOF_SUBMITTED, no review after 2h → poster, every 4h, max 6×
 *  deadline_approaching  ACCEPTED, deadline within 2h       → hustler, once per 2h
 *  task_overdue          ACCEPTED, past deadline            → hustler (daily) + poster (once)
 *
 * Dedup: notification_log table keyed by (user_id, notification_type).
 * notification_type format: `task_reminder.{type}.{taskId}`
 */

import { db } from '../db.js';
import { NotificationService } from '../services/NotificationService.js';
import { workerLogger } from '../logger.js';
import type { Job } from 'bullmq';

const log = workerLogger.child({ worker: 'task-reminder' });

// ─── Cooldown config ─────────────────────────────────────────────────────────

const COOLDOWN_MS: Record<string, number> = {
  stale_open:            24 * 3600 * 1000,
  pending_proof:         12 * 3600 * 1000,
  proof_awaiting_review:  4 * 3600 * 1000,
  deadline_approaching:   2 * 3600 * 1000,
  task_overdue_hustler:  24 * 3600 * 1000,
  task_overdue_poster:    7 * 24 * 3600 * 1000,
};

const MAX_SENDS: Record<string, number> = {
  stale_open:            7,
  pending_proof:         4,
  proof_awaiting_review: 6,
  deadline_approaching:  1,
  task_overdue_hustler:  7,
  task_overdue_poster:   1,
};

function logKey(type: string, taskId: string): string {
  return `task_reminder.${type}.${taskId}`;
}

/** Returns true if this reminder should be skipped (too soon or max sends reached). */
async function shouldSkip(userId: string, type: string, taskId: string): Promise<boolean> {
  const key = logKey(type, taskId);
  const result = await db.query<{ last_sent: string | null; total: string }>(
    `SELECT MAX(sent_at) AS last_sent, COUNT(*) AS total
     FROM notification_log
     WHERE user_id = $1 AND notification_type = $2`,
    [userId, key]
  );
  const row = result.rows[0];
  const total = parseInt(row?.total ?? '0', 10);
  if (total >= (MAX_SENDS[type] ?? Infinity)) return true;
  if (!row?.last_sent) return false;
  return Date.now() - new Date(row.last_sent).getTime() < (COOLDOWN_MS[type] ?? 0);
}

async function logSent(userId: string, type: string, taskId: string): Promise<void> {
  await db.query(
    `INSERT INTO notification_log (user_id, notification_type, sent_at) VALUES ($1, $2, NOW())`,
    [userId, logKey(type, taskId)]
  );
}

// ─── Reminder passes ─────────────────────────────────────────────────────────

async function remindStaleOpen(): Promise<number> {
  const { rows } = await db.query<{
    id: string; title: string; poster_id: string; created_at: string;
  }>(
    `SELECT id, title, poster_id, created_at
     FROM tasks
     WHERE state = 'OPEN'
       AND created_at < NOW() - INTERVAL '24 hours'
     ORDER BY created_at ASC
     LIMIT 200`
  );

  let sent = 0;
  for (const task of rows) {
    if (await shouldSkip(task.poster_id, 'stale_open', task.id)) continue;
    try {
      const daysOpen = Math.floor((Date.now() - new Date(task.created_at).getTime()) / 86400000);
      await NotificationService.createNotification({
        userId: task.poster_id,
        category: 'task_reminder',
        title: 'Your task still needs a hustler',
        body: `"${task.title}" has been open for ${daysOpen} day${daysOpen !== 1 ? 's' : ''}. Raising the payout or refining the description may help.`,
        deepLink: `hustlexp://task/${task.id}`,
        taskId: task.id,
        channels: ['push', 'in_app'],
        priority: 'LOW',
        metadata: { reminderType: 'stale_open', daysOpen },
      });
      await logSent(task.poster_id, 'stale_open', task.id);
      sent++;
      log.info({ taskId: task.id, daysOpen }, 'stale_open reminder sent');
    } catch (err) {
      log.error({ taskId: task.id, err }, 'stale_open reminder failed');
    }
  }
  return sent;
}

async function remindPendingProof(): Promise<number> {
  const { rows } = await db.query<{
    id: string; title: string; worker_id: string; accepted_at: string;
  }>(
    `SELECT id, title, worker_id, accepted_at
     FROM tasks
     WHERE state = 'ACCEPTED'
       AND worker_id IS NOT NULL
       AND accepted_at < NOW() - INTERVAL '6 hours'
       AND (deadline IS NULL OR deadline > NOW())
     ORDER BY accepted_at ASC
     LIMIT 200`
  );

  let sent = 0;
  for (const task of rows) {
    if (await shouldSkip(task.worker_id, 'pending_proof', task.id)) continue;
    try {
      await NotificationService.createNotification({
        userId: task.worker_id,
        category: 'task_reminder',
        title: 'Have you finished the task?',
        body: `Submit your proof for "${task.title}" when you're done to get paid.`,
        deepLink: `hustlexp://task/${task.id}`,
        taskId: task.id,
        channels: ['push', 'in_app'],
        priority: 'MEDIUM',
        metadata: { reminderType: 'pending_proof' },
      });
      await logSent(task.worker_id, 'pending_proof', task.id);
      sent++;
      log.info({ taskId: task.id }, 'pending_proof reminder sent');
    } catch (err) {
      log.error({ taskId: task.id, err }, 'pending_proof reminder failed');
    }
  }
  return sent;
}

async function remindProofAwaitingReview(): Promise<number> {
  const { rows } = await db.query<{
    id: string; title: string; poster_id: string; proof_submitted_at: string;
  }>(
    `SELECT id, title, poster_id, proof_submitted_at
     FROM tasks
     WHERE state = 'PROOF_SUBMITTED'
       AND proof_submitted_at < NOW() - INTERVAL '2 hours'
     ORDER BY proof_submitted_at ASC
     LIMIT 200`
  );

  let sent = 0;
  for (const task of rows) {
    if (await shouldSkip(task.poster_id, 'proof_awaiting_review', task.id)) continue;
    try {
      await NotificationService.createNotification({
        userId: task.poster_id,
        category: 'task_reminder',
        title: 'Proof is waiting for your review',
        body: `A hustler submitted proof for "${task.title}". Approve it to release payment.`,
        deepLink: `hustlexp://task/${task.id}`,
        taskId: task.id,
        channels: ['push', 'in_app'],
        priority: 'MEDIUM',
        metadata: { reminderType: 'proof_awaiting_review' },
      });
      await logSent(task.poster_id, 'proof_awaiting_review', task.id);
      sent++;
      log.info({ taskId: task.id }, 'proof_awaiting_review reminder sent');
    } catch (err) {
      log.error({ taskId: task.id, err }, 'proof_awaiting_review reminder failed');
    }
  }
  return sent;
}

async function remindDeadlineApproaching(): Promise<number> {
  const { rows } = await db.query<{
    id: string; title: string; worker_id: string; deadline: string;
  }>(
    `SELECT id, title, worker_id, deadline
     FROM tasks
     WHERE state = 'ACCEPTED'
       AND worker_id IS NOT NULL
       AND deadline IS NOT NULL
       AND deadline BETWEEN NOW() AND NOW() + INTERVAL '2 hours'
     ORDER BY deadline ASC
     LIMIT 200`
  );

  let sent = 0;
  for (const task of rows) {
    if (await shouldSkip(task.worker_id, 'deadline_approaching', task.id)) continue;
    try {
      const minutesLeft = Math.max(0, Math.round((new Date(task.deadline).getTime() - Date.now()) / 60000));
      await NotificationService.createNotification({
        userId: task.worker_id,
        category: 'task_reminder',
        title: 'Task deadline approaching',
        body: `"${task.title}" is due in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}. Submit your proof soon.`,
        deepLink: `hustlexp://task/${task.id}`,
        taskId: task.id,
        channels: ['push', 'in_app'],
        priority: 'HIGH',
        metadata: { reminderType: 'deadline_approaching', minutesLeft },
      });
      await logSent(task.worker_id, 'deadline_approaching', task.id);
      sent++;
      log.info({ taskId: task.id, minutesLeft }, 'deadline_approaching reminder sent');
    } catch (err) {
      log.error({ taskId: task.id, err }, 'deadline_approaching reminder failed');
    }
  }
  return sent;
}

async function remindTaskOverdue(): Promise<number> {
  const { rows } = await db.query<{
    id: string; title: string; worker_id: string; poster_id: string; deadline: string;
  }>(
    `SELECT id, title, worker_id, poster_id, deadline
     FROM tasks
     WHERE state = 'ACCEPTED'
       AND worker_id IS NOT NULL
       AND deadline IS NOT NULL
       AND deadline < NOW()
     ORDER BY deadline ASC
     LIMIT 200`
  );

  let sent = 0;
  for (const task of rows) {
    // Hustler: daily nudge until they submit proof or poster cancels
    if (!await shouldSkip(task.worker_id, 'task_overdue_hustler', task.id)) {
      try {
        await NotificationService.createNotification({
          userId: task.worker_id,
          category: 'task_reminder',
          title: 'Your task is past due',
          body: `"${task.title}" deadline has passed. Submit your proof now to get paid.`,
          deepLink: `hustlexp://task/${task.id}`,
          taskId: task.id,
          channels: ['push', 'in_app'],
          priority: 'HIGH',
          metadata: { reminderType: 'task_overdue_hustler' },
        });
        await logSent(task.worker_id, 'task_overdue_hustler', task.id);
        sent++;
        log.info({ taskId: task.id }, 'task_overdue_hustler reminder sent');
      } catch (err) {
        log.error({ taskId: task.id, userId: task.worker_id, err }, 'task_overdue_hustler reminder failed');
      }
    }

    // Poster: once only — let them decide to cancel or wait
    if (!await shouldSkip(task.poster_id, 'task_overdue_poster', task.id)) {
      try {
        await NotificationService.createNotification({
          userId: task.poster_id,
          category: 'task_reminder',
          title: 'Task deadline passed',
          body: `The deadline for "${task.title}" has passed and the hustler hasn't submitted proof yet. You can cancel the task if needed.`,
          deepLink: `hustlexp://task/${task.id}`,
          taskId: task.id,
          channels: ['push', 'in_app'],
          priority: 'MEDIUM',
          metadata: { reminderType: 'task_overdue_poster' },
        });
        await logSent(task.poster_id, 'task_overdue_poster', task.id);
        sent++;
        log.info({ taskId: task.id }, 'task_overdue_poster reminder sent');
      } catch (err) {
        log.error({ taskId: task.id, userId: task.poster_id, err }, 'task_overdue_poster reminder failed');
      }
    }
  }
  return sent;
}

// ─── Main job ─────────────────────────────────────────────────────────────────

export async function processTaskReminderJob(_job: Job): Promise<void> {
  log.info('Task reminder run started');
  try {
    const [staleOpen, pendingProof, proofReview, deadlineApproaching, overdue] = await Promise.all([
      remindStaleOpen(),
      remindPendingProof(),
      remindProofAwaitingReview(),
      remindDeadlineApproaching(),
      remindTaskOverdue(),
    ]);
    log.info(
      { staleOpen, pendingProof, proofReview, deadlineApproaching, overdue },
      'Task reminder run complete'
    );
  } catch (err) {
    log.error({ err }, 'Task reminder job failed');
    throw err;
  }
}
