import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => {
  const query = vi.fn();
  return {
    db: {
      query,
      transaction: vi.fn(async (fn: (q: typeof query) => Promise<unknown>) => fn(query)),
    },
  };
});

vi.mock('../../src/logger', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { logger: { child }, taskLogger: { child } };
});

import { db } from '../../src/db';
import { TaskLocationService, deriveRoughArea, redactPrivateLocation } from '../../src/services/TaskLocationService';
import { encryptTaskLocation } from '../../src/services/TaskLocationCrypto';

const query = vi.mocked(db.query);
const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
const WORKER_ID = '550e8400-e29b-41d4-a716-446655440001';
const EXACT_LOCATION = '123 Main St, Bellevue, WA 98004';

function releaseRow(overrides: Record<string, unknown> = {}) {
  const encrypted = encryptTaskLocation(TASK_ID, EXACT_LOCATION);
  return {
    worker_id: WORKER_ID,
    task_state: 'ACCEPTED',
    deadline: '2099-01-01T00:00:00.000Z',
    escrow_state: 'FUNDED',
    trust_tier_required: 2,
    worker_trust_tier: 3,
    worker_trust_hold: false,
    worker_is_banned: false,
    worker_account_status: 'ACTIVE',
    exact_location: null,
    location_ciphertext: encrypted.ciphertext,
    location_nonce: encrypted.nonce,
    location_auth_tag: encrypted.authTag,
    location_key_id: encrypted.keyId,
    location_fingerprint: encrypted.fingerprint,
    expired_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.TASK_LOCATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.TASK_LOCATION_ENCRYPTION_KEY_ID = 'location-test-v1';
  vi.clearAllMocks();
  query.mockReset();
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(query));
});

describe('deriveRoughArea', () => {
  it('removes street number, street, ZIP, and unit detail', () => {
    expect(deriveRoughArea('123 Main St, Unit 4, Bellevue, WA 98004')).toBe('Bellevue, WA area');
  });

  it('normalizes an explicit rough area without exposing its ZIP', () => {
    expect(deriveRoughArea('123 Main St, Bellevue, WA 98004', 'Bellevue, WA 98004')).toBe('Bellevue, WA area');
  });

  it('fails closed when no non-sensitive area can be derived', () => {
    expect(deriveRoughArea('123 Main Street')).toBe('Location protected until reservation');
  });

  it('does not expose a street name even when no street number is present', () => {
    expect(deriveRoughArea('Main Street, Bellevue, WA')).toBe('Bellevue, WA area');
  });
});

describe('redactPrivateLocation', () => {
  it('removes street addresses and exact GPS coordinates from public text', () => {
    expect(redactPrivateLocation('Meet at 123 Main Street near 47.6101, -122.2015 before noon.'))
      .toBe('Meet at [location protected] near [location protected] before noon.');
  });
});

