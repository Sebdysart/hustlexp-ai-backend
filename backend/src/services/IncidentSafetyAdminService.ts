import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../db.js';
import { payloadHash } from '../routers/incidentSafetyPolicy.js';

export interface SafetyContactInput {
  incidentId: string;
  providerEventId: string;
  eventType: 'contact_attempted' | 'contact_delivered' | 'contact_failed';
  channel: 'call' | 'text';
  publicMessage: string;
  occurredAt: string;
}

export const safetyResolutionCodes = [
  'safety_plan_confirmed',
  'emergency_services_referred',
  'fraud_or_payment_referred',
  'legal_or_licensing_referred',
  'compensation_referred',
  'unable_to_confirm',
] as const;

export type SafetyResolutionCode = typeof safetyResolutionCodes[number];

export interface SafetyResolutionInput {
  incidentId: string;
  idempotencyKey: string;
  resolutionCode: SafetyResolutionCode;
  publicMessage: string;
}

export interface SafetyCaseListInput {
  includeResolved: boolean;
  limit: number;
}

export async function listSafetyCases(input: SafetyCaseListInput, adminUserId: string) {
  const result = await db.query(
    `SELECT id, task_id, category, urgency, status, delivery_state,
            contact_permission, location_sharing_enabled, created_at,
            acknowledged_at, resolved_at,
            assigned_admin_id IS NOT NULL AS owner_assigned,
            assigned_admin_id = $2 AS owned_by_current_operator
       FROM task_safety_incidents
      WHERE ($1::boolean OR status NOT IN ('resolved', 'closed'))
      ORDER BY CASE urgency WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
               created_at ASC, id ASC
      LIMIT $3`,
    [input.includeResolved, adminUserId, input.limit],
  );
  return result.rows;
}

export function getSafetyCaseForAdmin(
  incidentId: string,
  purpose: string,
  adminUserId: string,
) {
  return db.transaction(async (query) => {
    const result = await query(
      `SELECT id, task_id, category, urgency, description, status, delivery_state,
              contact_permission, location_sharing_enabled, created_at,
              acknowledged_at, resolved_at,
              assigned_admin_id IS NOT NULL AS owner_assigned,
              assigned_admin_id = $2 AS owned_by_current_operator,
              location_ciphertext IS NOT NULL AND location_expired_at IS NULL
                AS location_evidence_available
         FROM task_safety_incidents
        WHERE id = $1`,
      [incidentId, adminUserId],
    );
    const incident = result.rows[0];
    if (!incident) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Safety incident not found' });
    }
    const timeline = await query(
      `SELECT event_type, public_message, created_at,
              metadata->>'resolution_code' AS resolution_code
         FROM task_safety_incident_events
        WHERE incident_id = $1
        ORDER BY created_at ASC, id ASC`,
      [incidentId],
    );
    await query(
      `INSERT INTO task_safety_case_access_log (
         incident_id, admin_user_id, purpose, access_scope
       ) VALUES ($1, $2, $3, 'CASE_DETAIL')`,
      [incidentId, adminUserId, purpose],
    );
    return { ...incident, timeline: timeline.rows };
  });
}

const allowedFrom: Record<SafetyContactInput['eventType'], string[]> = {
  contact_attempted: ['received', 'contact_failed'],
  contact_delivered: ['contact_attempted', 'contact_failed'],
  contact_failed: ['contact_attempted'],
};

