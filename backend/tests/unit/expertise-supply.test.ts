import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn(), serializableTransaction: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
}));

vi.mock('../../src/logger', () => {
  const childFn = () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: childFn });
  const mockLogger = { child: childFn, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
  return { logger: mockLogger };
});

vi.mock('../../src/services/NotificationService', () => ({
  NotificationService: { createNotification: vi.fn().mockResolvedValue({ success: true, data: {} }) },
}));

import { ExpertiseSupplyService } from '../../src/services/ExpertiseSupplyService';
import { db } from '../../src/db';

// ============================================================================
// HELPERS
// ============================================================================

/** A full capacity row as returned by expertise_capacity JOIN expertise_registry */
const makeCapRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'cap-1',
  expertise_id: 'exp-1',
  geo_zone: 'seattle_metro',
  max_weight_capacity: '10',
  min_task_to_supply_ratio: '0.5',
  current_weight: '4',
  active_hustlers: '5',
  open_tasks_7d: '20',
  completed_tasks_7d: '15',
  liquidity_ratio: '0.8',
  open_ratio: '0.5',
  auto_expand_pct: '0',
  auto_expand_expires_at: null,
  slug: 'plumbing',
  display_name: 'Plumbing',
  ...overrides,
});

/** A user_expertise row */
const makeUERow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ue-1',
  expertise_id: 'exp-1',
  slug: 'plumbing',
  display_name: 'Plumbing',
  geo_zone: 'seattle_metro',
  slot_weight: '0.7',
  is_primary: true,
  effective_weight: '0.7',
  status: 'active',
  locked_until: null,
  last_task_accepted_at: null,
  tasks_accepted_14d: '3',
  tasks_completed_14d: '2',
  created_at: '2025-01-01T00:00:00Z',
  ...overrides,
});

/** A waitlist row */
const makeWaitlistRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'wl-1',
  slug: 'plumbing',
  display_name: 'Plumbing',
  geo_zone: 'seattle_metro',
  position: 1,
  requested_weight: '0.7',
  status: 'waiting',
  invited_at: null,
  invite_expires_at: null,
  created_at: '2025-01-01T00:00:00Z',
  ...overrides,
});

// ============================================================================
// listExpertise
// ============================================================================

describe('ExpertiseSupplyService.listExpertise', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns success with mapped expertise rows', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [
        { id: 'exp-1', slug: 'plumbing', display_name: 'Plumbing', description: 'Fix pipes', risk_tier: 'low', active: true },
        { id: 'exp-2', slug: 'electrical', display_name: 'Electrical', description: null, risk_tier: 'medium', active: true },
      ],
      rowCount: 2,
    });

    const result = await ExpertiseSupplyService.listExpertise();

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data![0]).toMatchObject({
      id: 'exp-1',
      slug: 'plumbing',
      displayName: 'Plumbing',
      description: 'Fix pipes',
      riskTier: 'low',
      active: true,
    });
    expect(result.data![1]).toMatchObject({
      id: 'exp-2',
      slug: 'electrical',
      displayName: 'Electrical',
      description: null,
      riskTier: 'medium',
      active: true,
    });
  });

  it('returns success with empty array when no rows', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await ExpertiseSupplyService.listExpertise();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  });

  it('returns failure when db.query throws', async () => {
    (db.query as any).mockRejectedValueOnce(new Error('DB Error'));
    const result = await ExpertiseSupplyService.listExpertise();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EXPERTISE_LIST_FAILED');
    expect(result.error?.message).toBe('DB Error');
  });
});

// ============================================================================
// checkCapacity
// ============================================================================

