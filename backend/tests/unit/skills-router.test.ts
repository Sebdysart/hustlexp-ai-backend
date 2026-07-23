/**
 * Skills Router Unit Tests
 *
 * Tests all tRPC procedures on the skills router:
 * - getCategories (public)
 * - getSkills (public)
 * - addSkills (protected)
 * - removeSkill (protected)
 * - getMySkills (protected)
 * - submitLicense (protected)
 * - getLicenseSubmissions (protected)
 * - checkTaskEligibility (protected)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/services/WorkerSkillService', () => ({
  WorkerSkillService: {
    getCategories: vi.fn(),
    getSkills: vi.fn(),
    addSkills: vi.fn(),
    removeSkill: vi.fn(),
    getWorkerSkills: vi.fn(),
    submitLicense: vi.fn(),
    checkTaskEligibility: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { skillsRouter } from '../../src/routers/skills';
import { WorkerSkillService } from '../../src/services/WorkerSkillService';

const mockDb = vi.mocked(db);
const mockService = vi.mocked(WorkerSkillService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_UUID = '11111111-1111-1111-1111-111111111111';
const TEST_UUID_2 = '22222222-2222-2222-2222-222222222222';

function makeCaller(authenticated = true) {
  const ctx: any = authenticated
    ? { user: { id: 'test-uid', email: 'test@test.com', default_mode: 'worker' }, firebaseUid: 'fb-uid' }
    : { user: null, firebaseUid: null };
  return skillsRouter.createCaller(ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('skills.getCategories', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns categories from WorkerSkillService', async () => {
    const categories = [{ id: '1', name: 'Cleaning' }, { id: '2', name: 'Moving' }];
    mockService.getCategories.mockResolvedValueOnce(categories);

    const result = await makeCaller(false).getCategories();

    expect(result).toEqual(categories);
    expect(mockService.getCategories).toHaveBeenCalledOnce();
  });
});

describe('skills.getSkills', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns skills without category filter', async () => {
    const skills = [{ id: '1', name: 'Vacuuming' }];
    mockService.getSkills.mockResolvedValueOnce(skills);

    const result = await makeCaller(false).getSkills();

    expect(result).toEqual(skills);
    expect(mockService.getSkills).toHaveBeenCalledWith(undefined);
  });

  it('passes categoryId to service when provided', async () => {
    mockService.getSkills.mockResolvedValueOnce([]);

    await makeCaller(false).getSkills({ categoryId: TEST_UUID });

    expect(mockService.getSkills).toHaveBeenCalledWith(TEST_UUID);
  });
});

describe('skills.addSkills', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds skills for authenticated user', async () => {
    mockService.addSkills.mockResolvedValueOnce({ added: 2 });

    const result = await makeCaller().addSkills({ skillIds: [TEST_UUID, TEST_UUID_2] });

    expect(result).toEqual({ added: 2 });
    expect(mockService.addSkills).toHaveBeenCalledWith('test-uid', [TEST_UUID, TEST_UUID_2]);
  });

  it('rejects unauthenticated users', async () => {
    await expect(
      makeCaller(false).addSkills({ skillIds: [TEST_UUID] })
    ).rejects.toThrow();
  });
});

describe('skills.removeSkill', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes a skill for authenticated user', async () => {
    mockService.removeSkill.mockResolvedValueOnce({ removed: true });

    const result = await makeCaller().removeSkill({ skillId: TEST_UUID });

    expect(result).toEqual({ removed: true });
    expect(mockService.removeSkill).toHaveBeenCalledWith('test-uid', TEST_UUID);
  });
});

describe('skills.getMySkills', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns worker skills for authenticated user', async () => {
    const skills = [{ id: TEST_UUID, name: 'Cleaning', verified: true }];
    mockService.getWorkerSkills.mockResolvedValueOnce(skills);

    const result = await makeCaller().getMySkills();

    expect(result).toEqual(skills);
    expect(mockService.getWorkerSkills).toHaveBeenCalledWith('test-uid');
  });
});

describe('skills.submitLicense', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects licenseUrl without calling the legacy service', async () => {
    await expect(makeCaller().submitLicense({
      skillId: TEST_UUID,
      licenseUrl: 'https://example.com/license.jpg',
    })).rejects.toThrow('Direct skill-license media URLs are disabled');
    expect(mockService.submitLicense).not.toHaveBeenCalled();
  });

  it('rejects the legacy photoUrl fallback', async () => {
    await expect(makeCaller().submitLicense({
      skillId: TEST_UUID,
      photoUrl: 'https://example.com/photo.jpg',
    })).rejects.toThrow('Direct skill-license media URLs are disabled');
    expect(mockService.submitLicense).not.toHaveBeenCalled();
  });

  it('keeps the legacy endpoint closed without a URL', async () => {
    await expect(
      makeCaller().submitLicense({ skillId: TEST_UUID })
    ).rejects.toThrow('Direct skill-license media URLs are disabled');
  });

  it('does not let an expiry field revive direct URL ingestion', async () => {
    const expiry = '2026-12-31T00:00:00.000Z';

    await expect(makeCaller().submitLicense({
      skillId: TEST_UUID,
      licenseUrl: 'https://example.com/license.jpg',
      licenseExpiry: expiry,
    })).rejects.toThrow('Direct skill-license media URLs are disabled');
    expect(mockService.submitLicense).not.toHaveBeenCalled();
  });
});

describe('skills.getLicenseSubmissions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns license submissions from db', async () => {
    const rows = [
      {
        id: '1',
        skillId: TEST_UUID,
        skillName: 'Electrical',
        photoUrl: 'https://example.com/photo.jpg',
        licenseVerified: true,
        reviewedAt: new Date(),
        submittedAt: new Date(),
      },
    ];
    mockDb.query.mockResolvedValueOnce({ rows, rowCount: 1 } as any);

    const result = await makeCaller().getLicenseSubmissions();

    expect(result).toEqual(rows);
    expect(mockDb.query).toHaveBeenCalledOnce();
    const [sql, params] = (mockDb.query as any).mock.calls[0];
    expect(sql).toContain('worker_skills');
    expect(params).toEqual(['test-uid']);
  });

  it('returns empty array when no submissions', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await makeCaller().getLicenseSubmissions();

    expect(result).toEqual([]);
  });
});

describe('skills.checkTaskEligibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('checks eligibility for a task', async () => {
    const eligibility = { eligible: true, missingSkills: [] };
    mockService.checkTaskEligibility.mockResolvedValueOnce(eligibility);

    const result = await makeCaller().checkTaskEligibility({ taskId: TEST_UUID });

    expect(result).toEqual(eligibility);
    expect(mockService.checkTaskEligibility).toHaveBeenCalledWith('test-uid', TEST_UUID);
  });

  it('returns ineligible result', async () => {
    const eligibility = { eligible: false, missingSkills: ['Plumbing'] };
    mockService.checkTaskEligibility.mockResolvedValueOnce(eligibility);

    const result = await makeCaller().checkTaskEligibility({ taskId: TEST_UUID });

    expect(result.eligible).toBe(false);
    expect(result.missingSkills).toContain('Plumbing');
  });
});