export function acknowledgeSafety(
  incidentId: string,
  publicMessage: string,
  adminUserId: string,
) {
  return db.transaction(async (query) => {
    const result = await query<{
      id: string;
      task_id: string;
      reporter_user_id: string;
      status: string;
      delivery_state: string;
      acknowledged_at: Date | null;
      assigned_admin_id: string | null;
      changed: boolean;
    }>(
      `WITH changed AS (
         UPDATE task_safety_incidents
            SET status = 'acknowledged',
                acknowledged_at = NOW(), assigned_admin_id = $2, updated_at = NOW()
          WHERE id = $1 AND status = 'received'
          RETURNING *, TRUE AS changed
       )
       SELECT * FROM changed
       UNION ALL
       SELECT existing.*, FALSE AS changed
         FROM task_safety_incidents existing
        WHERE existing.id = $1 AND NOT EXISTS (SELECT 1 FROM changed)
       LIMIT 1`,
      [incidentId, adminUserId],
    );
    const incident = result.rows[0];
    if (!incident) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Safety incident not found' });
    }
    if (!incident.changed) {
      if (!['acknowledged', 'assigned'].includes(incident.status)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Safety case can no longer be acknowledged.',
        });
      }
      if (incident.assigned_admin_id !== adminUserId) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Safety case is already owned by another operator.',
        });
      }
    }
    if (incident.changed) {
      await query(
        `INSERT INTO task_safety_incident_events (
           incident_id, event_type, actor_user_id, public_message
         ) VALUES ($1, 'acknowledged', $2, $3)`,
        [incidentId, adminUserId, publicMessage],
      );
    }
    const { changed: _changed, ...publicIncident } = incident;
    return publicIncident;
  });
}

function resolutionRequestHash(input: SafetyResolutionInput): string {
  return payloadHash({
    incidentId: input.incidentId,
    idempotencyKey: input.idempotencyKey,
    resolutionCode: input.resolutionCode,
    publicMessage: input.publicMessage,
  });
}