describe('ExpertiseSupplyService.checkCapacity', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns success with capacity data when zone is accepting', async () => {
    // First query: capacity row
    (db.query as any).mockResolvedValueOnce({ rows: [makeCapRow()], rowCount: 1 });
    // Second query: expertise slug / display_name
    (db.query as any).mockResolvedValueOnce({ rows: [{ slug: 'plumbing', display_name: 'Plumbing' }], rowCount: 1 });
    // Third query: waitlist count
    (db.query as any).mockResolvedValueOnce({ rows: [{ count: '3' }], rowCount: 1 });

    const result = await ExpertiseSupplyService.checkCapacity('exp-1', 'seattle_metro');

    expect(result.success).toBe(true);
    const data = result.data!;
    expect(data.expertiseId).toBe('exp-1');
    expect(data.expertiseSlug).toBe('plumbing');
    expect(data.expertiseDisplayName).toBe('Plumbing');
    expect(data.geoZone).toBe('seattle_metro');
    expect(data.maxWeightCapacity).toBe(10);
    expect(data.currentWeight).toBe(4);
    expect(data.isAcceptingNew).toBe(true);
    expect(data.blockReason).toBeNull();
    expect(data.waitlistLength).toBe(3);
    expect(data.activeHustlers).toBe(5);
    expect(data.liquidityRatio).toBe(0.8);
    expect(data.completedTasks7d).toBe(15);
  });

  it('returns CAPACITY_NOT_FOUND when no capacity record exists', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await ExpertiseSupplyService.checkCapacity('exp-999', 'seattle_metro');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CAPACITY_NOT_FOUND');
  });

  it('sets isAcceptingNew=false and blockReason when at hard cap', async () => {
    // current_weight >= max_weight_capacity
    const capRow = makeCapRow({ current_weight: '10', max_weight_capacity: '10', active_hustlers: '5' });
    (db.query as any).mockResolvedValueOnce({ rows: [capRow], rowCount: 1 });
    (db.query as any).mockResolvedValueOnce({ rows: [{ slug: 'plumbing', display_name: 'Plumbing' }], rowCount: 1 });
    (db.query as any).mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 1 });

    const result = await ExpertiseSupplyService.checkCapacity('exp-1');

    expect(result.success).toBe(true);
    expect(result.data!.isAcceptingNew).toBe(false);
    expect(result.data!.blockReason).toContain('maximum capacity');
  });

  it('sets isAcceptingNew=false when ratio gate fails', async () => {
    // liquidity_ratio < min_task_to_supply_ratio with active hustlers
    const capRow = makeCapRow({ liquidity_ratio: '0.1', min_task_to_supply_ratio: '0.5', current_weight: '5', max_weight_capacity: '10', active_hustlers: '3' });
    (db.query as any).mockResolvedValueOnce({ rows: [capRow], rowCount: 1 });
    (db.query as any).mockResolvedValueOnce({ rows: [{ slug: 'plumbing', display_name: 'Plumbing' }], rowCount: 1 });
    (db.query as any).mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 });

    const result = await ExpertiseSupplyService.checkCapacity('exp-1');

    expect(result.success).toBe(true);
    expect(result.data!.isAcceptingNew).toBe(false);
    expect(result.data!.blockReason).toContain('Throughput ratio');
  });

  it('allows first entrants (activeHustlers=0) even when ratio is 0', async () => {
    const capRow = makeCapRow({ active_hustlers: '0', liquidity_ratio: '0', current_weight: '0' });
    (db.query as any).mockResolvedValueOnce({ rows: [capRow], rowCount: 1 });
    (db.query as any).mockResolvedValueOnce({ rows: [{ slug: 'plumbing', display_name: 'Plumbing' }], rowCount: 1 });
    (db.query as any).mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    const result = await ExpertiseSupplyService.checkCapacity('exp-1');

    expect(result.success).toBe(true);
    expect(result.data!.isAcceptingNew).toBe(true);
  });

  it('applies auto-expansion when not expired', async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const capRow = makeCapRow({
      max_weight_capacity: '10',
      auto_expand_pct: '10',
      auto_expand_expires_at: futureDate,
      current_weight: '10',
    });
    (db.query as any).mockResolvedValueOnce({ rows: [capRow], rowCount: 1 });
    (db.query as any).mockResolvedValueOnce({ rows: [{ slug: 'plumbing', display_name: 'Plumbing' }], rowCount: 1 });
    (db.query as any).mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    const result = await ExpertiseSupplyService.checkCapacity('exp-1');

    expect(result.success).toBe(true);
    // effectiveMax = 10 * 1.1 = 11, currentWeight=10 → still has capacity
    expect(result.data!.effectiveMaxCapacity).toBe(11);
    expect(result.data!.autoExpandPct).toBe(10);
    expect(result.data!.autoExpandExpiresAt).toBe(futureDate);
  });

  it('returns failure when db.query throws', async () => {
    (db.query as any).mockRejectedValueOnce(new Error('DB Error'));
    const result = await ExpertiseSupplyService.checkCapacity('exp-1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CAPACITY_CHECK_FAILED');
  });

  it('uses default geoZone seattle_metro when not provided', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [makeCapRow()], rowCount: 1 });
    (db.query as any).mockResolvedValueOnce({ rows: [{ slug: 'plumbing', display_name: 'Plumbing' }], rowCount: 1 });
    (db.query as any).mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    const result = await ExpertiseSupplyService.checkCapacity('exp-1');
    expect(result.success).toBe(true);
    expect(result.data!.geoZone).toBe('seattle_metro');
  });
});

// ============================================================================
// getUserExpertise
// ============================================================================

describe('ExpertiseSupplyService.getUserExpertise', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns success with mapped user expertise rows', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [makeUERow()],
      rowCount: 1,
    });

    const result = await ExpertiseSupplyService.getUserExpertise('user-1');

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    const item = result.data![0];
    expect(item.id).toBe('ue-1');
    expect(item.expertiseId).toBe('exp-1');
    expect(item.expertiseSlug).toBe('plumbing');
    expect(item.expertiseDisplayName).toBe('Plumbing');
    expect(item.geoZone).toBe('seattle_metro');
    expect(item.slotWeight).toBe(0.7);
    expect(item.isPrimary).toBe(true);
    expect(item.effectiveWeight).toBe(0.7);
    expect(item.status).toBe('active');
    expect(item.tasksAccepted14d).toBe(3);
    expect(item.tasksCompleted14d).toBe(2);
  });

  it('returns success with empty array when user has no expertise', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await ExpertiseSupplyService.getUserExpertise('user-1');
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  });

  it('returns failure when db.query throws', async () => {
    (db.query as any).mockRejectedValueOnce(new Error('DB Error'));
    const result = await ExpertiseSupplyService.getUserExpertise('user-1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GET_USER_EXPERTISE_FAILED');
    expect(result.error?.message).toBe('DB Error');
  });
});

