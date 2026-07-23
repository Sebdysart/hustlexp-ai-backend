import { beforeEach, describe, expect, it, vi } from 'vitest';

const recurring = vi.hoisted(() => ({
  createBusinessRecurringTemplate: vi.fn(),
  listBusinessRecurringTemplates: vi.fn(),
}));
vi.mock('../../src/services/BusinessRecurringService.js', () => recurring);
vi.mock('../../src/auth/firebase.js', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import { businessWorkspaceRouter } from '../../src/routers/businessWorkspace.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';
const ORG = '10000000-0000-4000-8000-000000000001';
const LOCATION = '20000000-0000-4000-8000-000000000001';
const caller = businessWorkspaceRouter.createCaller({
  user: { id: ACTOR, email: 'owner@example.com', full_name: 'Owner', account_status: 'ACTIVE' } as any,
  firebaseUid: 'firebase-owner',
});

const input = {
  organizationId: ORG, locationId: LOCATION, title: 'Weekly storefront reset',
  description: 'Reset the storefront and upload the approved completion proof.',
  category: 'FACILITIES', pattern: 'weekly' as const, dayOfWeek: 2, dayOfMonth: null,
  timeOfDay: '09:00', startDate: '2026-07-21', endDate: null,
  serviceWindowStart: '09:00', serviceWindowEnd: '11:00', expectedDurationMinutes: 120,
  amountCents: 10_000, templateBudgetCapCents: 100_000, poNumber: 'PO-RECUR-1',
  costCenter: 'OPS', requiredTools: ['vacuum'], proofChecklist: ['Upload proof'],
  blackoutDates: [], cancellationNoticeHours: 24, nextReviewDate: '2026-10-01',
  insideHome: false, peoplePresent: true, petsPresent: false, caregiving: false,
};

describe('business recurring authenticated router', () => {
  beforeEach(() => vi.clearAllMocks());

  it('actor-binds template creation and rejects authority/economics injection', async () => {
    recurring.createBusinessRecurringTemplate.mockResolvedValue({
      success: true, data: { id: 'series', status: 'active', revisionId: 'revision' },
    });
    await caller.createRecurringTemplate(input);
    expect(recurring.createBusinessRecurringTemplate).toHaveBeenCalledWith({ ...input, actorId: ACTOR });
    await expect(caller.createRecurringTemplate({
      ...input,
      actorId: ACTOR,
      clientPrincipalType: 'HOUSEHOLD',
      providerPayoutCents: 1,
      platformMarginCents: 1,
      preferredWorkerId: ACTOR,
      exactLocation: 'Injected address',
      riskLevel: 'LOW',
    } as any)).rejects.toThrow();
  });

  it('validates recurrence shape before the service boundary', async () => {
    await expect(caller.createRecurringTemplate({ ...input, dayOfWeek: null })).rejects.toThrow();
    await expect(caller.createRecurringTemplate({
      ...input, serviceWindowStart: '11:00', serviceWindowEnd: '09:00',
    })).rejects.toThrow();
    await expect(caller.createRecurringTemplate({
      ...input, templateBudgetCapCents: 9_000,
    })).rejects.toThrow();
    expect(recurring.createBusinessRecurringTemplate).not.toHaveBeenCalled();
  });

  it('binds organization template reads to the authenticated actor', async () => {
    recurring.listBusinessRecurringTemplates.mockResolvedValue({ success: true, data: [] });
    await caller.listRecurringTemplates({ organizationId: ORG });
    expect(recurring.listBusinessRecurringTemplates).toHaveBeenCalledWith(ACTOR, ORG);
  });
});