describe('TaskLocationService.setByPoster', () => {
  it('stores a private location only while the poster-owned task is unreserved', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ poster_id: 'poster-1', worker_id: null, state: 'OPEN' }], rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await TaskLocationService.setByPoster({
      taskId: TASK_ID,
      posterId: 'poster-1',
      exactLocation: EXACT_LOCATION,
    });

    expect(result).toEqual({ success: true, data: { stored: true, idempotencyReplayed: false } });
    expect(String(query.mock.calls[2][0])).toContain('task_location_vault');
    const vaultValues = query.mock.calls[2][1] as unknown[];
    expect(vaultValues[0]).toBe(TASK_ID);
    expect(vaultValues).not.toContain(EXACT_LOCATION);
    expect(vaultValues[4]).toBe('location-test-v1');
  });

  it('replays the same address without another write', async () => {
    const encrypted = encryptTaskLocation(TASK_ID, EXACT_LOCATION);
    query
      .mockResolvedValueOnce({
        rows: [{ poster_id: 'poster-1', worker_id: null, state: 'MATCHING' }], rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ location_fingerprint: encrypted.fingerprint }], rowCount: 1,
      } as never);

    await expect(TaskLocationService.setByPoster({
      taskId: TASK_ID,
      posterId: 'poster-1',
      exactLocation: EXACT_LOCATION,
    })).resolves.toEqual({ success: true, data: { stored: true, idempotencyReplayed: true } });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('locks location changes after reservation', async () => {
    query.mockResolvedValueOnce({
      rows: [{ poster_id: 'poster-1', worker_id: 'worker-1', state: 'ACCEPTED' }], rowCount: 1,
    } as never);

    const result = await TaskLocationService.setByPoster({
      taskId: TASK_ID,
      posterId: 'poster-1',
      exactLocation: EXACT_LOCATION,
    });

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('LOCATION_LOCKED');
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('TaskLocationService.releaseToReservedWorker', () => {
  it('rejects exact-location access before engine reservation', async () => {
    query.mockResolvedValueOnce({
      rows: [releaseRow({ worker_id: null, task_state: 'OPEN' })],
      rowCount: 1,
    } as never);

    const result = await TaskLocationService.releaseToReservedWorker({
      taskId: TASK_ID,
      workerId: WORKER_ID,
    });

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('LOCATION_NOT_RELEASED');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('releases and audits the exact location only for the funded reserved worker', async () => {
    query
      .mockResolvedValueOnce({
        rows: [releaseRow()],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // vault release marker
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // access audit

    const result = await TaskLocationService.releaseToReservedWorker({
      taskId: TASK_ID,
      workerId: WORKER_ID,
    });

    expect(result).toEqual({
      success: true,
      data: { exactLocation: EXACT_LOCATION },
    });
    expect(String(query.mock.calls[1][0])).toContain('released_at');
    expect(String(query.mock.calls[2][0])).toContain('task_location_access_log');
    expect(String(query.mock.calls[2][0])).not.toContain('ON CONFLICT');
    expect(query.mock.calls[2][1]).toEqual([TASK_ID, WORKER_ID, 'location-test-v1']);
  });

  it('rejects release if escrow is not funded', async () => {
    query.mockResolvedValueOnce({
      rows: [releaseRow({ escrow_state: 'PENDING' })],
      rowCount: 1,
    } as never);

    const result = await TaskLocationService.releaseToReservedWorker({
      taskId: TASK_ID,
      workerId: WORKER_ID,
    });

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('TASK_NOT_FUNDED');
  });

  it('rejects release after the task deadline closes the permitted window', async () => {
    query.mockResolvedValueOnce({
      rows: [releaseRow({ deadline: '2000-01-01T00:00:00.000Z' })],
      rowCount: 1,
    } as never);

    await expect(TaskLocationService.releaseToReservedWorker({ taskId: TASK_ID, workerId: WORKER_ID }))
      .resolves.toMatchObject({ success: false, error: { code: 'LOCATION_WINDOW_CLOSED' } });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('re-checks account eligibility at address-release time', async () => {
    query.mockResolvedValueOnce({
      rows: [releaseRow({ worker_is_banned: true, worker_account_status: 'SUSPENDED' })],
      rowCount: 1,
    } as never);

    const result = await TaskLocationService.releaseToReservedWorker({
      taskId: TASK_ID,
      workerId: WORKER_ID,
    });

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('TRUST_TIER_INSUFFICIENT');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects quarantined legacy plaintext instead of releasing it', async () => {
    query.mockResolvedValueOnce({
      rows: [releaseRow({
        exact_location: EXACT_LOCATION,
        location_ciphertext: null,
        location_nonce: null,
        location_auth_tag: null,
        location_key_id: null,
      })],
      rowCount: 1,
    } as never);

    await expect(TaskLocationService.releaseToReservedWorker({ taskId: TASK_ID, workerId: WORKER_ID }))
      .resolves.toMatchObject({ success: false, error: { code: 'LOCATION_REENCRYPTION_REQUIRED' } });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects an address after terminal-state expiry', async () => {
    query.mockResolvedValueOnce({
      rows: [releaseRow({ expired_at: new Date() })],
      rowCount: 1,
    } as never);

    await expect(TaskLocationService.releaseToReservedWorker({ taskId: TASK_ID, workerId: WORKER_ID }))
      .resolves.toMatchObject({ success: false, error: { code: 'EXACT_LOCATION_EXPIRED' } });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