// ============================================================================
// addUserExpertise
// ============================================================================

describe('ExpertiseSupplyService.addUserExpertise', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  /**
   * Helper that sets up db.serializableTransaction to execute the callback
   * with a mock inner query function that returns the provided responses in order.
   */
  const setupTransaction = (queryResponses: Array<{ rows: unknown[]; rowCount?: number }>) => {
    let callIndex = 0;
    (db.serializableTransaction as any).mockImplementationOnce(async (fn: (q: any) => any) => {
      const mockQuery = async () => {
        const response = queryResponses[callIndex] ?? { rows: [], rowCount: 0 };
        callIndex++;
        return response;
      };
      return fn(mockQuery);
    });
  };

  it('returns added=true when all gates pass (happy path, primary)', async () => {
    setupTransaction([
      // 1. lock check — no rows (not locked)
      { rows: [], rowCount: 0 },
      // 2. count check — user has 0 expertise
      { rows: [{ count: '0' }], rowCount: 1 },
      // 3. dup check — no existing entry
      { rows: [], rowCount: 0 },
      // 4. capacity check — plenty of room, good ratio
      { rows: [makeCapRow()], rowCount: 1 },
      // 5. INSERT user_expertise
      { rows: [], rowCount: 1 },
      // 6. UPDATE expertise_capacity
      { rows: [], rowCount: 1 },
      // 7. INSERT expertise_change_log
      { rows: [], rowCount: 1 },
    ]);
    // _logGateEvent uses db.query (not the transaction query)
    (db.query as any).mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await ExpertiseSupplyService.addUserExpertise('user-1', 'exp-1', true);

    expect(result.success).toBe(true);
    expect(result.data!.added).toBe(true);
    expect(result.data!.waitlisted).toBe(false);
    expect(result.data!.detail).toContain('Primary');
  });

  it('returns added=true for secondary (isPrimary=false)', async () => {
    setupTransaction([
      { rows: [], rowCount: 0 },                 // lock check
      { rows: [{ count: '1' }], rowCount: 1 },   // count — 1 existing (< 2)
      { rows: [], rowCount: 0 },                 // dup check
      { rows: [makeCapRow()], rowCount: 1 },     // capacity
      { rows: [], rowCount: 1 },                 // INSERT user_expertise
      { rows: [], rowCount: 1 },                 // UPDATE capacity
      { rows: [], rowCount: 1 },                 // INSERT log
    ]);
    (db.query as any).mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await ExpertiseSupplyService.addUserExpertise('user-1', 'exp-1', false);

    expect(result.success).toBe(true);
    expect(result.data!.added).toBe(true);
    expect(result.data!.detail).toContain('Secondary');
  });

  it('returns added=false when 30-day lock is active', async () => {
    const futureDate = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
    setupTransaction([
      // lock check — has active lock
      { rows: [{ locked_until: futureDate }], rowCount: 1 },
    ]);
    (db.query as any).mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await ExpertiseSupplyService.addUserExpertise('user-1', 'exp-1');

    expect(result.success).toBe(true);
    expect(result.data!.added).toBe(false);
    expect(result.data!.waitlisted).toBe(false);
    expect(result.data!.detail).toContain('locked');
  });

  it('returns added=false when max expertise limit reached', async () => {
    setupTransaction([
      { rows: [], rowCount: 0 },                 // lock check — no lock
      { rows: [{ count: '2' }], rowCount: 1 },   // count — already at max 2
    ]);
    (db.query as any).mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await ExpertiseSupplyService.addUserExpertise('user-1', 'exp-1');

    expect(result.success).toBe(true);
    expect(result.data!.added).toBe(false);
    expect(result.data!.detail).toContain('Maximum');
  });

  it('returns added=false when expertise already active', async () => {
    setupTransaction([
      { rows: [], rowCount: 0 },                                              // lock check
      { rows: [{ count: '1' }], rowCount: 1 },                               // count
      { rows: [{ id: 'ue-1', status: 'active' }], rowCount: 1 },             // dup check — already active
    ]);
    (db.query as any).mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await ExpertiseSupplyService.addUserExpertise('user-1', 'exp-1');

    expect(result.success).toBe(true);
    expect(result.data!.added).toBe(false);
    expect(result.data!.detail).toContain('already');
  });

  it('returns added=false with cooldown when inactive entry is within cooldown period', async () => {
    // The inactive entry was updated recently (within the 7-day cooldown)
    const recentDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days ago
    setupTransaction([
      { rows: [], rowCount: 0 },                                               // lock check
      { rows: [{ count: '0' }], rowCount: 1 },                                // count
      { rows: [{ id: 'ue-old', status: 'inactive' }], rowCount: 1 },          // dup check — inactive
      { rows: [{ updated_at: recentDate }], rowCount: 1 },                    // cooldown check
    ]);
    (db.query as any).mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await ExpertiseSupplyService.addUserExpertise('user-1', 'exp-1');

    expect(result.success).toBe(true);
    expect(result.data!.added).toBe(false);
    expect(result.data!.detail).toContain('cooldown');
  });

  it('adds expertise after cooldown has passed (inactive entry deleted and re-inserted)', async () => {
    const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(); // 15 days ago (> 7-day cooldown)
    setupTransaction([
      { rows: [], rowCount: 0 },                                               // lock check
      { rows: [{ count: '0' }], rowCount: 1 },                                // count
      { rows: [{ id: 'ue-old', status: 'inactive' }], rowCount: 1 },          // dup check — inactive
      { rows: [{ updated_at: oldDate }], rowCount: 1 },                       // cooldown check — passed
      { rows: [], rowCount: 1 },                                               // DELETE old inactive record
      { rows: [makeCapRow()], rowCount: 1 },                                   // capacity check
      { rows: [], rowCount: 1 },                                               // INSERT user_expertise
      { rows: [], rowCount: 1 },                                               // UPDATE capacity
      { rows: [], rowCount: 1 },                                               // INSERT log
    ]);
    (db.query as any).mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await ExpertiseSupplyService.addUserExpertise('user-1', 'exp-1', true);

    expect(result.success).toBe(true);
    expect(result.data!.added).toBe(true);
  });

  it('returns waitlisted=true when hard cap is exceeded', async () => {
    const fullCap = makeCapRow({ current_weight: '10', max_weight_capacity: '10' });
    setupTransaction([
      { rows: [], rowCount: 0 },              // lock check
      { rows: [{ count: '0' }], rowCount: 1 }, // count
      { rows: [], rowCount: 0 },              // dup check
      { rows: [fullCap], rowCount: 1 },       // capacity — full
      { rows: [], rowCount: 1 },              // INSERT waitlist
    ]);
    (db.query as any).mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await ExpertiseSupplyService.addUserExpertise('user-1', 'exp-1');

    expect(result.success).toBe(true);
    expect(result.data!.added).toBe(false);
    expect(result.data!.waitlisted).toBe(true);
    expect(result.data!.detail).toContain('waitlist');
  });

  it('returns waitlisted=true when ratio gate fails', async () => {
    const lowRatioCap = makeCapRow({ liquidity_ratio: '0.1', min_task_to_supply_ratio: '0.5', active_hustlers: '5' });
    setupTransaction([
      { rows: [], rowCount: 0 },              // lock check
      { rows: [{ count: '0' }], rowCount: 1 }, // count
      { rows: [], rowCount: 0 },              // dup check
      { rows: [lowRatioCap], rowCount: 1 },   // capacity — low ratio
      { rows: [], rowCount: 1 },              // INSERT waitlist
    ]);
    (db.query as any).mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await ExpertiseSupplyService.addUserExpertise('user-1', 'exp-1');

    expect(result.success).toBe(true);
    expect(result.data!.waitlisted).toBe(true);
  });

  it('returns error when no capacity record found', async () => {
    setupTransaction([
      { rows: [], rowCount: 0 },              // lock check
      { rows: [{ count: '0' }], rowCount: 1 }, // count
      { rows: [], rowCount: 0 },              // dup check
      { rows: [], rowCount: 0 },              // capacity — not found
    ]);
    (db.query as any).mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await ExpertiseSupplyService.addUserExpertise('user-1', 'exp-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_CAPACITY_RECORD');
  });

  it('handles HX901 trigger violation (max 2 expertise) gracefully', async () => {
    (db.serializableTransaction as any).mockRejectedValueOnce(new Error('HX901: max expertise exceeded'));

    const result = await ExpertiseSupplyService.addUserExpertise('user-1', 'exp-1');

    expect(result.success).toBe(true);
    expect(result.data!.added).toBe(false);
    expect(result.data!.detail).toContain('Maximum');
  });

  it('returns failure when serializableTransaction throws a generic error', async () => {
    (db.serializableTransaction as any).mockRejectedValueOnce(new Error('DB Error'));

    const result = await ExpertiseSupplyService.addUserExpertise('user-1', 'exp-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ADD_EXPERTISE_FAILED');
  });
});

