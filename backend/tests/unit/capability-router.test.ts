/**
 * Capability Router Unit Tests
 *
 * Tests tRPC procedures:
 * - getProfile, getSummary, hasCapability, recomputeProfile
 * - checkEligibility
 * - queryFeed, getNearbyTasks
 * - submitLicense, getLicenses, approveLicense, rejectLicense, getPendingLicenses
 * - submitInsurance, getInsurance
 * - initiateBackgroundCheck, getBackgroundCheck
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

vi.mock('../../src/services/CapabilityProfileService', () => ({
  getCapabilityProfile: vi.fn(),
  getCapabilitySummary: vi.fn(),
  hasCapability: vi.fn(),
  recompute: vi.fn(),
}));

vi.mock('../../src/services/EligibilityResolverService', () => ({
  isEligible: vi.fn(),
}));

vi.mock('../../src/services/FeedQueryService', () => ({
  queryFeed: vi.fn(),
  getNearbyTasks: vi.fn(),
}));

vi.mock('../../src/services/LicenseVerificationService', () => ({
  submitLicense: vi.fn(),
  getUserLicenses: vi.fn(),
  approveLicense: vi.fn(),
  rejectLicense: vi.fn(),
  getPendingVerifications: vi.fn(),
}));

vi.mock('../../src/services/InsuranceVerificationService', () => ({
  submitInsurance: vi.fn(),
  getUserInsurance: vi.fn(),
}));

vi.mock('../../src/services/BackgroundCheckService', () => ({
  initiateBackgroundCheck: vi.fn(),
  getUserBackgroundCheck: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { capabilityRouter } from '../../src/routers/capability';
import * as CapabilityProfileService from '../../src/services/CapabilityProfileService';
import * as EligibilityResolverService from '../../src/services/EligibilityResolverService';
import * as FeedQueryService from '../../src/services/FeedQueryService';
import * as LicenseVerificationService from '../../src/services/LicenseVerificationService';
import * as InsuranceVerificationService from '../../src/services/InsuranceVerificationService';
import * as BackgroundCheckService from '../../src/services/BackgroundCheckService';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaller(userId = 'test-uid') {
  return capabilityRouter.createCaller({
    user: { id: userId } as any,
    firebaseUid: 'fb-uid',
  });
}

// ---------------------------------------------------------------------------
// Tests — Capability Profile
// ---------------------------------------------------------------------------

describe('capability.getProfile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns user capability profile', async () => {
    const profile = { trades: ['plumbing'], states: ['CA'] };
    vi.mocked(CapabilityProfileService.getCapabilityProfile).mockResolvedValueOnce(profile as any);

    const result = await makeCaller().getProfile();

    expect(result).toEqual(profile);
    expect(CapabilityProfileService.getCapabilityProfile).toHaveBeenCalledWith('test-uid');
  });
});

describe('capability.getSummary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns capability summary', async () => {
    const summary = { totalCapabilities: 5 };
    vi.mocked(CapabilityProfileService.getCapabilitySummary).mockResolvedValueOnce(summary as any);

    const result = await makeCaller().getSummary();

    expect(result).toEqual(summary);
  });
});

describe('capability.hasCapability', () => {
  beforeEach(() => vi.clearAllMocks());

  it('checks capability for trade and state', async () => {
    vi.mocked(CapabilityProfileService.hasCapability).mockResolvedValueOnce(true as any);

    const result = await makeCaller().hasCapability({ trade: 'plumbing', state: 'CA' });

    expect(result).toBe(true);
    expect(CapabilityProfileService.hasCapability).toHaveBeenCalledWith(
      'test-uid', 'plumbing', 'CA', undefined
    );
  });

  it('passes riskLevel when provided', async () => {
    vi.mocked(CapabilityProfileService.hasCapability).mockResolvedValueOnce(false as any);

    await makeCaller().hasCapability({ trade: 'electrical', state: 'NY', riskLevel: 'high' });

    expect(CapabilityProfileService.hasCapability).toHaveBeenCalledWith(
      'test-uid', 'electrical', 'NY', 'high'
    );
  });
});

describe('capability.recomputeProfile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('triggers recompute and returns success', async () => {
    vi.mocked(CapabilityProfileService.recompute).mockResolvedValueOnce(undefined as any);

    const result = await makeCaller().recomputeProfile();

    expect(result).toEqual({ success: true });
    expect(CapabilityProfileService.recompute).toHaveBeenCalledWith('test-uid', 'user_requested');
  });
});

// ---------------------------------------------------------------------------
// Tests — Eligibility
// ---------------------------------------------------------------------------

describe('capability.checkEligibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('checks eligibility for a task', async () => {
    // Task query
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        trade_type: 'plumbing',
        location_state: 'CA',
        location_city: 'LA',
        risk_level: 'low',
        insurance_required: false,
        background_check_required: false,
      }],
      rowCount: 1,
    } as any);
    // User context query
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        account_age_days: 30,
        trust_tier: 2,
        active_task_count: 1,
        has_active_dispute: false,
      }],
      rowCount: 1,
    } as any);

    const profile = { trades: ['plumbing'] };
    vi.mocked(CapabilityProfileService.getCapabilityProfile).mockResolvedValueOnce(profile as any);
    vi.mocked(EligibilityResolverService.isEligible).mockReturnValueOnce({ eligible: true } as any);

    const result = await makeCaller().checkEligibility({ taskId: 'task-1' });

    expect(result).toEqual({ eligible: true });
  });

  it('throws NOT_FOUND when task not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().checkEligibility({ taskId: 'nonexistent' })
    ).rejects.toThrow('Task not found');
  });

  it('throws NOT_FOUND when user not found', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ trade_type: 'plumbing', location_state: 'CA', risk_level: 'low', insurance_required: false, background_check_required: false }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().checkEligibility({ taskId: 'task-1' })
    ).rejects.toThrow('User not found');
  });
});

// ---------------------------------------------------------------------------
// Tests — Feed
// ---------------------------------------------------------------------------

describe('capability.queryFeed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries task feed with default params', async () => {
    const profile = { trades: [] };
    vi.mocked(CapabilityProfileService.getCapabilityProfile).mockResolvedValueOnce(profile as any);
    const feedData = { tasks: [], total: 0 };
    vi.mocked(FeedQueryService.queryFeed).mockResolvedValueOnce(feedData as any);

    const result = await makeCaller().queryFeed({ limit: 20 });

    expect(result).toEqual(feedData);
  });
});

describe('capability.getNearbyTasks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns nearby tasks', async () => {
    const tasks = [{ id: 'task-1', title: 'Fix sink' }];
    vi.mocked(FeedQueryService.getNearbyTasks).mockResolvedValueOnce(tasks as any);

    const result = await makeCaller().getNearbyTasks({ lat: 37.7, lng: -122.4 });

    expect(result).toEqual(tasks);
    expect(FeedQueryService.getNearbyTasks).toHaveBeenCalledWith(37.7, -122.4, 25, 20);
  });
});

// ---------------------------------------------------------------------------
// Tests — License Verification
// ---------------------------------------------------------------------------

describe('capability.submitLicense', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits license for verification', async () => {
    vi.mocked(LicenseVerificationService.submitLicense).mockResolvedValueOnce({ id: 'lic-1' } as any);

    const result = await makeCaller().submitLicense({
      tradeType: 'plumbing',
      issuingState: 'CA',
      licenseNumber: 'LIC-123',
    });

    expect(result).toEqual({ id: 'lic-1' });
    expect(LicenseVerificationService.submitLicense).toHaveBeenCalledWith({
      userId: 'test-uid',
      tradeType: 'plumbing',
      issuingState: 'CA',
      licenseNumber: 'LIC-123',
      expirationDate: undefined,
      documentUrl: undefined,
    });
  });
});

describe('capability.getLicenses', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns user licenses', async () => {
    const licenses = [{ id: 'lic-1', trade: 'plumbing' }];
    vi.mocked(LicenseVerificationService.getUserLicenses).mockResolvedValueOnce(licenses as any);

    const result = await makeCaller().getLicenses();

    expect(result).toEqual(licenses);
  });
});

// ---------------------------------------------------------------------------
// Tests — Insurance
// ---------------------------------------------------------------------------

describe('capability.submitInsurance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits insurance for verification', async () => {
    vi.mocked(InsuranceVerificationService.submitInsurance).mockResolvedValueOnce({ id: 'ins-1' } as any);

    const result = await makeCaller().submitInsurance({
      provider: 'StateFarm',
      policyNumber: 'POL-123',
      coverageAmount: 100000,
      expirationDate: '2027-01-01',
    });

    expect(result).toEqual({ id: 'ins-1' });
  });
});

describe('capability.getInsurance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns user insurance', async () => {
    vi.mocked(InsuranceVerificationService.getUserInsurance).mockResolvedValueOnce({ status: 'verified' } as any);

    const result = await makeCaller().getInsurance();

    expect(result).toEqual({ status: 'verified' });
  });
});

// ---------------------------------------------------------------------------
// Tests — Background Check
// ---------------------------------------------------------------------------

describe('capability.initiateBackgroundCheck', () => {
  beforeEach(() => vi.clearAllMocks());

  it('initiates background check', async () => {
    vi.mocked(BackgroundCheckService.initiateBackgroundCheck).mockResolvedValueOnce({ id: 'bg-1' } as any);

    const result = await makeCaller().initiateBackgroundCheck({ provider: 'checkr' });

    expect(result).toEqual({ id: 'bg-1' });
  });
});

describe('capability.getBackgroundCheck', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns background check status', async () => {
    vi.mocked(BackgroundCheckService.getUserBackgroundCheck).mockResolvedValueOnce({ status: 'pending' } as any);

    const result = await makeCaller().getBackgroundCheck();

    expect(result).toEqual({ status: 'pending' });
  });
});

// ---------------------------------------------------------------------------
// Tests — Admin License Operations
// ---------------------------------------------------------------------------

describe('capability.approveLicense', () => {
  beforeEach(() => vi.clearAllMocks());

  it('approves license verification', async () => {
    vi.mocked(LicenseVerificationService.approveLicense).mockResolvedValueOnce({ approved: true } as any);

    const result = await makeCaller().approveLicense({ verificationId: 'ver-1' });

    expect(result).toEqual({ approved: true });
    expect(LicenseVerificationService.approveLicense).toHaveBeenCalledWith('ver-1', 'test-uid', undefined);
  });
});

describe('capability.rejectLicense', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects license verification', async () => {
    vi.mocked(LicenseVerificationService.rejectLicense).mockResolvedValueOnce({ rejected: true } as any);

    const result = await makeCaller().rejectLicense({
      verificationId: 'ver-1',
      reason: 'Expired license',
    });

    expect(result).toEqual({ rejected: true });
  });
});

describe('capability.getPendingLicenses', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns pending verifications', async () => {
    const pending = [{ id: 'ver-1', trade: 'plumbing' }];
    vi.mocked(LicenseVerificationService.getPendingVerifications).mockResolvedValueOnce(pending as any);

    const result = await makeCaller().getPendingLicenses({ limit: 50, offset: 0 });

    expect(result).toEqual(pending);
  });
});