export function resolveSafety(input: SafetyResolutionInput, adminUserId: string) {
  return db.transaction(async (query) => {
    const locked = await query<{
      id: string;
      status: string;
      assigned_admin_id: string | null;
      resolved_at: Date | null;
    }>(
      `SELECT id, status, assigned_admin_id, resolved_at
         FROM task_safety_incidents
        WHERE id = $1
        FOR UPDATE`,
      [input.incidentId],
    );
    const incident = locked.rows[0];
    if (!incident) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Safety incident not found' });
    }

    const requestHash = resolutionRequestHash(input);
    const prior = await query<{
      actor_user_id: string | null;
      request_hash: string | null;
    }>(
      `SELECT actor_user_id, metadata->>'request_hash' AS request_hash
         FROM task_safety_incident_events
        WHERE incident_id = $1
          AND event_type = 'resolved'
          AND metadata->>'idempotency_key' = $2
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [input.incidentId, input.idempotencyKey],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].actor_user_id !== adminUserId
          || prior.rows[0].request_hash !== requestHash) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Safety resolution key was reused with different resolution evidence.',
        });
      }
      return {
        incidentId: incident.id,
        status: incident.status,
        resolvedAt: incident.resolved_at,
        resolutionCode: input.resolutionCode,
        idempotencyReplayed: true,
      };
    }

    if (incident.status === 'received') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'A human operator must acknowledge and own the case before resolution.',
      });
    }
    if (['resolved', 'closed'].includes(incident.status)) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Safety case is already resolved.',
      });
    }
    if (incident.assigned_admin_id !== adminUserId) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only the assigned safety operator can resolve this case.',
      });
    }

    await query(
      `INSERT INTO task_safety_incident_events (
         incident_id, event_type, actor_user_id, public_message, metadata
       ) VALUES ($1, 'resolved', $2, $3, $4::jsonb)`,
      [input.incidentId, adminUserId, input.publicMessage, JSON.stringify({
        resolution_code: input.resolutionCode,
        idempotency_key: input.idempotencyKey,
        request_hash: requestHash,
      })],
    );
    const updated = await query<{
      id: string;
      status: string;
      resolved_at: Date;
    }>(
      `UPDATE task_safety_incidents
          SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
        WHERE id = $1
          AND status IN ('acknowledged', 'assigned')
          AND assigned_admin_id = $2
        RETURNING id, status, resolved_at`,
      [input.incidentId, adminUserId],
    );
    const resolved = updated.rows[0];
    if (!resolved) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Safety case changed before it could be resolved.',
      });
    }
    await query(
      `UPDATE incident_events
          SET resolved_at = COALESCE(resolved_at, NOW()),
              details = jsonb_set(
                details,
                '{canonical_resolution_code}',
                to_jsonb($2::text),
                TRUE
              )
        WHERE event_type = 'manual_report'
          AND service = 'trust_safety'
          AND details->>'safety_incident_id' = $1`,
      [input.incidentId, input.resolutionCode],
    );
    return {
      incidentId: resolved.id,
      status: resolved.status,
      resolvedAt: resolved.resolved_at,
      resolutionCode: input.resolutionCode,
      idempotencyReplayed: false,
    };
  });
}

async function lockedIncident(query: QueryFn, input: SafetyContactInput) {
  const result = await query<{
    id: string;
    contact_permission: string;
    delivery_state: string;
    status: string;
  }>(
    `SELECT id, contact_permission, delivery_state, status
     FROM task_safety_incidents WHERE id = $1 FOR UPDATE`,
    [input.incidentId],
  );
  const incident = result.rows[0];
  if (!incident) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Safety incident not found' });
  }
  if (['resolved', 'closed'].includes(incident.status)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Safety case is already closed',
    });
  }
  if (incident.contact_permission !== input.channel) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Contact channel is not permitted by the reporter.',
    });
  }
  return incident;
}

function contactRequestHash(input: SafetyContactInput): string {
  return payloadHash({
    incidentId: input.incidentId,
    eventType: input.eventType,
    channel: input.channel,
    publicMessage: input.publicMessage,
    occurredAt: input.occurredAt,
  });
}

async function priorContactEvent(query: QueryFn, input: SafetyContactInput, requestHash: string) {
  const prior = await query<{ incident_id: string; request_hash: string }>(
    `SELECT incident_id, request_hash
     FROM task_safety_incident_events
     WHERE provider_event_id = $1`,
    [input.providerEventId],
  );
  if (!prior.rows[0]) return false;
  if (prior.rows[0].incident_id !== input.incidentId || prior.rows[0].request_hash !== requestHash) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Provider event ID was reused with different contact evidence.',
    });
  }
  return true;
}

async function persistContactEvent(
  query: QueryFn,
  input: SafetyContactInput,
  adminUserId: string,
  requestHash: string,
): Promise<void> {
  await query(
    `INSERT INTO task_safety_incident_events (
       incident_id, event_type, actor_user_id, public_message, metadata,
       provider_event_id, contact_channel, request_hash, created_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
    [
      input.incidentId,
      input.eventType,
      adminUserId,
      input.publicMessage,
      JSON.stringify({ channel: input.channel }),
      input.providerEventId,
      input.channel,
      requestHash,
      input.occurredAt,
    ],
  );
  await query(
    `UPDATE task_safety_incidents
     SET delivery_state = $2,
         delivery_event_id = (
           SELECT id FROM task_safety_incident_events WHERE provider_event_id = $3
         ),
         updated_at = NOW()
     WHERE id = $1`,
    [input.incidentId, input.eventType, input.providerEventId],
  );
}

export function recordSafetyContact(input: SafetyContactInput, adminUserId: string) {
  return db.transaction(async (query) => {
    const incident = await lockedIncident(query, input);
    const requestHash = contactRequestHash(input);
    const replayed = await priorContactEvent(query, input, requestHash);
    if (replayed) {
      return {
        incidentId: input.incidentId,
        deliveryState: incident.delivery_state,
        idempotencyReplayed: true,
      };
    }
    if (!allowedFrom[input.eventType].includes(incident.delivery_state)) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Cannot record ${input.eventType} after ${incident.delivery_state}.`,
      });
    }
    await persistContactEvent(query, input, adminUserId, requestHash);
    return {
      incidentId: input.incidentId,
      deliveryState: input.eventType,
      idempotencyReplayed: false,
    };
  });
}