// ============================================================================
// removeUserExpertise
// ============================================================================

describe('ExpertiseSupplyService.removeUserExpertise', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const setupTransaction = (queryResponses: Array<{ rows: unknown[]; rowCount?: number }>) => {
    let callIndex = 0;
    (db.serializableTransaction as any).mockImplementationOnce(async (fn: (q: any) => any) => {
      const mockQuery = async () => {
        const response = queryResponses[callIndex] ?? { rows: [], rowCount: 0 };
        callIndex++;
        return response;
      };
      return fn(mockQuery);
    });
  };

  it('returns removed=true when expertise is found and not locked', async () => {
    setupTransaction([
      // existing check — found, not locked
      { rows: [{ id: 'ue-1', slot_weight: '0.7', effective_weight: '0.7', locked_until: null, status: 'active' }], rowCount: 1 },
      // UPDATE user_expertise to inactive
      { rows: [], rowCount: 1 },
      // UPDATE expertise_capacity
      { rows: [], rowCount: 1 },
      // INSERT expertise_change_log
      { rows: [], rowCount: 1 },
    ]);

    const result = await ExpertiseSupplyService.removeUserExpertise('user-1', 'exp-1');

    expect(result.success).toBe(true);
    expect(result.data!.removed).toBe(true);
    expect(result.data!.detail).toContain('removed');
  });

  it('returns removed=false when expertise is not on profile', async () => {
    setupTransaction([
      { rows: [], rowCount: 0 }, // not found
    ]);

    const result = await ExpertiseSupplyService.removeUserExpertise('user-1', 'exp-1');

    expect(result.success).toBe(true);
    expect(result.data!.removed).toBe(false);
    expect(result.data!.detail).toContain('not found');
  });

  it('returns removed=false when expertise is still locked', async () => {
    const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    setupTransaction([
      { rows: [{ id: 'ue-1', slot_weight: '0.7', effective_weight: '0.7', locked_until: futureDate, status: 'active' }], rowCount: 1 },
    ]);

    const result = await ExpertiseSupplyService.removeUserExpertise('user-1', 'exp-1');

    expect(result.success).toBe(true);
    expect(result.data!.removed).toBe(false);
    expect(result.data!.detail).toContain('locked');
  });

  it('returns failure when serializableTransaction throws', async () => {
    (db.serializableTransaction as any).mockRejectedValueOnce(new Error('DB Error'));

    const result = await ExpertiseSupplyService.removeUserExpertise('user-1', 'exp-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('REMOVE_EXPERTISE_FAILED');
  });
});

