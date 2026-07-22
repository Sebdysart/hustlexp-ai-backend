import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  authLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/services/IncidentDiagnosisService', () => ({
  IncidentDiagnosisService: { diagnoseIncident: vi.fn() },
}));

vi.mock('../../src/cache/redis', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

import incidentsRouter from '../../src/routers/incidents';
import { db } from '../../src/db';

const POSTER_ID = '11111111-1111-1111-1111-111111111111';
const WORKER_ID = '22222222-2222-2222-2222-222222222222';
const TASK_ID = '33333333-3333-3333-3333-333333333333';
const INCIDENT_ID = '44444444-4444-4444-4444-444444444444';
const IDEMPOTENCY_KEY = '55555555-5555-4555-8555-555555555555';
const ADMIN_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_ADMIN_ID = '88888888-8888-4888-8888-888888888888';
const RESOLUTION_KEY = '99999999-9999-4999-8999-999999999999';

const mockDb = vi.mocked(db);

function seedSafetyAdminCapability() {
  mockDb.query.mockResolvedValueOnce({
    rows: [{ role: 'moderator', capability_granted: true }],
    rowCount: 1,
  } as any);
}

function caller(userId = POSTER_ID, isAdmin = false) {
  return incidentsRouter.createCaller({
    user: { id: userId, is_admin: isAdmin } as any,
    firebaseUid: 'firebase-user',
  });
}

function task() {
  return { id: TASK_ID, poster_id: POSTER_ID, worker_id: WORKER_ID, state: 'ACCEPTED', version: 7 };
}

function hash(value: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const REPORT_DESCRIPTION = 'The other participant threatened me at the task.';
const REPORT_HASH = hash({
  taskId: TASK_ID,
  reporterUserId: POSTER_ID,
  category: 'threat',
  urgency: 'urgent',
  description: REPORT_DESCRIPTION,
  locationSharingEnabled: false,
  location: null,
  contactPermission: 'in_app_only',
});
const SYNC_EVIDENCE = {
  clientSequence: 41,
  priorTaskVersion: 7,
  localOccurredAt: '2026-07-20T10:00:00.000Z',
  deviceVersion: 'web-idb-aes-gcm-v1',
  appVersion: 'web-test',
};
const SYNC_REPORT_HASH = hash({
  taskId: TASK_ID,
  reporterUserId: POSTER_ID,
  category: 'threat',
  urgency: 'urgent',
  description: REPORT_DESCRIPTION,
  locationSharingEnabled: false,
  location: null,
  contactPermission: 'in_app_only',
  offlineSync: {
    ...SYNC_EVIDENCE,
    entrySurface: 'TASK_SAFETY_CENTER',
    contextSource: 'ACTIVE_TASK',
    intendedTransition: 'ANY_TO_SAFETY_REPORT_RECEIVED',
  },
});
const OFFLINE_PAYLOAD_HASH = 'd'.repeat(64);
const RECONCILED_SYNC_REPORT_HASH = hash({
  taskId: TASK_ID,
  reporterUserId: POSTER_ID,
  category: 'threat',
  urgency: 'urgent',
  description: REPORT_DESCRIPTION,
  locationSharingEnabled: false,
  location: null,
  contactPermission: 'in_app_only',
  offlineSync: {
    ...SYNC_EVIDENCE,
    offlinePayloadHash: OFFLINE_PAYLOAD_HASH,
    entrySurface: 'TASK_SAFETY_CENTER',
    contextSource: 'ACTIVE_TASK',
    intendedTransition: 'ANY_TO_SAFETY_REPORT_RECEIVED',
  },
});

describe('task safety incident intake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.mockReset();
    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(async (fn: any) => fn(mockDb.query));
    process.env.TASK_LOCATION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    process.env.TASK_LOCATION_ENCRYPTION_KEY_ID = 'safety-location-test-v1';
  });

  it('rejects a partial offline sync tuple before reading or writing safety data', async () => {
    await expect(caller().reportSafety({
      taskId: TASK_ID,
      category: 'threat',
      urgency: 'standard',
      description: REPORT_DESCRIPTION,
      locationSharingEnabled: false,
      contactPermission: 'in_app_only',
      idempotencyKey: IDEMPOTENCY_KEY,
      clientSequence: 5,
    })).rejects.toThrow('Offline sync evidence must be supplied as one complete tuple.');

    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('rejects a payload witness unless the legacy-compatible sync tuple is complete', async () => {
    await expect(caller().reportSafety({
      taskId: TASK_ID, category: 'threat', urgency: 'standard',
      description: REPORT_DESCRIPTION, locationSharingEnabled: false,
      contactPermission: 'in_app_only', idempotencyKey: IDEMPOTENCY_KEY,
      offlinePayloadHash: OFFLINE_PAYLOAD_HASH,
    })).rejects.toThrow('Offline payload evidence requires the complete sync tuple.');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('creates one urgent participant-owned case and mirrors it into Operations without raw narrative', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, task_id: TASK_ID, reporter_user_id: POSTER_ID,
        category: 'threat', urgency: 'urgent', status: 'received',
        delivery_state: 'received', location_sharing_enabled: false,
        contact_permission: 'in_app_only', created_at: new Date().toISOString(),
        request_hash: REPORT_HASH, created: true,
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await caller().reportSafety({
      taskId: TASK_ID,
      category: 'threat',
      urgency: 'standard',
      description: REPORT_DESCRIPTION,
      locationSharingEnabled: false,
      contactPermission: 'in_app_only',
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toMatchObject({ id: INCIDENT_ID, urgency: 'urgent', status: 'received' });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    const calls = mockDb.query.mock.calls;
    expect(calls[2][0]).toContain('INSERT INTO task_safety_incidents');
    expect(calls[2][0]).toContain('ON CONFLICT (reporter_user_id, idempotency_key) DO NOTHING');
    expect(calls[3][0]).toContain('INSERT INTO task_safety_incident_events');
    expect(calls[4][0]).toContain('INSERT INTO incident_events');
    expect(JSON.stringify(calls[4][1])).not.toContain('The other participant threatened me');
  });

  it.each([
    ['injury', 'urgent'],
    ['threat', 'urgent'],
    ['property_damage', 'high'],
    ['identity_theft', 'high'],
    ['fraud', 'high'],
    ['chargeback', 'high'],
    ['legal_request', 'high'],
    ['licensing_ambiguity', 'high'],
    ['high_value_compensation', 'high'],
    ['vulnerable_person_safety', 'urgent'],
  ] as const)('opens severe class %s with enforced %s urgency and an Operations mirror', async (
    category,
    effectiveUrgency,
  ) => {
    const description = `A participant reported a severe ${category} incident.`;
    const requestHash = hash({
      taskId: TASK_ID,
      reporterUserId: POSTER_ID,
      category,
      urgency: effectiveUrgency,
      description,
      locationSharingEnabled: false,
      location: null,
      contactPermission: 'in_app_only',
    });
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, task_id: TASK_ID, reporter_user_id: POSTER_ID,
        category, urgency: effectiveUrgency, status: 'received', delivery_state: 'received',
        location_sharing_enabled: false, contact_permission: 'in_app_only',
        created_at: new Date().toISOString(), request_hash: requestHash, created: true,
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    await expect(caller().reportSafety({
      taskId: TASK_ID,
      category,
      urgency: 'standard',
      description,
      locationSharingEnabled: false,
      contactPermission: 'in_app_only',
      idempotencyKey: IDEMPOTENCY_KEY,
    })).resolves.toMatchObject({ category, urgency: effectiveUrgency, status: 'received' });

    const insertCall = mockDb.query.mock.calls[2]!;
    expect(insertCall[1]?.[3]).toBe(category);
    expect(insertCall[1]?.[4]).toBe(effectiveUrgency);
    const operationsDetails = JSON.parse(String(mockDb.query.mock.calls[4]?.[1]?.[1]));
    expect(operationsDetails).toMatchObject({ category, urgency: effectiveUrgency });
  });

  it('replays the same safety report key without duplicating case or Operations events', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, task_id: TASK_ID, reporter_user_id: POSTER_ID,
        category: 'threat', urgency: 'urgent', status: 'received', delivery_state: 'received',
        location_sharing_enabled: false, contact_permission: 'in_app_only',
        created_at: new Date().toISOString(), request_hash: REPORT_HASH, created: false,
      }], rowCount: 1 } as any);

    const result = await caller().reportSafety({
      taskId: TASK_ID, category: 'threat', urgency: 'standard', description: REPORT_DESCRIPTION,
      locationSharingEnabled: false, contactPermission: 'in_app_only', idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result.id).toBe(INCIDENT_ID);
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it('persists and mirrors a complete v1 synchronized safety command', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ client_sequence: null }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, task_id: TASK_ID, reporter_user_id: POSTER_ID,
        category: 'threat', urgency: 'urgent', status: 'received', delivery_state: 'received',
        location_sharing_enabled: false, contact_permission: 'in_app_only',
        created_at: new Date().toISOString(), request_hash: SYNC_REPORT_HASH,
        sync_contract_version: 1, created: true,
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    await expect(caller().reportSafety({
      taskId: TASK_ID, category: 'threat', urgency: 'standard', description: REPORT_DESCRIPTION,
      locationSharingEnabled: false, contactPermission: 'in_app_only',
      idempotencyKey: IDEMPOTENCY_KEY, ...SYNC_EVIDENCE,
    })).resolves.toMatchObject({ id: INCIDENT_ID, sync_contract_version: 1 });
    const insert = mockDb.query.mock.calls[4]!;
    expect(String(insert[0])).toContain('sync_contract_version,client_sequence,prior_task_version');
    expect(insert[1]).toEqual(expect.arrayContaining([
      1, 41, 7, '2026-07-20T10:00:00.000Z',
      'web-idb-aes-gcm-v1', 'web-test', 'TASK_SAFETY_CENTER',
      'ACTIVE_TASK', 'ANY_TO_SAFETY_REPORT_RECEIVED',
    ]));
  });

  it('persists a current synchronized safety command with its reconciliation witness', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ client_sequence: null }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, task_id: TASK_ID, reporter_user_id: POSTER_ID,
        category: 'threat', urgency: 'urgent', status: 'received', delivery_state: 'received',
        location_sharing_enabled: false, contact_permission: 'in_app_only',
        created_at: new Date().toISOString(), request_hash: RECONCILED_SYNC_REPORT_HASH,
        sync_contract_version: 1, reconciliation_contract_version: 1, created: true,
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    await expect(caller().reportSafety({
      taskId: TASK_ID, category: 'threat', urgency: 'standard', description: REPORT_DESCRIPTION,
      locationSharingEnabled: false, contactPermission: 'in_app_only',
      idempotencyKey: IDEMPOTENCY_KEY, ...SYNC_EVIDENCE, offlinePayloadHash: OFFLINE_PAYLOAD_HASH,
    })).resolves.toMatchObject({ id: INCIDENT_ID, reconciliation_contract_version: 1 });
    const insert = mockDb.query.mock.calls[4]!;
    expect(insert[1]).toEqual(expect.arrayContaining([1, OFFLINE_PAYLOAD_HASH]));
  });

  it('replays a sync-v1 safety command written before reconciliation hashes', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ ...task(), version: 8 }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, task_id: TASK_ID, reporter_user_id: POSTER_ID,
        request_hash: SYNC_REPORT_HASH, sync_contract_version: 1,
        reconciliation_contract_version: 0, created: false,
      }], rowCount: 1 } as any);
    await expect(caller().reportSafety({
      taskId: TASK_ID, category: 'threat', urgency: 'standard', description: REPORT_DESCRIPTION,
      locationSharingEnabled: false, contactPermission: 'in_app_only',
      idempotencyKey: IDEMPOTENCY_KEY, ...SYNC_EVIDENCE, offlinePayloadHash: OFFLINE_PAYLOAD_HASH,
    })).resolves.toMatchObject({ id: INCIDENT_ID });
  });

  it('replays a pre-sync safety command when a current client retries the same identity', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ ...task(), version: 8 }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, task_id: TASK_ID, reporter_user_id: POSTER_ID,
        request_hash: REPORT_HASH, sync_contract_version: 0,
        reconciliation_contract_version: 0, created: false,
      }], rowCount: 1 } as any);
    await expect(caller().reportSafety({
      taskId: TASK_ID, category: 'threat', urgency: 'standard', description: REPORT_DESCRIPTION,
      locationSharingEnabled: false, contactPermission: 'in_app_only',
      idempotencyKey: IDEMPOTENCY_KEY, ...SYNC_EVIDENCE, offlinePayloadHash: OFFLINE_PAYLOAD_HASH,
    })).resolves.toMatchObject({ id: INCIDENT_ID });
  });

  it('replays an exact v1 safety command after the task version advances', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ ...task(), version: 8 }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, task_id: TASK_ID, reporter_user_id: POSTER_ID,
        request_hash: SYNC_REPORT_HASH, sync_contract_version: 1, created: false,
      }], rowCount: 1 } as any);
    await expect(caller().reportSafety({
      taskId: TASK_ID, category: 'threat', urgency: 'standard', description: REPORT_DESCRIPTION,
      locationSharingEnabled: false, contactPermission: 'in_app_only',
      idempotencyKey: IDEMPOTENCY_KEY, ...SYNC_EVIDENCE,
    })).resolves.toMatchObject({ id: INCIDENT_ID });
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it('rejects a stale task version before storing a synchronized safety command', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ ...task(), version: 8 }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{ ...task(), version: 8 }], rowCount: 1 } as any);
    await expect(caller().reportSafety({
      taskId: TASK_ID, category: 'threat', urgency: 'standard', description: REPORT_DESCRIPTION,
      locationSharingEnabled: false, contactPermission: 'in_app_only',
      idempotencyKey: IDEMPOTENCY_KEY, ...SYNC_EVIDENCE,
    })).rejects.toMatchObject({
      code: 'CONFLICT', message: expect.stringContaining('OFFLINE_SYNC_STALE_TASK_VERSION'),
    });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO task_safety_incidents'))).toBe(false);
  });

  it('rejects an older non-replayed safety client sequence', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ client_sequence: 41 }], rowCount: 1 } as any);
    await expect(caller().reportSafety({
      taskId: TASK_ID, category: 'threat', urgency: 'standard', description: REPORT_DESCRIPTION,
      locationSharingEnabled: false, contactPermission: 'in_app_only',
      idempotencyKey: IDEMPOTENCY_KEY, ...SYNC_EVIDENCE,
    })).rejects.toMatchObject({
      code: 'CONFLICT', message: expect.stringContaining('OFFLINE_SYNC_STALE_SEQUENCE'),
    });
  });

  it('rejects a reused safety report key with changed details', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, request_hash: REPORT_HASH, created: false,
      }], rowCount: 1 } as any);

    await expect(caller().reportSafety({
      taskId: TASK_ID, category: 'threat', urgency: 'standard',
      description: 'The facts in this reused request were materially changed.',
      locationSharingEnabled: false, contactPermission: 'in_app_only', idempotencyKey: IDEMPOTENCY_KEY,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-participant without revealing that the task exists', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any);

    await expect(caller('66666666-6666-4666-8666-666666666666').reportSafety({
      taskId: TASK_ID,
      category: 'injury',
      urgency: 'urgent',
      description: 'I need help with an injury at this task.',
      locationSharingEnabled: true,
      location: {
        latitude: 47.6101, longitude: -122.2015, accuracyMeters: 12,
        capturedAt: '2026-07-18T20:00:00.000Z',
      },
      contactPermission: 'call',
      idempotencyKey: IDEMPOTENCY_KEY,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('binds shared coordinates to the request while returning and mirroring no raw location', async () => {
    const location = {
      latitude: 47.6101,
      longitude: -122.2015,
      accuracyMeters: 12,
      capturedAt: '2026-07-18T20:00:00.000Z',
    };
    const locationHash = hash({
      taskId: TASK_ID,
      reporterUserId: POSTER_ID,
      category: 'threat',
      urgency: 'urgent',
      description: REPORT_DESCRIPTION,
      locationSharingEnabled: true,
      location,
      contactPermission: 'in_app_only',
    });
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, task_id: TASK_ID, reporter_user_id: POSTER_ID,
        category: 'threat', urgency: 'urgent', status: 'received', delivery_state: 'received',
        location_sharing_enabled: true, contact_permission: 'in_app_only',
        created_at: new Date().toISOString(), request_hash: locationHash, created: true,
        location_ciphertext: 'encrypted-only', location_nonce: 'nonce',
        location_auth_tag: 'tag', location_key_id: 'safety-location-test-v1', source_checkin_id: null,
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await caller().reportSafety({
      taskId: TASK_ID,
      category: 'threat',
      urgency: 'urgent',
      description: REPORT_DESCRIPTION,
      locationSharingEnabled: true,
      location,
      contactPermission: 'in_app_only',
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).not.toHaveProperty('location_ciphertext');
    expect(result).not.toHaveProperty('location_nonce');
    expect(mockDb.query.mock.calls[2][0]).toContain('location_ciphertext');
    expect(mockDb.query.mock.calls[2][1]?.[10]).not.toContain('47.6101');
    expect(JSON.stringify(mockDb.query.mock.calls[4][1])).not.toContain('47.6101');
    expect(JSON.stringify(mockDb.query.mock.calls[4][1])).not.toContain('-122.2015');
  });

  it('rejects a replay key when the captured coordinates change', async () => {
    const firstLocation = {
      latitude: 47.6101, longitude: -122.2015, accuracyMeters: 12,
      capturedAt: '2026-07-18T20:00:00.000Z',
    };
    const firstHash = hash({
      taskId: TASK_ID, reporterUserId: POSTER_ID, category: 'threat', urgency: 'urgent',
      description: REPORT_DESCRIPTION, locationSharingEnabled: true,
      location: firstLocation, contactPermission: 'in_app_only',
    });
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: INCIDENT_ID, request_hash: firstHash, created: false }], rowCount: 1 } as any);

    await expect(caller().reportSafety({
      taskId: TASK_ID, category: 'threat', urgency: 'urgent', description: REPORT_DESCRIPTION,
      locationSharingEnabled: true,
      location: { ...firstLocation, latitude: 47.6202 },
      contactPermission: 'in_app_only', idempotencyKey: IDEMPOTENCY_KEY,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects stale or future coordinate evidence before incident storage', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any);
    await expect(caller().reportSafety({
      taskId: TASK_ID, category: 'threat', urgency: 'urgent', description: REPORT_DESCRIPTION,
      locationSharingEnabled: true,
      location: {
        latitude: 47.6101, longitude: -122.2015, accuracyMeters: 12,
        capturedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      },
      contactPermission: 'in_app_only', idempotencyKey: IDEMPOTENCY_KEY,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('returns only the reporter own task cases and their append-only timeline', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, task_id: TASK_ID, category: 'injury', urgency: 'urgent',
        status: 'acknowledged', delivery_state: 'received',
        location_sharing_enabled: true, contact_permission: 'call',
        created_at: new Date().toISOString(), acknowledged_at: new Date().toISOString(),
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{
        incident_id: INCIDENT_ID, event_type: 'acknowledged', public_message: 'A safety operator acknowledged this report.', created_at: new Date().toISOString(),
      }], rowCount: 1 } as any);

    const result = await caller().getMySafetyReports({ taskId: TASK_ID });

    expect(result[0]).toMatchObject({ id: INCIDENT_ID, status: 'acknowledged' });
    expect(result[0].timeline).toHaveLength(1);
    expect(mockDb.query.mock.calls[1][0]).toContain('reporter_user_id = $2');
  });

  it('lists a privacy-minimized Operations queue without narrative or location evidence', async () => {
    seedSafetyAdminCapability();
    mockDb.query.mockResolvedValueOnce({ rows: [{
      id: INCIDENT_ID,
      task_id: TASK_ID,
      category: 'threat',
      urgency: 'urgent',
      status: 'received',
      delivery_state: 'received',
      contact_permission: 'in_app_only',
      location_sharing_enabled: true,
      owner_assigned: false,
      owned_by_current_operator: false,
      created_at: new Date().toISOString(),
    }], rowCount: 1 } as any);

    const result = await caller(ADMIN_ID, true).listSafetyCases({});

    expect(result).toHaveLength(1);
    const sql = String(mockDb.query.mock.calls[1][0]);
    expect(sql).not.toContain('description');
    expect(sql).not.toContain('location_ciphertext');
    expect(sql).not.toContain('reporter_user_id');
    expect(mockDb.query.mock.calls[1][1]).toEqual([false, ADMIN_ID, 50]);
  });

  it('purpose-audits an explicit safety case detail projection before returning it', async () => {
    seedSafetyAdminCapability();
    mockDb.query
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, task_id: TASK_ID, category: 'injury', urgency: 'urgent',
        description: 'A participant reported an injury requiring response.',
        status: 'acknowledged', delivery_state: 'contact_attempted',
        contact_permission: 'call', location_sharing_enabled: true,
        owner_assigned: true, owned_by_current_operator: true,
        location_evidence_available: true, created_at: new Date().toISOString(),
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{
        event_type: 'acknowledged',
        public_message: 'A safety operator acknowledged this report.',
        created_at: new Date().toISOString(),
        resolution_code: null,
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const purpose = 'Review and respond to this active task safety case.';
    const result = await caller(ADMIN_ID, true).getSafetyCaseForAdmin({
      incidentId: INCIDENT_ID,
      purpose,
    });

    expect(result).toMatchObject({ id: INCIDENT_ID, owned_by_current_operator: true });
    expect(result.timeline).toHaveLength(1);
    const detailSql = String(mockDb.query.mock.calls[1][0]);
    expect(detailSql).not.toContain('reporter_user_id');
    expect(detailSql).not.toContain('location_nonce');
    expect(detailSql).not.toContain('location_auth_tag');
    expect(mockDb.query.mock.calls[3][0]).toContain('INSERT INTO task_safety_case_access_log');
    expect(mockDb.query.mock.calls[3][1]).toEqual([INCIDENT_ID, ADMIN_ID, purpose]);
  });

  it('lets an admin acknowledge once and writes an attributable timeline event atomically', async () => {
    seedSafetyAdminCapability();
    mockDb.query
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, task_id: TASK_ID, reporter_user_id: POSTER_ID,
        status: 'acknowledged', delivery_state: 'received',
        acknowledged_at: new Date().toISOString(), changed: true,
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await caller(ADMIN_ID, true).acknowledgeSafety({
      incidentId: INCIDENT_ID,
      publicMessage: 'A safety operator acknowledged this report.',
    });

    expect(result.status).toBe('acknowledged');
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.query.mock.calls[1][0]).toContain("status = 'received'");
    expect(mockDb.query.mock.calls[1][0]).not.toContain("delivery_state = 'acknowledged'");
    expect(mockDb.query.mock.calls[2][0]).toContain('INSERT INTO task_safety_incident_events');
  });

  it('rejects acknowledgment replay by an operator who does not own the case', async () => {
    seedSafetyAdminCapability();
    mockDb.query.mockResolvedValueOnce({ rows: [{
      id: INCIDENT_ID, task_id: TASK_ID, reporter_user_id: POSTER_ID,
      status: 'acknowledged', delivery_state: 'received',
      acknowledged_at: new Date().toISOString(), assigned_admin_id: OTHER_ADMIN_ID,
      changed: false,
    }], rowCount: 1 } as any);

    await expect(caller(ADMIN_ID, true).acknowledgeSafety({
      incidentId: INCIDENT_ID,
      publicMessage: 'A safety operator acknowledged this report.',
    })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('another operator'),
    });
  });

  it('resolves an acknowledged case only through its owner and mirrors canonical resolution', async () => {
    const resolvedAt = new Date('2026-07-20T21:00:00.000Z');
    seedSafetyAdminCapability();
    mockDb.query
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, status: 'acknowledged', assigned_admin_id: ADMIN_ID,
        resolved_at: null,
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, status: 'resolved', resolved_at: resolvedAt,
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await caller(ADMIN_ID, true).resolveSafety({
      incidentId: INCIDENT_ID,
      idempotencyKey: RESOLUTION_KEY,
      resolutionCode: 'safety_plan_confirmed',
      publicMessage: 'A safety operator confirmed the resolution plan with the participant.',
    });

    expect(result).toMatchObject({
      incidentId: INCIDENT_ID,
      status: 'resolved',
      resolutionCode: 'safety_plan_confirmed',
      idempotencyReplayed: false,
    });
    expect(mockDb.query.mock.calls[3][0]).toContain("event_type, actor_user_id, public_message");
    expect(mockDb.query.mock.calls[4][0]).toContain("status = 'resolved'");
    expect(mockDb.query.mock.calls[5][0]).toContain("details->>'safety_incident_id'");
  });

  it.each([
    ['received', ADMIN_ID, 'PRECONDITION_FAILED'],
    ['acknowledged', OTHER_ADMIN_ID, 'FORBIDDEN'],
  ] as const)('rejects resolution from status %s with owner %s', async (
    status,
    assignedAdminId,
    code,
  ) => {
    seedSafetyAdminCapability();
    mockDb.query
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, status, assigned_admin_id: assignedAdminId, resolved_at: null,
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(caller(ADMIN_ID, true).resolveSafety({
      incidentId: INCIDENT_ID,
      idempotencyKey: RESOLUTION_KEY,
      resolutionCode: 'unable_to_confirm',
      publicMessage: 'A safety operator could not confirm a final resolution outcome.',
    })).rejects.toMatchObject({ code });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'resolved'")))
      .toBe(false);
  });

  it('replays the exact resolution and rejects a changed payload under the same key', async () => {
    const publicMessage = 'A safety operator referred this case to emergency services.';
    const requestHash = hash({
      incidentId: INCIDENT_ID,
      idempotencyKey: RESOLUTION_KEY,
      resolutionCode: 'emergency_services_referred',
      publicMessage,
    });
    seedSafetyAdminCapability();
    mockDb.query
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, status: 'resolved', assigned_admin_id: ADMIN_ID,
        resolved_at: new Date('2026-07-20T21:00:00.000Z'),
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{
        actor_user_id: ADMIN_ID, request_hash: requestHash,
      }], rowCount: 1 } as any);
    await expect(caller(ADMIN_ID, true).resolveSafety({
      incidentId: INCIDENT_ID,
      idempotencyKey: RESOLUTION_KEY,
      resolutionCode: 'emergency_services_referred',
      publicMessage,
    })).resolves.toMatchObject({ idempotencyReplayed: true, status: 'resolved' });

    seedSafetyAdminCapability();
    mockDb.query
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, status: 'resolved', assigned_admin_id: ADMIN_ID,
        resolved_at: new Date('2026-07-20T21:00:00.000Z'),
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{
        actor_user_id: ADMIN_ID, request_hash: requestHash,
      }], rowCount: 1 } as any);
    await expect(caller(ADMIN_ID, true).resolveSafety({
      incidentId: INCIDENT_ID,
      idempotencyKey: RESOLUTION_KEY,
      resolutionCode: 'emergency_services_referred',
      publicMessage: 'A changed resolution statement must not overwrite the first record.',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('records attempted contact without conflating it with human acknowledgment', async () => {
    const occurredAt = '2026-07-18T20:00:00.000Z';
    seedSafetyAdminCapability();
    mockDb.query
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, contact_permission: 'call', delivery_state: 'received', status: 'received',
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await caller(ADMIN_ID, true).recordSafetyContact({
      incidentId: INCIDENT_ID,
      providerEventId: 'voice:attempt:0001',
      eventType: 'contact_attempted',
      channel: 'call',
      publicMessage: 'A safety call was attempted. Delivery is not yet confirmed.',
      occurredAt,
    });

    expect(result).toEqual({ incidentId: INCIDENT_ID, deliveryState: 'contact_attempted', idempotencyReplayed: false });
    expect(mockDb.query.mock.calls[3][0]).toContain('INSERT INTO task_safety_incident_events');
    expect(mockDb.query.mock.calls[4][1]).toEqual([
      INCIDENT_ID, 'contact_attempted', 'voice:attempt:0001',
    ]);
  });

  it('replays a provider contact event and rejects provider ID conflicts', async () => {
    const input = {
      incidentId: INCIDENT_ID,
      providerEventId: 'sms:delivered:0001',
      eventType: 'contact_delivered' as const,
      channel: 'text' as const,
      publicMessage: 'The safety text was delivered. Human acknowledgment is separate.',
      occurredAt: '2026-07-18T20:01:00.000Z',
    };
    const requestHash = hash({
      incidentId: input.incidentId,
      eventType: input.eventType,
      channel: input.channel,
      publicMessage: input.publicMessage,
      occurredAt: input.occurredAt,
    });
    seedSafetyAdminCapability();
    mockDb.query
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, contact_permission: 'text', delivery_state: 'contact_delivered', status: 'acknowledged',
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ incident_id: INCIDENT_ID, request_hash: requestHash }], rowCount: 1 } as any);
    await expect(caller(ADMIN_ID, true).recordSafetyContact(input))
      .resolves.toEqual({ incidentId: INCIDENT_ID, deliveryState: 'contact_delivered', idempotencyReplayed: true });

    seedSafetyAdminCapability();
    mockDb.query
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID, contact_permission: 'text', delivery_state: 'contact_attempted', status: 'acknowledged',
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ incident_id: INCIDENT_ID, request_hash: 'f'.repeat(64) }], rowCount: 1 } as any);
    await expect(caller(ADMIN_ID, true).recordSafetyContact(input))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
