import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }) },
}));

import { db } from '../../src/db';
import { TaskSafetyLocationService } from '../../src/services/TaskSafetyLocationService';

const INCIDENT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const evidence = {
  latitude: 47.6101,
  longitude: -122.2015,
  accuracyMeters: 12,
  capturedAt: '2026-07-18T20:00:00.000Z',
};

const mockDb = vi.mocked(db);

describe('TaskSafetyLocationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TASK_LOCATION_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
    process.env.TASK_LOCATION_ENCRYPTION_KEY_ID = 'safety-location-test-v1';
    mockDb.query.mockReset();
    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(async (fn: any) => fn(mockDb.query));
  });

  it('encrypts coordinates and releases them only with an attributable purpose log', async () => {
    const encrypted = TaskSafetyLocationService.encrypt(INCIDENT_ID, evidence);
    expect(Buffer.from(encrypted.ciphertext, 'base64').toString('utf8')).not.toContain('47.6101');
    mockDb.query
      .mockResolvedValueOnce({ rows: [{
        id: INCIDENT_ID,
        location_sharing_enabled: true,
        location_ciphertext: encrypted.ciphertext,
        location_nonce: encrypted.nonce,
        location_auth_tag: encrypted.authTag,
        location_key_id: encrypted.keyId,
        location_captured_at: evidence.capturedAt,
        location_accuracy_meters: evidence.accuracyMeters,
        location_expires_at: '2026-08-17T20:00:00.000Z',
        location_expired_at: null,
        location_active: true,
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await TaskSafetyLocationService.getForAdmin({
      incidentId: INCIDENT_ID,
      adminUserId: ADMIN_ID,
      purpose: 'Respond to the active missed safety check-in.',
    });

    expect(result).toEqual({ ...evidence, expiresAt: '2026-08-17T20:00:00.000Z' });
    expect(mockDb.query.mock.calls[0][0]).not.toContain('reporter_user_id');
    expect(mockDb.query.mock.calls[0][0]).toContain('location_expires_at > clock_timestamp()');
    expect(mockDb.query.mock.calls[1][0]).toContain('task_safety_location_access_log');
    expect(mockDb.query.mock.calls[1][1]).toEqual([
      INCIDENT_ID,
      ADMIN_ID,
      'Respond to the active missed safety check-in.',
      'safety-location-test-v1',
    ]);
  });

  it('fails closed when consent is absent or encrypted evidence is expired', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{
      id: INCIDENT_ID, location_sharing_enabled: false,
      location_ciphertext: null, location_nonce: null, location_auth_tag: null, location_key_id: null,
      location_captured_at: null, location_accuracy_meters: null,
      location_expires_at: null, location_expired_at: null,
      location_active: false,
    }], rowCount: 1 } as any);
    await expect(TaskSafetyLocationService.getForAdmin({
      incidentId: INCIDENT_ID, adminUserId: ADMIN_ID, purpose: 'Investigate the active safety case.',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    mockDb.query.mockResolvedValueOnce({ rows: [{
      id: INCIDENT_ID, location_sharing_enabled: true,
      location_ciphertext: null, location_nonce: null, location_auth_tag: null, location_key_id: null,
      location_captured_at: evidence.capturedAt, location_accuracy_meters: evidence.accuracyMeters,
      location_expires_at: '2026-07-18T20:30:00.000Z', location_expired_at: '2026-07-18T20:30:00.000Z',
      location_active: false,
    }], rowCount: 1 } as any);
    await expect(TaskSafetyLocationService.getForAdmin({
      incidentId: INCIDENT_ID, adminUserId: ADMIN_ID, purpose: 'Investigate the active safety case.',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it('erases due ciphertext in a bounded skip-locked batch', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'incident-1' }, { id: 'incident-2' }], rowCount: 2,
    } as any);
    await expect(TaskSafetyLocationService.expireDue(1000)).resolves.toEqual({
      expired: 2, incidentIds: ['incident-1', 'incident-2'],
    });
    expect(mockDb.query.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(mockDb.query.mock.calls[0][0]).toContain('location_ciphertext = NULL');
    expect(mockDb.query.mock.calls[0][1]).toEqual([100]);
  });
});
