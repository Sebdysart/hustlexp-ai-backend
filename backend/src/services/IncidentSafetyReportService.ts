import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../db.js';
import {
  assertLocationRecency,
  effectiveUrgency,
  payloadHash,
  requireTaskParticipant,
  type SafetyCategory,
  type SafetyReportInput,
  type SafetyUrgency,
} from '../routers/incidentSafetyPolicy.js';
import { TaskSafetyLocationService } from './TaskSafetyLocationService.js';

interface SafetyIncidentRow {
  id: string;
  task_id: string;
  reporter_user_id: string;
  category: SafetyCategory;
  urgency: SafetyUrgency;
  status: string;
  delivery_state: string;
  location_sharing_enabled: boolean;
  contact_permission: string;
  created_at: Date;
  request_hash: string | null;
  sync_contract_version: number;
  reconciliation_contract_version: number;
  location_ciphertext: string | null;
  location_nonce: string | null;
  location_auth_tag: string | null;
  location_key_id: string | null;
  source_checkin_id: string | null;
  location_legacy_unverified: boolean;
  delivery_event_id: string | null;
  created: boolean;
}

interface PreparedReport {
  incidentId: string;
  urgency: SafetyUrgency;
  requestHash: string;
  encryptedLocation: ReturnType<typeof TaskSafetyLocationService.encrypt> | null;
}

function hasOfflineSyncEvidence(input: SafetyReportInput): boolean {
  return input.clientSequence !== undefined
    && input.priorTaskVersion !== undefined
    && input.localOccurredAt !== undefined
    && input.deviceVersion !== undefined
    && input.appVersion !== undefined;
}

function prepareReport(input: SafetyReportInput, userId: string): PreparedReport {
  assertLocationRecency(input.location);
  const urgency = effectiveUrgency(input.category, input.urgency);
  const incidentId = randomUUID();
  const encryptedLocation = input.location
    ? TaskSafetyLocationService.encrypt(incidentId, input.location)
    : null;
  const semantics: Record<string, unknown> = {
    taskId: input.taskId,
    reporterUserId: userId,
    category: input.category,
    urgency,
    description: input.description,
    locationSharingEnabled: input.locationSharingEnabled,
    location: input.location ?? null,
    contactPermission: input.contactPermission,
  };
  if (hasOfflineSyncEvidence(input)) {
    semantics.offlineSync = {
      clientSequence: input.clientSequence,
      priorTaskVersion: input.priorTaskVersion,
      localOccurredAt: input.localOccurredAt,
      deviceVersion: input.deviceVersion,
      appVersion: input.appVersion,
      offlinePayloadHash: input.offlinePayloadHash,
      entrySurface: 'TASK_SAFETY_CENTER',
      contextSource: 'ACTIVE_TASK',
      intendedTransition: 'ANY_TO_SAFETY_REPORT_RECEIVED',
    };
  }
  const requestHash = payloadHash(semantics);
  return { incidentId, urgency, requestHash, encryptedLocation };
}