// ============================================================================
// promoteExpertise
// ============================================================================

describe('ExpertiseSupplyService.promoteExpertise', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const setupTransaction = (queryResponses: Array<{ rows: unknown[]; rowCount?: number }>) => {
    let callIndex = 0;
    (db.serializableTransaction as any).mockImplementationOnce(async (fn: (q: any) => any) => {
      const mockQuery = async () => {
        const response = queryResponses[callIndex] ?? { rows: [], rowCount: 0 };
        callIndex++;
        return response;
      };
      return fn(mockQuery);
    });
  };

  const primaryEntry = { id: 'ue-primary', expertise_id: 'exp-primary', slot_weight: '0.7', is_primary: true, locked_until: null };
  const secondaryEntry = { id: 'ue-secondary', expertise_id: 'exp-secondary', slot_weight: '0.3', is_primary: false, locked_until: null };

  it('returns promoted=true on successful promotion swap', async () => {
    setupTransaction([
      // entries — both entries fetched
      { rows: [primaryEntry, secondaryEntry], rowCount: 2 },
      // UPDATE: promote secondary to primary
      { rows: [], rowCount: 1 },
      // UPDATE: demote primary to secondary
      { rows: [], rowCount: 1 },
      // UPDATE capacity for promoted expertise
      { rows: [], rowCount: 1 },
      // UPDATE capacity for demoted expertise
      { rows: [], rowCount: 1 },
      // INSERT log for promoted
      { rows: [], rowCount: 1 },
      // INSERT log for demoted
      { rows: [], rowCount: 1 },
    ]);

    const result = await ExpertiseSupplyService.promoteExpertise('user-1', 'exp-secondary');

    expect(result.success).toBe(true);
    expect(result.data!.promoted).toBe(true);
    expect(result.data!.detail).toContain('swapped');
  });

  it('returns promoted=false when user has fewer than 2 expertise', async () => {
    setupTransaction([
      { rows: [primaryEntry], rowCount: 1 }, // only one entry
    ]);

    const result = await ExpertiseSupplyService.promoteExpertise('user-1', 'exp-secondary');

    expect(result.success).toBe(true);
    expect(result.data!.promoted).toBe(false);
    expect(result.data!.detail).toContain('two expertise');
  });

  it('returns promoted=false when one entry is locked', async () => {
    const futureLock = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const lockedPrimary = { ...primaryEntry, locked_until: futureLock };
    setupTransaction([
      { rows: [lockedPrimary, secondaryEntry], rowCount: 2 },
    ]);

    const result = await ExpertiseSupplyService.promoteExpertise('user-1', 'exp-secondary');

    expect(result.success).toBe(true);
    expect(result.data!.promoted).toBe(false);
    expect(result.data!.detail).toContain('locked');
  });

  it('returns promoted=false when expertise to promote is not in selections', async () => {
    setupTransaction([
      { rows: [primaryEntry, secondaryEntry], rowCount: 2 },
    ]);

    const result = await ExpertiseSupplyService.promoteExpertise('user-1', 'exp-nonexistent');

    expect(result.success).toBe(true);
    expect(result.data!.promoted).toBe(false);
    expect(result.data!.detail).toContain('not found');
  });

  it('returns promoted=false when expertise to promote is already primary', async () => {
    setupTransaction([
      { rows: [primaryEntry, secondaryEntry], rowCount: 2 },
    ]);

    const result = await ExpertiseSupplyService.promoteExpertise('user-1', 'exp-primary');

    expect(result.success).toBe(true);
    expect(result.data!.promoted).toBe(false);
    expect(result.data!.detail).toContain('already your primary');
  });

  it('returns failure when serializableTransaction throws', async () => {
    (db.serializableTransaction as any).mockRejectedValueOnce(new Error('DB Error'));

    const result = await ExpertiseSupplyService.promoteExpertise('user-1', 'exp-secondary');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PROMOTE_EXPERTISE_FAILED');
  });
});

// ============================================================================
// getUserWaitlist
// ============================================================================

