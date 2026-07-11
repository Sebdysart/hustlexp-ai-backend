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

const query = vi.mocked(db.query);

beforeEach(() => {
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

describe('TaskLocationService.releaseToReservedWorker', () => {
  it('rejects exact-location access before engine reservation', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        worker_id: null,
        task_state: 'OPEN',
        escrow_state: 'FUNDED',
        trust_tier_required: 2,
        worker_trust_tier: 2,
        worker_trust_hold: false,
        worker_is_banned: false,
        worker_account_status: 'ACTIVE',
        exact_location: '123 Main St, Bellevue, WA 98004',
      }],
      rowCount: 1,
    } as never);

    const result = await TaskLocationService.releaseToReservedWorker({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      workerId: '550e8400-e29b-41d4-a716-446655440001',
    });

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('LOCATION_NOT_RELEASED');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('releases and audits the exact location only for the funded reserved worker', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{
          worker_id: '550e8400-e29b-41d4-a716-446655440001',
          task_state: 'ACCEPTED',
          escrow_state: 'FUNDED',
          trust_tier_required: 2,
          worker_trust_tier: 3,
          worker_trust_hold: false,
          worker_is_banned: false,
          worker_account_status: 'ACTIVE',
          exact_location: '123 Main St, Bellevue, WA 98004',
        }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // vault release marker
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // access audit

    const result = await TaskLocationService.releaseToReservedWorker({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      workerId: '550e8400-e29b-41d4-a716-446655440001',
    });

    expect(result).toEqual({
      success: true,
      data: { exactLocation: '123 Main St, Bellevue, WA 98004' },
    });
    expect(String(query.mock.calls[1][0])).toContain('released_at');
    expect(String(query.mock.calls[2][0])).toContain('task_location_access_log');
  });

  it('rejects release if escrow is not funded', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        worker_id: '550e8400-e29b-41d4-a716-446655440001',
        task_state: 'ACCEPTED',
        escrow_state: 'PENDING',
        trust_tier_required: 1,
        worker_trust_tier: 2,
        worker_trust_hold: false,
        worker_is_banned: false,
        worker_account_status: 'ACTIVE',
        exact_location: '123 Main St, Bellevue, WA 98004',
      }],
      rowCount: 1,
    } as never);

    const result = await TaskLocationService.releaseToReservedWorker({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      workerId: '550e8400-e29b-41d4-a716-446655440001',
    });

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('TASK_NOT_FUNDED');
  });

  it('re-checks account eligibility at address-release time', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        worker_id: '550e8400-e29b-41d4-a716-446655440001',
        task_state: 'ACCEPTED',
        escrow_state: 'FUNDED',
        trust_tier_required: 1,
        worker_trust_tier: 3,
        worker_trust_hold: false,
        worker_is_banned: true,
        worker_account_status: 'SUSPENDED',
        exact_location: '123 Main St, Bellevue, WA 98004',
      }],
      rowCount: 1,
    } as never);

    const result = await TaskLocationService.releaseToReservedWorker({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      workerId: '550e8400-e29b-41d4-a716-446655440001',
    });

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('TRUST_TIER_INSUFFICIENT');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
