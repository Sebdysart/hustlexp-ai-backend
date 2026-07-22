import { beforeEach, describe, expect, it, vi } from 'vitest';

const workspace = vi.hoisted(() => ({
  createBusinessWorkspace: vi.fn(), listBusinessWorkspaces: vi.fn(),
  setBusinessMemberRole: vi.fn(), setBusinessMemberRoleByEmail: vi.fn(),
  listBusinessMembers: vi.fn(), createBusinessLocation: vi.fn(), listBusinessLocations: vi.fn(),
}));
const operations = vi.hoisted(() => ({
  upsertBusinessBudgetPolicy: vi.fn(), listBusinessBudgetPolicies: vi.fn(),
  requestBusinessSpend: vi.fn(), listBusinessApprovalQueue: vi.fn(),
  listMyBusinessSpendRequests: vi.fn(),
  decideBusinessApproval: vi.fn(), createBusinessServiceProfile: vi.fn(),
  listBusinessServiceProfiles: vi.fn(), submitBusinessCredential: vi.fn(),
  assignBusinessServiceCrew: vi.fn(), activateBusinessServiceProfile: vi.fn(),
}));

vi.mock('../../src/services/BusinessWorkspaceService.js', () => workspace);
vi.mock('../../src/services/BusinessOperationsService.js', () => operations);
vi.mock('../../src/db.js', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/auth/firebase.js', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import { businessWorkspaceRouter } from '../../src/routers/businessWorkspace.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';
const ORG = '10000000-0000-4000-8000-000000000001';
const LOCATION = '20000000-0000-4000-8000-000000000001';
const REQUEST = '30000000-0000-4000-8000-000000000001';
const PROFILE = '40000000-0000-4000-8000-000000000001';
const MEMBERSHIP = '50000000-0000-4000-8000-000000000001';

const caller = businessWorkspaceRouter.createCaller({
  user: { id: ACTOR, email: 'owner@example.com', full_name: 'Owner', account_status: 'ACTIVE' } as any,
  firebaseUid: 'firebase-owner',
});

describe('business operations authenticated router', () => {
  beforeEach(() => vi.clearAllMocks());

  it('binds budget authority to the authenticated actor and validates cap hierarchy', async () => {
    operations.upsertBusinessBudgetPolicy.mockResolvedValue({
      success: true, data: { id: REQUEST, revision: 1 },
    });
    await caller.upsertBudgetPolicy({
      organizationId: ORG, locationId: LOCATION, serviceCategory: 'FACILITIES',
      perTaskCapCents: 20_000, monthlyCapCents: 100_000,
      autoApproveLimitCents: 10_000, poRequired: true, costCenterRequired: true,
    });
    expect(operations.upsertBusinessBudgetPolicy).toHaveBeenCalledWith(expect.objectContaining({
      actorId: ACTOR,
    }));
    await expect(caller.upsertBudgetPolicy({
      organizationId: ORG, locationId: null, serviceCategory: '*',
      perTaskCapCents: 20_000, monthlyCapCents: 10_000,
      autoApproveLimitCents: 25_000, poRequired: false, costCenterRequired: false,
    })).rejects.toThrow();
  });

  it('rejects actor and outcome injection on spend requests', async () => {
    operations.requestBusinessSpend.mockResolvedValue({
      success: true, data: { id: REQUEST, status: 'AUTO_APPROVED', blockers: [] },
    });
    await caller.requestSpend({
      organizationId: ORG, locationId: LOCATION, serviceCategory: 'FACILITIES',
      amountCents: 8_000, poNumber: 'PO-1', costCenter: 'OPS', idempotencyKey: 'spend:test:001',
    });
    expect(operations.requestBusinessSpend).toHaveBeenCalledWith(expect.objectContaining({ actorId: ACTOR }));
    await expect(caller.requestSpend({
      organizationId: ORG, locationId: LOCATION, serviceCategory: 'FACILITIES',
      amountCents: 8_000, poNumber: 'PO-1', costCenter: 'OPS', idempotencyKey: 'spend:test:002',
      actorId: MEMBERSHIP, status: 'AUTO_APPROVED', blockers: [],
    } as any)).rejects.toThrow();
  });

  it('binds decisions to the authenticated approver and rejects requester injection', async () => {
    operations.decideBusinessApproval.mockResolvedValue({
      success: true, data: { id: REQUEST, status: 'APPROVED' },
    });
    await caller.decideApproval({
      organizationId: ORG, approvalRequestId: REQUEST,
      decision: 'APPROVED', reason: 'Within operating policy',
    });
    expect(operations.decideBusinessApproval).toHaveBeenCalledWith(expect.objectContaining({ actorId: ACTOR }));
    await expect(caller.decideApproval({
      organizationId: ORG, approvalRequestId: REQUEST,
      decision: 'APPROVED', reason: 'Injected', requesterId: MEMBERSHIP,
    } as any)).rejects.toThrow();
  });

  it('creates only draft service data and rejects readiness injection', async () => {
    operations.createBusinessServiceProfile.mockResolvedValue({
      success: true, data: { id: PROFILE, status: 'DRAFT' },
    });
    const base = {
      organizationId: ORG, serviceCode: 'ELECTRICAL', serviceName: 'Commercial electrical',
      serviceDescription: 'Qualified electrical response with proof.', serviceExclusions: [],
      bookingQuestions: [], coveragePostalCodes: ['98004'], maximumTravelMiles: 20,
      weeklyCapacitySlots: 12, blackoutDates: [], pricingMode: 'INSTANT_CORRIDOR' as const,
      corridorMinimumCents: 9_000, corridorMaximumCents: 14_000,
      responseMode: 'INDIVIDUAL_OFFERS' as const, proofChecklist: ['Upload final proof'],
      credentialRequirements: ['ELECTRICAL_LICENSE'], idempotencyKey: 'service:test:001',
    };
    await caller.createServiceProfile(base);
    expect(operations.createBusinessServiceProfile).toHaveBeenCalledWith(expect.objectContaining({ actorId: ACTOR }));
    await expect(caller.createServiceProfile({
      ...base, idempotencyKey: 'service:test:002', status: 'ACTIVE',
      verificationStatus: 'VERIFIED', payoutStatus: 'ACTIVE', ready: true,
    } as any)).rejects.toThrow();
  });

  it('forces credential verification to remain outside the browser boundary', async () => {
    operations.submitBusinessCredential.mockResolvedValue({
      success: true, data: { id: REQUEST, status: 'PENDING' },
    });
    await caller.submitCredential({
      organizationId: ORG, membershipId: MEMBERSHIP,
      credentialType: 'ELECTRICAL_LICENSE', evidenceReference: 'upload-token-001',
    });
    expect(operations.submitBusinessCredential).toHaveBeenCalledWith(expect.objectContaining({ actorId: ACTOR }));
    await expect(caller.submitCredential({
      organizationId: ORG, membershipId: MEMBERSHIP,
      credentialType: 'ELECTRICAL_LICENSE', evidenceReference: 'upload-token-002',
      status: 'ACTIVE', verifiedBy: ACTOR,
    } as any)).rejects.toThrow();
  });

  it('treats activation as a server evaluation and rejects a browser ready flag', async () => {
    operations.activateBusinessServiceProfile.mockResolvedValue({
      success: true, data: { id: PROFILE, ready: false, blockers: ['PAYOUT_NOT_ACTIVE'] },
    });
    await caller.activateServiceProfile({ organizationId: ORG, serviceProfileId: PROFILE });
    expect(operations.activateBusinessServiceProfile).toHaveBeenCalledWith({
      actorId: ACTOR, organizationId: ORG, serviceProfileId: PROFILE,
    });
    await expect(caller.activateServiceProfile({
      organizationId: ORG, serviceProfileId: PROFILE, ready: true, blockers: [],
    } as any)).rejects.toThrow();
  });
});