describe('ExpertiseSupplyService.getUserWaitlist', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns success with mapped waitlist entries', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [makeWaitlistRow()],
      rowCount: 1,
    });

    const result = await ExpertiseSupplyService.getUserWaitlist('user-1');

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    const item = result.data![0];
    expect(item.id).toBe('wl-1');
    expect(item.expertiseSlug).toBe('plumbing');
    expect(item.expertiseDisplayName).toBe('Plumbing');
    expect(item.geoZone).toBe('seattle_metro');
    expect(item.position).toBe(1);
    expect(item.requestedWeight).toBe(0.7);
    expect(item.status).toBe('waiting');
  });

  it('returns success with empty array when user has no waitlist entries', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await ExpertiseSupplyService.getUserWaitlist('user-1');
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  });

  it('returns failure when db.query throws', async () => {
    (db.query as any).mockRejectedValueOnce(new Error('DB Error'));
    const result = await ExpertiseSupplyService.getUserWaitlist('user-1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GET_WAITLIST_FAILED');
  });
});

// ============================================================================
// acceptWaitlistInvite
// ============================================================================

describe('ExpertiseSupplyService.acceptWaitlistInvite', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const setupTransaction = (queryResponses: Array<{ rows: unknown[]; rowCount?: number }>) => {
    let callIndex = 0;
    (db.serializableTransaction as any).mockImplementationOnce(async (fn: (q: any) => any) => {
      const mockQuery = async () => {
        const response = queryResponses[callIndex] ?? { rows: [], rowCount: 0 };
        callIndex++;
        return response;
      };
      return fn(mockQuery);
    });
  };

  const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const waitlistEntryRow = {
    id: 'wl-1',
    expertise_id: 'exp-1',
    geo_zone: 'seattle_metro',
    requested_weight: '0.7',
    status: 'invited',
    invite_expires_at: futureExpiry,
  };

  it('returns accepted=true on successful invite acceptance', async () => {
    setupTransaction([
      // waitlist entry lookup
      { rows: [waitlistEntryRow], rowCount: 1 },
      // capacity re-check
      { rows: [makeCapRow()], rowCount: 1 },
      // INSERT user_expertise
      { rows: [], rowCount: 1 },
      // UPDATE expertise_capacity
      { rows: [], rowCount: 1 },
      // UPDATE waitlist to accepted
      { rows: [], rowCount: 1 },
      // INSERT change log
      { rows: [], rowCount: 1 },
    ]);

    const result = await ExpertiseSupplyService.acceptWaitlistInvite('user-1', 'wl-1');

    expect(result.success).toBe(true);
    expect(result.data!.accepted).toBe(true);
    expect(result.data!.detail).toContain('Welcome');
  });

  it('returns accepted=false when waitlist entry not found', async () => {
    setupTransaction([{ rows: [], rowCount: 0 }]);

    const result = await ExpertiseSupplyService.acceptWaitlistInvite('user-1', 'wl-999');

    expect(result.success).toBe(true);
    expect(result.data!.accepted).toBe(false);
    expect(result.data!.detail).toContain('not found');
  });

  it('returns accepted=false when status is not "invited"', async () => {
    setupTransaction([
      { rows: [{ ...waitlistEntryRow, status: 'waiting' }], rowCount: 1 },
    ]);

    const result = await ExpertiseSupplyService.acceptWaitlistInvite('user-1', 'wl-1');

    expect(result.success).toBe(true);
    expect(result.data!.accepted).toBe(false);
    expect(result.data!.detail).toContain('waiting');
  });

  it('returns accepted=false when invitation has expired', async () => {
    const pastExpiry = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    setupTransaction([
      { rows: [{ ...waitlistEntryRow, invite_expires_at: pastExpiry }], rowCount: 1 },
      // UPDATE waitlist to expired
      { rows: [], rowCount: 1 },
    ]);

    const result = await ExpertiseSupplyService.acceptWaitlistInvite('user-1', 'wl-1');

    expect(result.success).toBe(true);
    expect(result.data!.accepted).toBe(false);
    expect(result.data!.detail).toContain('expired');
  });

  it('returns accepted=false when capacity was filled during invite window', async () => {
    const fullCap = makeCapRow({ current_weight: '10', max_weight_capacity: '10' });
    setupTransaction([
      { rows: [waitlistEntryRow], rowCount: 1 },
      { rows: [fullCap], rowCount: 1 }, // capacity full
    ]);

    const result = await ExpertiseSupplyService.acceptWaitlistInvite('user-1', 'wl-1');

    expect(result.success).toBe(true);
    expect(result.data!.accepted).toBe(false);
    expect(result.data!.detail).toContain('filled');
  });

  it('returns error when capacity record not found during accept', async () => {
    setupTransaction([
      { rows: [waitlistEntryRow], rowCount: 1 },
      { rows: [], rowCount: 0 }, // no capacity record
    ]);

    const result = await ExpertiseSupplyService.acceptWaitlistInvite('user-1', 'wl-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_CAPACITY');
  });

  it('returns failure when serializableTransaction throws', async () => {
    (db.serializableTransaction as any).mockRejectedValueOnce(new Error('DB Error'));

    const result = await ExpertiseSupplyService.acceptWaitlistInvite('user-1', 'wl-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ACCEPT_WAITLIST_FAILED');
  });
});

// ============================================================================
// recalculateAllCapacity
// ============================================================================

