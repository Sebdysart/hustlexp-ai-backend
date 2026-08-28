import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  createAuthorized: vi.fn(),
  compliance: vi.fn(),
  decrypt: vi.fn((id: string) => id.endsWith(':access') ? 'Rear loading entrance' : '42 Private Lane'),
  classify: vi.fn(() => 'MEDIUM'),
  toLegacy: vi.fn(() => 'MEDIUM'),
}));

vi.mock('../../src/db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/services/RecurringWorkService.js', () => ({
  createAuthorizedOrganizationRecurringTemplate: mocks.createAuthorized,
}));
vi.mock('../../src/services/ComplianceGuardianService.js', () => ({
  ComplianceGuardianService: { evaluate: mocks.compliance },
}));
vi.mock('../../src/services/TaskLocationCrypto.js', () => ({ decryptTaskLocation: mocks.decrypt }));
vi.mock('../../src/services/TaskRiskClassifier.js', () => ({
  TaskRiskClassifier: { classifyWithTemplate: mocks.classify, toLegacyRiskLevel: mocks.toLegacy },
}));
vi.mock('../../src/services/TaskTemplateRegistry.js', () => ({ isCareContent: vi.fn(() => false) }));
vi.mock('../../src/logger.js', () => ({
  logger: { child: () => ({ error: vi.fn() }) },
}));

import {
  createBusinessRecurringTemplate,
  listBusinessRecurringTemplates,
} from '../../src/services/BusinessRecurringService.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';
const ORG = '10000000-0000-4000-8000-000000000001';
const LOCATION = '20000000-0000-4000-8000-000000000001';
const WORKER = '30000000-0000-4000-8000-000000000001';

const input = {
  actorId: ACTOR,
  organizationId: ORG,
  locationId: LOCATION,
  title: 'Weekly storefront reset',
  description: 'Reset the storefront and upload the approved completion proof.',
  category: 'FACILITIES',
  pattern: 'weekly' as const,
  dayOfWeek: 2,
  dayOfMonth: null,
  timeOfDay: '09:00',
  startDate: '2026-07-21',
  endDate: null,
  serviceWindowStart: '09:00',
  serviceWindowEnd: '11:00',
  expectedDurationMinutes: 120,
  amountCents: 10_000,
  templateBudgetCapCents: 100_000,
  poNumber: 'PO-RECUR-1',
  costCenter: 'OPS',
  requiredTools: ['vacuum'],
  proofChecklist: ['Upload completion proof'],
  blackoutDates: ['2026-12-25'],
  cancellationNoticeHours: 24,
  nextReviewDate: '2026-10-01',
  insideHome: false,
  peoplePresent: true,
  petsPresent: false,
  caregiving: false,
};

function source(overrides: Record<string, unknown> = {}) {
  return {
    location_id: LOCATION, rough_location: 'Bellevue', region_code: 'US-WA',
    timezone: 'America/Los_Angeles', exact_address_ciphertext: 'exact-cipher',
    exact_address_nonce: 'n', exact_address_auth_tag: 't', exact_address_key_id: 'k',
    access_ciphertext: 'access-cipher', access_nonce: 'n', access_auth_tag: 't', access_key_id: 'k',
    per_task_cap_cents: 20_000, monthly_cap_cents: 100_000,
    auto_approve_limit_cents: 12_000, po_required: true, cost_center_required: true,
    preferred_worker_id: WORKER,
    backup_worker_ids: ['40000000-0000-4000-8000-000000000001'],
    ...overrides,
  };
}

describe('business recurring service boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.compliance.mockResolvedValue({ tier: 'allow', reasons: [] });
  });

  it('derives private location, economics, policy, risk, and provider routing server-side', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [source()] });
    mocks.createAuthorized.mockResolvedValueOnce({
      success: true, data: { id: 'series', status: 'active', revisionId: 'revision' },
    });

    const result = await createBusinessRecurringTemplate(input);

    expect(result).toMatchObject({ success: true, data: { id: 'series' } });
    expect(mocks.query.mock.calls[0][1]).toEqual([ORG, ACTOR, LOCATION, 'facilities']);
    expect(mocks.createAuthorized).toHaveBeenCalledWith(expect.objectContaining({
      posterId: ACTOR,
      clientPrincipalType: 'ORGANIZATION',
      clientPrincipalId: ORG,
      exactLocation: '42 Private Lane',
      accessProcedure: 'Rear loading entrance',
      regionCode: 'US-WA',
      riskLevel: 'MEDIUM',
      customerTotalCents: 10_000,
      providerPayoutCents: 8_000,
      platformMarginCents: 2_000,
      preferredWorkerId: WORKER,
      businessOrganizationId: ORG,
      businessLocationId: LOCATION,
      businessAutoApproveLimitCents: 12_000,
    }));
  });

  it('fails before template creation when policy or purchase controls are absent', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [source({ per_task_cap_cents: null })] });
    await expect(createBusinessRecurringTemplate(input)).resolves.toMatchObject({
      success: false, error: { code: 'BUSINESS_RECURRING_POLICY_REQUIRED' },
    });
    mocks.query.mockResolvedValueOnce({ rows: [source()] });
    await expect(createBusinessRecurringTemplate({ ...input, poNumber: null })).resolves.toMatchObject({
      success: false, error: { code: 'BUSINESS_RECURRING_PO_REQUIRED' },
    });
    expect(mocks.createAuthorized).not.toHaveBeenCalled();
  });

  it('lists only the organization-safe projection behind read authority', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: 'series', title: input.title, category: input.category, rough_location: 'Bellevue',
      status: 'active', pause_code: null, current_revision_id: 'revision',
      next_occurrence_at: '2026-07-21T16:00:00.000Z', pattern: 'weekly',
      service_window_start: '09:00:00', service_window_end: '11:00:00',
      timezone: 'America/Los_Angeles', budget_cap_cents: 100_000, budget_spend_cents: 20_000,
      preferred_worker_id: WORKER, backup_provider_count: 1, occurrence_count: 2,
      completed_count: 1, automation_mode: 'SUPERVISED', business_location_id: LOCATION,
      auto_approve_limit_cents: 12_000, payment_cents: 10_000,
    }] });

    const result = await listBusinessRecurringTemplates(ACTOR, ORG);

    expect(result).toMatchObject({
      success: true,
      data: [{ locationId: LOCATION, approvalMode: 'AUTO_ELIGIBLE', budgetSpendCents: 20_000 }],
    });
    expect(String(mocks.query.mock.calls[0][0])).not.toMatch(/ciphertext|access_nonce|exact_address/i);
  });
});
