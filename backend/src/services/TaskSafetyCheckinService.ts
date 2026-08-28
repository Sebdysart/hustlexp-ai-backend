import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { db } from '../db.js';

export type SafetyCheckinDuration = 15 | 30 | 60;
export type SafetyCheckinStatus = 'active' | 'confirmed' | 'escalated';

export interface SafetyCheckinRecord {
  id: string;
  task_id: string;
  participant_user_id: string;
  duration_minutes: SafetyCheckinDuration;
  status: SafetyCheckinStatus;
  started_at: Date;
  due_at: Date;
  confirmed_at: Date | null;
  escalated_at: Date | null;
  escalation_incident_id: string | null;
}

type Query = typeof db.query;

function hash(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function notFound(): never {
  throw new TRPCError({ code: 'NOT_FOUND', message: 'Task safety check-in not found' });
}

async function requireTaskParticipant(
  query: Query,
  taskId: string,
  userId: string,
  requireActive: boolean,
): Promise<void> {
  const result = await query<{ poster_id: string; worker_id: string | null; state: string }>(
    'SELECT poster_id, worker_id, state FROM tasks WHERE id = $1 FOR SHARE',
    [taskId],
  );
  const task = result.rows[0];
  if (!task || (task.poster_id !== userId && task.worker_id !== userId)) notFound();
  if (requireActive && !['ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED'].includes(task.state)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Timed safety check-ins are available only while an assigned task is active.',
    });
  }
}