describe('ExpertiseSupplyService.recalculateAllCapacity', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns success with processed/expanded/invitesSent counts', async () => {
    // Call sequence for a single capacity record:
    // 1. Get all capacity records
    // 2. UPDATE user_expertise decay (14d)
    // 3. UPDATE user_expertise decay (30d)
    // 4. UPDATE user_expertise decay (never accepted)
    // 5. Task counts query
    // 6. Supply weight query
    // 7. UPDATE activity tracking
    // 8. P95 query (no expansion needed — p95 < threshold)
    // 9. UPDATE expertise_capacity
    // 10. Waitlist check (capacity available, no waiters)
    // 11. Expire stale waitlist invitations

    const mockDbQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'cap-1', expertise_id: 'exp-1', geo_zone: 'seattle_metro', max_weight_capacity: '10', min_task_to_supply_ratio: '0.5' }], rowCount: 1 }) // 1. capacity records
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 2. decay 14d
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 3. decay 30d
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 4. decay never accepted
      .mockResolvedValueOnce({ rows: [{ open_count: '10', completed_count: '8' }], rowCount: 1 }) // 5. task counts
      .mockResolvedValueOnce({ rows: [{ total_weight: '5', active_count: '6' }], rowCount: 1 }) // 6. supply weight
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 7. activity tracking UPDATE
      .mockResolvedValueOnce({ rows: [{ p95_hours: '2', sample_count: '5' }], rowCount: 1 }) // 8. p95 (below threshold, no expand)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 9. UPDATE expertise_capacity
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 10. waitlist check (no waiters)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // 11. expire stale invitations

    (db.query as any).mockImplementation(mockDbQuery);

    const result = await ExpertiseSupplyService.recalculateAllCapacity();

    expect(result.success).toBe(true);
    expect(result.data!.processed).toBe(1);
    expect(result.data!.expanded).toBe(0);
    expect(result.data!.invitesSent).toBeGreaterThanOrEqual(0);
  });

  it('returns expanded=1 when P95 acceptance time exceeds threshold with sufficient sample size', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [{ id: 'cap-1', expertise_id: 'exp-1', geo_zone: 'seattle_metro', max_weight_capacity: '10', min_task_to_supply_ratio: '0.5' }], rowCount: 1 }) // capacity records
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // decay 14d
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // decay 30d
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // decay never accepted
      .mockResolvedValueOnce({ rows: [{ open_count: '20', completed_count: '15' }], rowCount: 1 }) // task counts
      .mockResolvedValueOnce({ rows: [{ total_weight: '8', active_count: '10' }], rowCount: 1 }) // supply weight
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // activity UPDATE
      .mockResolvedValueOnce({ rows: [{ p95_hours: '8', sample_count: '15' }], rowCount: 1 }) // p95 > 6h, sample >= 10 → expand
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE capacity
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // waitlist check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // expire stale

    const result = await ExpertiseSupplyService.recalculateAllCapacity();

    expect(result.success).toBe(true);
    expect(result.data!.expanded).toBe(1);
  });

  it('does NOT auto-expand when P95 exceeds threshold but sample size is too small', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [{ id: 'cap-1', expertise_id: 'exp-1', geo_zone: 'seattle_metro', max_weight_capacity: '10', min_task_to_supply_ratio: '0.5' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ open_count: '5', completed_count: '4' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ total_weight: '3', active_count: '4' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ p95_hours: '9', sample_count: '5' }], rowCount: 1 }) // p95 > 6h but sample < 10
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await ExpertiseSupplyService.recalculateAllCapacity();

    expect(result.success).toBe(true);
    expect(result.data!.expanded).toBe(0);
  });

  it('returns success with processed=0 when no capacity records exist', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })    // no capacity records
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });   // expire stale invitations

    const result = await ExpertiseSupplyService.recalculateAllCapacity();

    expect(result.success).toBe(true);
    expect(result.data!.processed).toBe(0);
    expect(result.data!.expanded).toBe(0);
    expect(result.data!.invitesSent).toBe(0);
  });

  it('returns failure when db.query throws', async () => {
    (db.query as any).mockRejectedValueOnce(new Error('DB Error'));

    const result = await ExpertiseSupplyService.recalculateAllCapacity();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('RECALCULATE_FAILED');
  });
});

// ============================================================================
// getSupplyDashboard
// ============================================================================