async function insertIncident(
  query: QueryFn,
  input: SafetyReportInput,
  userId: string,
  prepared: PreparedReport,
): Promise<SafetyIncidentRow> {
  const encrypted = prepared.encryptedLocation;
  const result = await query<SafetyIncidentRow>(
    `WITH inserted AS (
       INSERT INTO task_safety_incidents (
         id, task_id, reporter_user_id, category, urgency, description,
         location_sharing_enabled, contact_permission, idempotency_key,
         request_hash, location_ciphertext, location_nonce, location_auth_tag,
         location_key_id, location_captured_at, location_accuracy_meters,
         location_expires_at,sync_contract_version,client_sequence,prior_task_version,
         local_occurred_at,device_version,app_version,entry_surface,context_source,
         intended_transition,reconciliation_contract_version,offline_payload_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                 CASE WHEN $7 THEN NOW() + INTERVAL '30 days' ELSE NULL END,
                 $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       ON CONFLICT (reporter_user_id, idempotency_key) DO NOTHING
       RETURNING *, TRUE AS created
     )
     SELECT * FROM inserted
     UNION ALL
     SELECT existing.*, FALSE AS created
       FROM task_safety_incidents existing
      WHERE existing.reporter_user_id = $3 AND existing.idempotency_key = $9
        AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`,
    [
      prepared.incidentId,
      input.taskId,
      userId,
      input.category,
      prepared.urgency,
      input.description,
      input.locationSharingEnabled,
      input.contactPermission,
      input.idempotencyKey,
      prepared.requestHash,
      encrypted?.ciphertext ?? null,
      encrypted?.nonce ?? null,
      encrypted?.authTag ?? null,
      encrypted?.keyId ?? null,
      input.location?.capturedAt ?? null,
      input.location ? Math.round(input.location.accuracyMeters) : null,
      hasOfflineSyncEvidence(input) ? 1 : 0,
      input.clientSequence ?? null,
      input.priorTaskVersion ?? null,
      input.localOccurredAt ?? null,
      input.deviceVersion ?? null,
      input.appVersion ?? null,
      hasOfflineSyncEvidence(input) ? 'TASK_SAFETY_CENTER' : null,
      hasOfflineSyncEvidence(input) ? 'ACTIVE_TASK' : null,
      hasOfflineSyncEvidence(input) ? 'ANY_TO_SAFETY_REPORT_RECEIVED' : null,
      input.offlinePayloadHash ? 1 : 0,
      input.offlinePayloadHash ?? null,
    ],
  );
  const incident = result.rows[0];
  if (!incident) throw new Error('Safety incident could not be recorded');
  if (incident.request_hash !== prepared.requestHash) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Safety report key was already used with different report details.',
    });
  }
  return incident;
}

async function existingIncident(
  query: QueryFn,
  input: SafetyReportInput,
  userId: string,
  requestHash: string,
): Promise<SafetyIncidentRow | null> {
  const result = await query<SafetyIncidentRow>(
    `SELECT *,FALSE AS created FROM task_safety_incidents
      WHERE reporter_user_id=$1 AND idempotency_key=$2
      LIMIT 1`,
    [userId,input.idempotencyKey],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  let expectedHash = requestHash;
  if (Number(existing.sync_contract_version) === 0 && hasOfflineSyncEvidence(input)) {
    const legacyInput = {
      ...input,
      clientSequence: undefined,
      priorTaskVersion: undefined,
      localOccurredAt: undefined,
      deviceVersion: undefined,
      appVersion: undefined,
      offlinePayloadHash: undefined,
    };
    const legacyPrepared = prepareReport(legacyInput, userId);
    expectedHash = legacyPrepared.requestHash;
  } else if (Number(existing.reconciliation_contract_version) === 0
      && hasOfflineSyncEvidence(input)) {
    const legacyInput = { ...input, offlinePayloadHash: undefined };
    const legacyPrepared = prepareReport(legacyInput, userId);
    expectedHash = legacyPrepared.requestHash;
  }
  if (existing.request_hash !== expectedHash) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Safety report key was already used with different report details.',
    });
  }
  return existing;
}

async function assertSafetySyncBoundary(
  query: QueryFn,
  input: SafetyReportInput,
  userId: string,
): Promise<void> {
  const taskResult = await query<{ poster_id: string; worker_id: string | null; version: number }>(
    'SELECT poster_id,worker_id,version FROM tasks WHERE id=$1 FOR UPDATE',
    [input.taskId],
  );
  const task = taskResult.rows[0];
  if (!task || (task.poster_id !== userId && task.worker_id !== userId)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
  }
  if (!hasOfflineSyncEvidence(input)) return;
  if (Number(input.priorTaskVersion) !== Number(task.version)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'OFFLINE_SYNC_STALE_TASK_VERSION: refresh the task before sending this safety report.',
    });
  }
  const last = await query<{ client_sequence: string | number | null }>(
    `SELECT MAX(client_sequence) AS client_sequence
       FROM task_safety_incidents
      WHERE task_id=$1 AND reporter_user_id=$2 AND sync_contract_version=1`,
    [input.taskId,userId],
  );
  if (Number(input.clientSequence) <= Number(last.rows[0]?.client_sequence ?? 0)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'OFFLINE_SYNC_STALE_SEQUENCE: a newer safety command was already accepted.',
    });
  }
}

