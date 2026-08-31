import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  browse: vi.fn(),
  expressInterest: vi.fn(),
  getMyPreEstimateJourneyState: vi.fn(),
  listMine: vi.fn(),
  listForOps: vi.fn(),
}));

vi.mock('../../src/services/UniversalV1TaskOpportunityService', () => ({
  universalV1TaskOpportunityService: service,
  universalV1TaskOpportunityProviderClasses: [
    'GENERAL_SERVICE_PROVIDER',
    'VERIFIED_TRADE_BUSINESS',
  ],
}));
vi.mock('../../src/db', () => ({ db: { query: vi.fn(), transaction: vi.fn() } }));

import { db } from '../../src/db';
import { universalV1TaskOpportunitiesRouter } from '../../src/routers/universalV1TaskOpportunities';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CELL_ID = '22222222-2222-4222-8222-222222222222';
const OPPORTUNITY_ID = '33333333-3333-4333-8333-333333333333';
const ORGANIZATION_ID = '44444444-4444-4444-8444-444444444444';
const CREDENTIAL_ID = '55555555-5555-4555-8555-555555555555';
const mockDb = vi.mocked(db);

function providerCaller() {
  return universalV1TaskOpportunitiesRouter.createCaller({
    user: {
      id: USER_ID,
      is_admin: false,
      is_banned: false,
      account_status: 'ACTIVE',
      default_mode: 'worker',
    },
    firebaseUid: 'firebase-provider',
  } as any);
}

function operationsCaller(freshMfa = true) {
  return universalV1TaskOpportunitiesRouter.createCaller({
    user: {
      id: USER_ID,
      is_admin: true,
      is_banned: false,
      account_status: 'ACTIVE',
      default_mode: 'poster',
    },
    firebaseUid: 'firebase-operator',
    ...(freshMfa
      ? {
          identityAssurance: {
            authenticatedAtSeconds: Math.floor(Date.now() / 1000),
            tokenExpiresAtSeconds: Math.floor(Date.now() / 1000) + 3_600,
            signInProvider: 'password',
            secondFactor: 'phone',
            mfaVerified: true,
          },
        }
      : {}),
  } as any);
}

describe('Universal V1 Task Opportunities router authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.browse.mockResolvedValue({ state: 'READY', opportunities: [] });
    service.expressInterest.mockResolvedValue({ interestId: 'interest-1' });
    service.getMyPreEstimateJourneyState.mockResolvedValue({
      interest: { interestId: OPPORTUNITY_ID },
      nextStep: 'AWAIT_APPROVED_INITIAL_ELIGIBILITY_COMMAND',
    });
    service.listMine.mockResolvedValue({ interests: [] });
    service.listForOps.mockResolvedValue({ interests: [] });
  });

  it('requires an authenticated provider before listing privacy-redacted opportunities', async () => {
    const anonymous = universalV1TaskOpportunitiesRouter.createCaller({
      user: null,
      firebaseUid: null,
    } as any);

    await expect(
      anonymous.browse({ serviceCellAuthorityId: CELL_ID, limit: 50, offset: 0 })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(service.browse).not.toHaveBeenCalled();
  });

  it('strictly validates and delegates a normalized general-provider browse', async () => {
    await expect(
      providerCaller().browse({
        serviceCellAuthorityId: CELL_ID,
        workCategoryCode: 'furniture_assembly',
        extraPrivateField: 'customer@example.com',
      } as any)
    ).rejects.toThrow();
    expect(service.browse).not.toHaveBeenCalled();

    await providerCaller().browse({
      serviceCellAuthorityId: CELL_ID,
      workCategoryCode: 'furniture_assembly',
    });
    expect(service.browse).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: USER_ID }) }),
      {
        serviceCellAuthorityId: CELL_ID,
        workCategoryCode: 'furniture_assembly',
        limit: 50,
        offset: 0,
      }
    );
  });

  it('requires a provider organization for a trade credential', async () => {
    await expect(
      providerCaller().browse({
        serviceCellAuthorityId: CELL_ID,
        businessCredentialId: CREDENTIAL_ID,
      })
    ).rejects.toThrow('trade credential must be bound');
    expect(service.browse).not.toHaveBeenCalled();
  });

  it('delegates exact-version EXPRESS_INTEREST with no lifecycle or money input', async () => {
    const input = {
      opportunityId: OPPORTUNITY_ID,
      expectedOpportunityVersion: 3,
      providerOrganizationId: ORGANIZATION_ID,
      businessCredentialId: CREDENTIAL_ID,
      idempotencyKey: 'interest:provider:0001',
    };
    await expect(providerCaller().expressInterest(input)).resolves.toEqual({
      interestId: 'interest-1',
    });
    expect(service.expressInterest).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: USER_ID }) }),
      input
    );
  });

  it('exposes only an authenticated provider-owned read of the next journey gate', async () => {
    const anonymous = universalV1TaskOpportunitiesRouter.createCaller({
      user: null,
      firebaseUid: null,
    } as any);
    await expect(
      anonymous.getMyPreEstimateJourneyState({ interestId: OPPORTUNITY_ID })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(service.getMyPreEstimateJourneyState).not.toHaveBeenCalled();

    await expect(
      providerCaller().getMyPreEstimateJourneyState({
        interestId: OPPORTUNITY_ID,
        actorUserId: USER_ID,
      } as any)
    ).rejects.toThrow();
    expect(service.getMyPreEstimateJourneyState).not.toHaveBeenCalled();

    await expect(
      providerCaller().getMyPreEstimateJourneyState({ interestId: OPPORTUNITY_ID })
    ).resolves.toMatchObject({
      nextStep: 'AWAIT_APPROVED_INITIAL_ELIGIBILITY_COMMAND',
    });
    expect(service.getMyPreEstimateJourneyState).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: USER_ID }) }),
      { interestId: OPPORTUNITY_ID }
    );
  });

  it('requires fresh MFA and scoped Operations authority for the Ops read model', async () => {
    mockDb.query.mockResolvedValue({
      rows: [{ role: 'support', capability_granted: true }],
      rowCount: 1,
    } as any);
    await expect(
      operationsCaller(false).listForOps({ limit: 10, offset: 0 })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(service.listForOps).not.toHaveBeenCalled();

    mockDb.query.mockResolvedValueOnce({
      rows: [{ role: 'support', capability_granted: true }],
      rowCount: 1,
    } as any);
    await expect(
      operationsCaller().listForOps({
        providerClass: 'VERIFIED_TRADE_BUSINESS',
        workCategoryCode: 'electrical',
        limit: 10,
        offset: 2,
      })
    ).resolves.toEqual({ interests: [] });
    expect(service.listForOps).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: USER_ID }) }),
      {
        providerClass: 'VERIFIED_TRADE_BUSINESS',
        workCategoryCode: 'electrical',
        limit: 10,
        offset: 2,
      }
    );
  });

  it('rejects unknown Ops read fields before service delegation', async () => {
    await expect(
      operationsCaller().listForOps({
        limit: 50,
        offset: 0,
        includeCustomerContact: true,
      } as any)
    ).rejects.toThrow();
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(service.listForOps).not.toHaveBeenCalled();
  });
});
