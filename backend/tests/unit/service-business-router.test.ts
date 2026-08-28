import { beforeEach, describe, expect, it, vi } from 'vitest';

const execution = vi.hoisted(() => ({
  linkServiceBusinessPayoutAccount: vi.fn(),
  listServiceBusinessOpportunities: vi.fn(),
  listServiceBusinessEligibleCrew: vi.fn(),
  listServiceBusinessAssignments: vi.fn(),
  reviewServiceBusinessOpportunity: vi.fn(),
  acceptServiceBusinessOpportunity: vi.fn(),
  declineServiceBusinessOpportunity: vi.fn(),
  clarifyServiceBusinessOpportunity: vi.fn(),
  quoteServiceBusinessOpportunity: vi.fn(),
}));

vi.mock('../../src/services/ServiceBusinessExecutionService.js', () => execution);
vi.mock('../../src/db.js', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/auth/firebase.js', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import { serviceBusinessRouter } from '../../src/routers/serviceBusiness.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';
const ORG = '10000000-0000-4000-8000-000000000001';
const PAYOUT_MEMBERSHIP = '20000000-0000-4000-8000-000000000001';
const PROFILE = '30000000-0000-4000-8000-000000000001';
const CREW = '40000000-0000-4000-8000-000000000001';
const FULFILLER = '50000000-0000-4000-8000-000000000001';
const TASK = '60000000-0000-4000-8000-000000000001';
const OFFER = '70000000-0000-4000-8000-000000000001';

function authenticatedCaller() {
  return serviceBusinessRouter.createCaller({
    user: {
      id: ACTOR,
      email: 'dispatcher@example.com',
      full_name: 'Provider Dispatcher',
      account_status: 'ACTIVE',
    } as any,
    firebaseUid: 'firebase-provider-dispatcher',
  });
}

function unauthenticatedCaller() {
  return serviceBusinessRouter.createCaller({ user: null, firebaseUid: null } as any);
}

describe('Service Business authenticated router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execution.linkServiceBusinessPayoutAccount.mockResolvedValue({
      success: true,
      data: { destinationKind: 'ORGANIZATION_ACCOUNT', status: 'ACTIVE' },
    });
    execution.listServiceBusinessOpportunities.mockResolvedValue({ success: true, data: [] });
    execution.listServiceBusinessEligibleCrew.mockResolvedValue({
      success: true,
      data: [{
        crewAssignmentId: CREW,
        fulfillerName: 'Verified Crew Member',
        memberRole: 'CREW',
      }],
    });
    execution.listServiceBusinessAssignments.mockResolvedValue({
      success: true,
      data: [],
    });
    execution.reviewServiceBusinessOpportunity.mockResolvedValue({
      success: true,
      data: {
        offerDecisionId: OFFER,
        crewAssignmentId: CREW,
        fulfillerName: 'Verified Crew Member',
        payoutDestination: { kind: 'ORGANIZATION_ACCOUNT', state: 'ACTIVE' },
      },
    });
    execution.acceptServiceBusinessOpportunity.mockResolvedValue({
      success: true,
      data: { action: 'ACCEPTED', reservationId: '90000000-0000-4000-8000-000000000001', idempotencyReplayed: false },
    });
    execution.declineServiceBusinessOpportunity.mockResolvedValue({
      success: true,
      data: { action: 'DECLINED', eventId: 'a0000000-0000-4000-8000-000000000001', idempotencyReplayed: false },
    });
    execution.clarifyServiceBusinessOpportunity.mockResolvedValue({
      success: true,
      data: { action: 'CLARIFICATION_REQUESTED', questionId: 'b0000000-0000-4000-8000-000000000001', idempotencyReplayed: false },
    });
    execution.quoteServiceBusinessOpportunity.mockResolvedValue({
      success: true,
      data: { action: 'QUOTED', counterOfferId: 'c0000000-0000-4000-8000-000000000001' },
    });
  });

  it('binds every Service Business action to the authenticated actor', async () => {
    const caller = authenticatedCaller();
    await caller.linkPayoutAccount({
      organizationId: ORG,
      payoutMembershipId: PAYOUT_MEMBERSHIP,
      idempotencyKey: 'payout:provider:001',
    });
    await caller.listOpportunities({ organizationId: ORG });
    await caller.listEligibleCrew({
      organizationId: ORG,
      serviceProfileId: PROFILE,
      taskId: TASK,
    });
    await caller.listAssignments({ organizationId: ORG });
    await caller.reviewOpportunity({
      organizationId: ORG,
      serviceProfileId: PROFILE,
      crewAssignmentId: CREW,
      taskId: TASK,
      idempotencyKey: 'review:provider:001',
    });
    await caller.acceptOpportunity({
      organizationId: ORG,
      serviceProfileId: PROFILE,
      crewAssignmentId: CREW,
      offerDecisionId: OFFER,
      taskId: TASK,
      idempotencyKey: 'accept:provider:001',
    });
    await caller.declineOpportunity({
      organizationId: ORG,
      offerDecisionId: OFFER,
      reasonCode: 'CAPACITY_UNAVAILABLE',
      idempotencyKey: 'decline:provider:001',
    });
    await caller.requestClarification({
      organizationId: ORG,
      offerDecisionId: OFFER,
      question: 'Is the loading dock available during the service window?',
      idempotencyKey: 'clarify:provider:001',
    });
    await caller.quoteOpportunity({
      organizationId: ORG,
      offerDecisionId: OFFER,
      proposedPayoutCents: 12_500,
      reason: 'A second verified crew member is required for the listed scope.',
      idempotencyKey: 'quote:provider:001',
    });

    expect(execution.linkServiceBusinessPayoutAccount).toHaveBeenCalledWith(expect.objectContaining({ actorId: ACTOR }));
    expect(execution.listServiceBusinessOpportunities).toHaveBeenCalledWith(ACTOR, ORG);
    expect(execution.listServiceBusinessEligibleCrew).toHaveBeenCalledWith(expect.objectContaining({
      actorId: ACTOR,
      organizationId: ORG,
      serviceProfileId: PROFILE,
      taskId: TASK,
    }));
    expect(execution.listServiceBusinessAssignments).toHaveBeenCalledWith(ACTOR, ORG);
    expect(execution.reviewServiceBusinessOpportunity).toHaveBeenCalledWith(expect.objectContaining({ actorId: ACTOR }));
    expect(execution.acceptServiceBusinessOpportunity).toHaveBeenCalledWith(expect.objectContaining({
      actorId: ACTOR,
      organizationId: ORG,
      crewAssignmentId: CREW,
    }));
    expect(execution.acceptServiceBusinessOpportunity).not.toHaveBeenCalledWith(
      expect.objectContaining({ fulfillerUserId: expect.anything() }),
    );
    expect(execution.declineServiceBusinessOpportunity).toHaveBeenCalledWith(expect.objectContaining({ actorId: ACTOR }));
    expect(execution.clarifyServiceBusinessOpportunity).toHaveBeenCalledWith(expect.objectContaining({ actorId: ACTOR }));
    expect(execution.quoteServiceBusinessOpportunity).toHaveBeenCalledWith(expect.objectContaining({ actorId: ACTOR }));
  });

  it('rejects unauthenticated access before loading organization opportunities', async () => {
    await expect(unauthenticatedCaller().listOpportunities({ organizationId: ORG }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(execution.listServiceBusinessOpportunities).not.toHaveBeenCalled();
  });

  it('rejects browser-supplied actor and verification state', async () => {
    await expect(authenticatedCaller().acceptOpportunity({
      organizationId: ORG,
      serviceProfileId: PROFILE,
      crewAssignmentId: CREW,
      offerDecisionId: OFFER,
      taskId: TASK,
      idempotencyKey: 'accept:provider:002',
      actorId: FULFILLER,
      fulfillerUserId: FULFILLER,
      payoutStatus: 'ACTIVE',
      verificationStatus: 'VERIFIED',
    } as any)).rejects.toThrow();
    expect(execution.acceptServiceBusinessOpportunity).not.toHaveBeenCalled();
  });

  it('maps permission and readiness failures to actionable transport states', async () => {
    execution.listServiceBusinessOpportunities.mockResolvedValueOnce({
      success: false,
      error: { code: 'BUSINESS_PERMISSION_DENIED', message: 'This action is not permitted.' },
    });
    await expect(authenticatedCaller().listOpportunities({ organizationId: ORG }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });

    execution.acceptServiceBusinessOpportunity.mockResolvedValueOnce({
      success: false,
      error: { code: 'BUSINESS_PAYOUT_NOT_READY', message: 'Complete payout onboarding.' },
    });
    await expect(authenticatedCaller().acceptOpportunity({
      organizationId: ORG,
      serviceProfileId: PROFILE,
      crewAssignmentId: CREW,
      offerDecisionId: OFFER,
      taskId: TASK,
      idempotencyKey: 'accept:provider:003',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects malformed or uneconomic response payloads before the service boundary', async () => {
    await expect(authenticatedCaller().quoteOpportunity({
      organizationId: ORG,
      offerDecisionId: OFFER,
      proposedPayoutCents: 0,
      reason: 'short',
      idempotencyKey: 'quote:provider:bad',
    })).rejects.toThrow();
    await expect(authenticatedCaller().declineOpportunity({
      organizationId: ORG,
      offerDecisionId: OFFER,
      reasonCode: 'NO_THANKS' as any,
      idempotencyKey: 'decline:provider:bad',
    })).rejects.toThrow();
    expect(execution.quoteServiceBusinessOpportunity).not.toHaveBeenCalled();
    expect(execution.declineServiceBusinessOpportunity).not.toHaveBeenCalled();
  });
});