function operationsSeverity(urgency: SafetyUrgency): 'critical' | 'warning' | 'info' {
  if (urgency === 'urgent') return 'critical';
  if (urgency === 'high') return 'warning';
  return 'info';
}

async function mirrorNewIncident(
  query: QueryFn,
  incident: SafetyIncidentRow,
  input: SafetyReportInput,
  userId: string,
): Promise<void> {
  if (!incident.created) return;
  await query(
    `INSERT INTO task_safety_incident_events (
       incident_id, event_type, actor_user_id, public_message
     ) VALUES ($1, 'received', $2, $3)`,
    [
      incident.id,
      userId,
      'HustleXP received this report. Human acknowledgment is still pending.',
    ],
  );
  await query(
    `INSERT INTO incident_events (event_type, severity, service, details)
     VALUES ('manual_report', $1, 'trust_safety', $2::jsonb)`,
    [operationsSeverity(incident.urgency), JSON.stringify({
      safety_incident_id: incident.id,
      task_id: input.taskId,
      category: input.category,
      urgency: incident.urgency,
      reporter_user_id: userId,
      contact_permission: input.contactPermission,
      location_sharing_enabled: input.locationSharingEnabled,
    })],
  );
}

function publicIncident(incident: SafetyIncidentRow) {
  const {
    created: _created,
    request_hash: _requestHash,
    location_ciphertext: _locationCiphertext,
    location_nonce: _locationNonce,
    location_auth_tag: _locationAuthTag,
    location_key_id: _locationKeyId,
    source_checkin_id: _sourceCheckinId,
    location_legacy_unverified: _legacyLocationUnverified,
    delivery_event_id: _deliveryEventId,
    ...result
  } = incident;
  return result;
}

export async function reportSafety(input: SafetyReportInput, userId: string) {
  await requireTaskParticipant(input.taskId, userId);
  const prepared = prepareReport(input, userId);
  return db.transaction(async (query) => {
    const replay = await existingIncident(query,input,userId,prepared.requestHash);
    if (replay) return publicIncident(replay);
    if (hasOfflineSyncEvidence(input)) await assertSafetySyncBoundary(query,input,userId);
    const incident = await insertIncident(query, input, userId, prepared);
    await mirrorNewIncident(query, incident, input, userId);
    return publicIncident(incident);
  });
}

export async function getMySafetyReports(taskId: string, userId: string) {
  await requireTaskParticipant(taskId, userId);
  const reports = await db.query<{
    id: string;
    task_id: string;
    category: SafetyCategory;
    urgency: SafetyUrgency;
    description: string;
    status: string;
    delivery_state: string;
    location_sharing_enabled: boolean;
    contact_permission: string;
    created_at: Date;
    acknowledged_at: Date | null;
    resolved_at: Date | null;
  }>(
    `SELECT id, task_id, category, urgency, description, status, delivery_state,
            location_sharing_enabled, contact_permission, created_at,
            acknowledged_at, resolved_at
       FROM task_safety_incidents
      WHERE task_id = $1 AND reporter_user_id = $2
      ORDER BY created_at DESC`,
    [taskId, userId],
  );
  if (reports.rows.length === 0) return [];
  const timeline = await db.query<{
    incident_id: string;
    event_type: string;
    public_message: string;
    created_at: Date;
  }>(
    `SELECT incident_id, event_type, public_message, created_at
       FROM task_safety_incident_events
      WHERE incident_id = ANY($1::uuid[])
      ORDER BY created_at ASC`,
    [reports.rows.map((report) => report.id)],
  );
  return reports.rows.map((report) => ({
    ...report,
    timeline: timeline.rows.filter((event) => event.incident_id === report.id),
  }));
}