describe('ExpertiseSupplyService.getSupplyDashboard', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const makeDashboardRow = (overrides: Record<string, unknown> = {}) => ({
    expertise_id: 'exp-1',
    slug: 'plumbing',
    display_name: 'Plumbing',
    geo_zone: 'seattle_metro',
    max_weight_capacity: '10',
    current_weight: '4',
    active_hustlers: '5',
    open_tasks_7d: '20',
    completed_tasks_7d: '15',
    liquidity_ratio: '0.8',
    open_ratio: '0.5',
    min_task_to_supply_ratio: '0.5',
    auto_expand_pct: '0',
    auto_expand_expires_at: null,
    last_recalc_at: '2025-01-01T00:00:00Z',
    waitlist_count: '3',
    ...overrides,
  });

  it('returns success with expertise list and totals', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [makeDashboardRow()],
      rowCount: 1,
    });

    const result = await ExpertiseSupplyService.getSupplyDashboard();

    expect(result.success).toBe(true);
    expect(result.data!.expertise).toHaveLength(1);
    const e = result.data!.expertise[0];
    expect(e.expertiseId).toBe('exp-1');
    expect(e.expertiseSlug).toBe('plumbing');
    expect(e.maxWeightCapacity).toBe(10);
    expect(e.currentWeight).toBe(4);
    expect(e.activeHustlers).toBe(5);
    expect(e.isAcceptingNew).toBe(true);
    expect(e.waitlistLength).toBe(3);

    const totals = result.data!.totals;
    expect(totals.totalActiveHustlers).toBe(5);
    expect(totals.totalEffectiveWeight).toBe(4);
    expect(totals.totalOpenTasks7d).toBe(20);
    expect(totals.totalWaitlisted).toBe(3);
  });

  it('calculates totals correctly across multiple expertise', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [
        makeDashboardRow({ active_hustlers: '5', current_weight: '4', open_tasks_7d: '20', waitlist_count: '3' }),
        makeDashboardRow({ expertise_id: 'exp-2', slug: 'electrical', display_name: 'Electrical', active_hustlers: '3', current_weight: '2', open_tasks_7d: '10', waitlist_count: '1' }),
      ],
      rowCount: 2,
    });

    const result = await ExpertiseSupplyService.getSupplyDashboard();

    expect(result.success).toBe(true);
    expect(result.data!.expertise).toHaveLength(2);
    const totals = result.data!.totals;
    expect(totals.totalActiveHustlers).toBe(8);
    expect(totals.totalEffectiveWeight).toBe(6);
    expect(totals.totalOpenTasks7d).toBe(30);
    expect(totals.totalWaitlisted).toBe(4);
  });

  it('sets blockReason="At capacity" when at hard cap', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [makeDashboardRow({ current_weight: '10', max_weight_capacity: '10' })],
      rowCount: 1,
    });

    const result = await ExpertiseSupplyService.getSupplyDashboard();

    expect(result.success).toBe(true);
    expect(result.data!.expertise[0].isAcceptingNew).toBe(false);
    expect(result.data!.expertise[0].blockReason).toBe('At capacity');
  });

  it('sets blockReason="Low task throughput" when ratio gate fails', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [makeDashboardRow({ liquidity_ratio: '0.1', min_task_to_supply_ratio: '0.5', current_weight: '5', max_weight_capacity: '10', active_hustlers: '3' })],
      rowCount: 1,
    });

    const result = await ExpertiseSupplyService.getSupplyDashboard();

    expect(result.success).toBe(true);
    expect(result.data!.expertise[0].isAcceptingNew).toBe(false);
    expect(result.data!.expertise[0].blockReason).toBe('Low task throughput');
  });

  it('returns success with empty expertise and zero totals when no rows', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await ExpertiseSupplyService.getSupplyDashboard();

    expect(result.success).toBe(true);
    expect(result.data!.expertise).toHaveLength(0);
    expect(result.data!.totals.totalActiveHustlers).toBe(0);
    expect(result.data!.totals.overallLiquidityRatio).toBe(0);
  });

  it('returns failure when db.query throws', async () => {
    (db.query as any).mockRejectedValueOnce(new Error('DB Error'));

    const result = await ExpertiseSupplyService.getSupplyDashboard();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SUPPLY_DASHBOARD_FAILED');
  });

  it('uses default geoZone seattle_metro when not provided', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await ExpertiseSupplyService.getSupplyDashboard();
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// adminUpdateCapacity
// ============================================================================

describe('ExpertiseSupplyService.adminUpdateCapacity', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns updated=true when maxWeightCapacity is provided', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE
    (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT admin_actions

    const result = await ExpertiseSupplyService.adminUpdateCapacity(
      'exp-1', 'seattle_metro', { maxWeightCapacity: 20 }, 'admin-1'
    );

    expect(result.success).toBe(true);
    expect(result.data!.updated).toBe(true);
  });

  it('returns updated=true when minTaskToSupplyRatio is provided', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE
    (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT admin_actions

    const result = await ExpertiseSupplyService.adminUpdateCapacity(
      'exp-1', 'seattle_metro', { minTaskToSupplyRatio: 0.8 }, 'admin-1'
    );

    expect(result.success).toBe(true);
    expect(result.data!.updated).toBe(true);
  });

  it('returns updated=true when both fields are provided', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 });
    (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await ExpertiseSupplyService.adminUpdateCapacity(
      'exp-1', 'seattle_metro', { maxWeightCapacity: 15, minTaskToSupplyRatio: 0.6 }, 'admin-1'
    );

    expect(result.success).toBe(true);
    expect(result.data!.updated).toBe(true);
  });

  it('returns updated=false (no DB call) when no fields are provided', async () => {
    const result = await ExpertiseSupplyService.adminUpdateCapacity(
      'exp-1', 'seattle_metro', {}, 'admin-1'
    );

    expect(result.success).toBe(true);
    expect(result.data!.updated).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns failure when db.query throws', async () => {
    (db.query as any).mockRejectedValueOnce(new Error('DB Error'));

    const result = await ExpertiseSupplyService.adminUpdateCapacity(
      'exp-1', 'seattle_metro', { maxWeightCapacity: 20 }, 'admin-1'
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ADMIN_UPDATE_FAILED');
    expect(result.error?.message).toBe('DB Error');
  });
});
