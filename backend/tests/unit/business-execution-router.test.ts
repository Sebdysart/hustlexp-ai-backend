import { beforeEach, describe, expect, it, vi } from 'vitest';

const workspace = vi.hoisted(() => ({
  createBusinessWorkspace: vi.fn(), listBusinessWorkspaces: vi.fn(),
  setBusinessMemberRole: vi.fn(), setBusinessMemberRoleByEmail: vi.fn(),
  listBusinessMembers: vi.fn(), createBusinessLocation: vi.fn(), listBusinessLocations: vi.fn(),
}));
const operations = vi.hoisted(() => ({
  upsertBusinessBudgetPolicy: vi.fn(), listBusinessBudgetPolicies: vi.fn(),
  requestBusinessSpend: vi.fn(), listBusinessApprovalQueue: vi.fn(),
  listMyBusinessSpendRequests: vi.fn(), decideBusinessApproval: vi.fn(),
  createBusinessServiceProfile: vi.fn(), listBusinessServiceProfiles: vi.fn(),
  submitBusinessCredential: vi.fn(), assignBusinessServiceCrew: vi.fn(),
  activateBusinessServiceProfile: vi.fn(),
}));
const execution = vi.hoisted(() => ({
  createBusinessWorkOrder: vi.fn(), setBusinessProviderPreferenceByEmail: vi.fn(),
  listBusinessProviderPreferences: vi.fn(), listBusinessWorkOrders: vi.fn(),
  listBusinessProviderPerformance: vi.fn(), createBusinessInvoiceSnapshot: vi.fn(),
  listBusinessInvoiceSnapshots: vi.fn(),
}));

vi.mock('../../src/services/BusinessWorkspaceService.js', () => workspace);
vi.mock('../../src/services/BusinessOperationsService.js', () => operations);
vi.mock('../../src/services/BusinessExecutionService.js', () => execution);
vi.mock('../../src/db.js', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/auth/firebase.js', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import { businessWorkspaceRouter } from '../../src/routers/businessWorkspace.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';
const ORG = '10000000-0000-4000-8000-000000000001';
const APPROVAL = '20000000-0000-4000-8000-000000000001';

const caller = businessWorkspaceRouter.createCaller({
  user: { id: ACTOR, email: 'owner@example.com', full_name: 'Owner', account_status: 'ACTIVE' } as any,
  firebaseUid: 'firebase-owner',
});

describe('business canonical execution authenticated router', () => {
  beforeEach(() => vi.clearAllMocks());

  it('binds canonical work creation to the authenticated actor and rejects money injection', async () => {
    execution.createBusinessWorkOrder.mockResolvedValue({
      success: true, data: { taskId: 'task-id', idempotencyReplayed: false },
    });
    const input = {
      organizationId: ORG, approvalRequestId: APPROVAL,
      title: 'Repair storefront fixture',
      description: 'Repair the approved storefront fixture and document completion.',
      requirements: null,
      serviceWindowStart: '2026-07-20T16:00:00.000Z',
      serviceWindowEnd: '2026-07-20T18:00:00.000Z',
      expectedDurationMinutes: 120, requiredTools: ['drill'],
      proofChecklist: ['Complete repair'], insideHome: false,
      peoplePresent: true, petsPresent: false, caregiving: false,
    };
    await caller.createWorkOrder(input);
    expect(execution.createBusinessWorkOrder).toHaveBeenCalledWith({ ...input, actorId: ACTOR });
    await expect(caller.createWorkOrder({
      ...input, price: 100, category: 'INJECTED', exactLocation: 'Private address',
      preferredWorkerId: ACTOR, actorId: ACTOR,
    } as any)).rejects.toThrow();
  });

  it('sets provider preference by email without browser actor or assignment authority', async () => {
    execution.setBusinessProviderPreferenceByEmail.mockResolvedValue({
      success: true, data: { id: 'preference-id', priority: 'PRIMARY' },
    });
    const input = {
      organizationId: ORG, locationId: null, serviceCategory: 'FACILITIES',
      providerEmail: 'provider@example.com', priority: 'PRIMARY' as const,
    };
    await caller.setProviderPreferenceByEmail(input);
    expect(execution.setBusinessProviderPreferenceByEmail).toHaveBeenCalledWith({
      ...input, actorId: ACTOR,
    });
    await expect(caller.setProviderPreferenceByEmail({
      ...input, providerWorkerId: ACTOR, workerId: ACTOR, assigned: true,
    } as any)).rejects.toThrow();
  });

  it('actor-binds execution, performance, billing, and requester history reads', async () => {
    execution.listBusinessProviderPreferences.mockResolvedValue({ success: true, data: [] });
    execution.listBusinessWorkOrders.mockResolvedValue({ success: true, data: [] });
    execution.listBusinessProviderPerformance.mockResolvedValue({ success: true, data: [] });
    execution.listBusinessInvoiceSnapshots.mockResolvedValue({ success: true, data: [] });
    operations.listMyBusinessSpendRequests.mockResolvedValue({ success: true, data: [] });
    await caller.listProviderPreferences({ organizationId: ORG });
    await caller.listWorkOrders({ organizationId: ORG });
    await caller.listProviderPerformance({ organizationId: ORG });
    await caller.listInvoiceSnapshots({ organizationId: ORG });
    await caller.listMySpendRequests({ organizationId: ORG });
    expect(execution.listBusinessProviderPreferences).toHaveBeenCalledWith(ACTOR, ORG);
    expect(execution.listBusinessWorkOrders).toHaveBeenCalledWith(ACTOR, ORG);
    expect(execution.listBusinessProviderPerformance).toHaveBeenCalledWith(ACTOR, ORG);
    expect(execution.listBusinessInvoiceSnapshots).toHaveBeenCalledWith(ACTOR, ORG);
    expect(operations.listMyBusinessSpendRequests).toHaveBeenCalledWith(ACTOR, ORG);
  });

  it('creates a settled snapshot without browser-owned totals or status', async () => {
    execution.createBusinessInvoiceSnapshot.mockResolvedValue({
      success: true, data: { id: 'invoice-id', transactionCount: 1, settledTotalCents: 10_000 },
    });
    const input = {
      organizationId: ORG,
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2026-07-18T00:00:00.000Z',
      grouping: { groupBy: 'monthly' },
      idempotencyKey: 'invoice:router:001',
    };
    await caller.createInvoiceSnapshot(input);
    expect(execution.createBusinessInvoiceSnapshot).toHaveBeenCalledWith({ ...input, actorId: ACTOR });
    await expect(caller.createInvoiceSnapshot({
      ...input, status: 'PAID', settledTotalCents: 1, transactionCount: 999,
    } as any)).rejects.toThrow();
  });
});