export const TaskSafetyCheckinService = {
  async start(input: {
    taskId: string;
    participantUserId: string;
    durationMinutes: SafetyCheckinDuration;
    idempotencyKey: string;
  }): Promise<SafetyCheckinRecord & { idempotencyReplayed: boolean; activeAlreadyExisted: boolean }> {
    const requestHash = hash({
      taskId: input.taskId,
      participantUserId: input.participantUserId,
      durationMinutes: input.durationMinutes,
    });
    return db.transaction(async (query) => {
      await requireTaskParticipant(query as Query, input.taskId, input.participantUserId, true);
      const replay = await query<SafetyCheckinRecord & { request_hash: string }>(
        `SELECT id, task_id, participant_user_id, duration_minutes, status, started_at, due_at,
                confirmed_at, escalated_at, escalation_incident_id, request_hash
           FROM task_safety_checkins
          WHERE participant_user_id = $1 AND idempotency_key = $2
          FOR UPDATE`,
        [input.participantUserId, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Safety check-in key was already used with a different duration or task.',
          });
        }
        const { request_hash: _requestHash, ...record } = replay.rows[0];
        return { ...record, idempotencyReplayed: true, activeAlreadyExisted: false };
      }

      const active = await query<SafetyCheckinRecord>(
        `SELECT id, task_id, participant_user_id, duration_minutes, status, started_at, due_at,
                confirmed_at, escalated_at, escalation_incident_id
           FROM task_safety_checkins
          WHERE task_id = $1 AND participant_user_id = $2 AND status = 'active'
          FOR UPDATE`,
        [input.taskId, input.participantUserId],
      );
      if (active.rows[0]) {
        return { ...active.rows[0], idempotencyReplayed: false, activeAlreadyExisted: true };
      }

      const inserted = await query<SafetyCheckinRecord>(
        `INSERT INTO task_safety_checkins (
           task_id, participant_user_id, duration_minutes, idempotency_key, request_hash,
           started_at, due_at
         ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW() + make_interval(mins => $3))
         RETURNING id, task_id, participant_user_id, duration_minutes, status, started_at, due_at,
                   confirmed_at, escalated_at, escalation_incident_id`,
        [input.taskId, input.participantUserId, input.durationMinutes, input.idempotencyKey, requestHash],
      );
      const checkin = inserted.rows[0];
      if (!checkin) throw new Error('Timed safety check-in could not be recorded');
      await query(
        `INSERT INTO task_safety_checkin_events (
           checkin_id, event_type, actor_user_id, public_message, metadata
         ) VALUES ($1, 'started', $2, $3, $4::jsonb)`,
        [
          checkin.id,
          input.participantUserId,
          'Timed safety check-in started. Confirm before the deadline to prevent automatic escalation.',
          JSON.stringify({ duration_minutes: input.durationMinutes }),
        ],
      );
      return { ...checkin, idempotencyReplayed: false, activeAlreadyExisted: false };
    });
  },

  async list(taskId: string, participantUserId: string): Promise<SafetyCheckinRecord[]> {
    await requireTaskParticipant(db.query, taskId, participantUserId, false);
    const result = await db.query<SafetyCheckinRecord>(
      `SELECT id, task_id, participant_user_id, duration_minutes, status, started_at, due_at,
              confirmed_at, escalated_at, escalation_incident_id
         FROM task_safety_checkins
        WHERE task_id = $1 AND participant_user_id = $2
        ORDER BY created_at DESC
        LIMIT 20`,
      [taskId, participantUserId],
    );
    return result.rows;
  },

  async confirm(checkinId: string, participantUserId: string): Promise<SafetyCheckinRecord> {
    return db.transaction(async (query) => {
      const updated = await query<SafetyCheckinRecord>(
        `UPDATE task_safety_checkins
            SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND participant_user_id = $2 AND status = 'active' AND due_at > clock_timestamp()
          RETURNING id, task_id, participant_user_id, duration_minutes, status, started_at, due_at,
                    confirmed_at, escalated_at, escalation_incident_id`,
        [checkinId, participantUserId],
      );
      const checkin = updated.rows[0];
      if (!checkin) {
        const existing = await query<{ status: SafetyCheckinStatus; due_at: Date }>(
          `SELECT status, due_at FROM task_safety_checkins
            WHERE id = $1 AND participant_user_id = $2`,
          [checkinId, participantUserId],
        );
        if (!existing.rows[0]) notFound();
        if (existing.rows[0].status === 'confirmed') {
          const replay = await query<SafetyCheckinRecord>(
            `SELECT id, task_id, participant_user_id, duration_minutes, status, started_at, due_at,
                    confirmed_at, escalated_at, escalation_incident_id
               FROM task_safety_checkins WHERE id = $1`,
            [checkinId],
          );
          return replay.rows[0];
        }
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'The check-in deadline has passed or escalation has already started.',
        });
      }
      await query(
        `INSERT INTO task_safety_checkin_events (
           checkin_id, event_type, actor_user_id, public_message
         ) VALUES ($1, 'confirmed', $2, $3)`,
        [checkinId, participantUserId, 'Safety check-in confirmed before the deadline.'],
      );
      return checkin;
    });
  },

  async escalateDue(limit = 100): Promise<{ escalated: number; checkinIds: string[] }> {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    const checkinIds: string[] = [];
    for (let index = 0; index < boundedLimit; index += 1) {
      const escalated = await db.transaction(async (query) => {
        const due = await query<SafetyCheckinRecord>(
          `SELECT id, task_id, participant_user_id, duration_minutes, status, started_at, due_at,
                  confirmed_at, escalated_at, escalation_incident_id
             FROM task_safety_checkins
            WHERE status = 'active' AND due_at <= clock_timestamp()
            ORDER BY due_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1`,
        );
        const checkin = due.rows[0];
        if (!checkin) return null;
        const description = 'A timed task safety check-in was not confirmed before its deadline.';
        const incidentHash = hash({
          source: 'timed_safety_checkin',
          checkinId: checkin.id,
          taskId: checkin.task_id,
          reporterUserId: checkin.participant_user_id,
          category: 'vulnerable_person_safety',
          urgency: 'urgent',
          description,
          locationSharingEnabled: false,
          contactPermission: 'in_app_only',
        });
        const incident = await query<{ id: string }>(
          `INSERT INTO task_safety_incidents (
             task_id, reporter_user_id, category, urgency, description,
             location_sharing_enabled, contact_permission, idempotency_key, request_hash,
             source_checkin_id
           ) VALUES ($1, $2, 'vulnerable_person_safety', 'urgent', $3, FALSE, 'in_app_only', gen_random_uuid(), $4, $5)
           RETURNING id`,
          [checkin.task_id, checkin.participant_user_id, description, incidentHash, checkin.id],
        );
        const incidentId = incident.rows[0]?.id;
        if (!incidentId) throw new Error('Overdue safety incident could not be recorded');
        await query(
          `INSERT INTO task_safety_incident_events (
             incident_id, event_type, actor_user_id, public_message, metadata
           ) VALUES ($1, 'received', NULL, $2, $3::jsonb)`,
          [
            incidentId,
            'HustleXP received the missed check-in escalation. Human acknowledgment is still pending.',
            JSON.stringify({ source: 'timed_safety_checkin', checkin_id: checkin.id }),
          ],
        );
        await query(
          `INSERT INTO incident_events (event_type, severity, service, details)
           VALUES ('manual_report', 'critical', 'trust_safety', $1::jsonb)`,
          [JSON.stringify({
            safety_incident_id: incidentId,
            task_id: checkin.task_id,
            category: 'vulnerable_person_safety',
            urgency: 'urgent',
            reporter_user_id: checkin.participant_user_id,
            source: 'timed_safety_checkin',
            checkin_id: checkin.id,
            contact_permission: 'in_app_only',
            location_sharing_enabled: false,
          })],
        );
        await query(
          `UPDATE task_safety_checkins
              SET status = 'escalated', escalated_at = NOW(), escalation_incident_id = $2, updated_at = NOW()
            WHERE id = $1 AND status = 'active'`,
          [checkin.id, incidentId],
        );
        await query(
          `INSERT INTO task_safety_checkin_events (
             checkin_id, event_type, actor_user_id, public_message, metadata
           ) VALUES ($1, 'escalated', NULL, $2, $3::jsonb)`,
          [
            checkin.id,
            'The deadline passed without confirmation. An urgent Operations safety case was created; human acknowledgment is pending.',
            JSON.stringify({ incident_id: incidentId }),
          ],
        );
        return checkin.id;
      });
      if (!escalated) break;
      checkinIds.push(escalated);
    }
    return { escalated: checkinIds.length, checkinIds };
  },
};
