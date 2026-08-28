import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  createInTransaction: vi.fn(),
  compliance: vi.fn(),
  decrypt: vi.fn((vaultId: string) => vaultId.endsWith(':access') ? 'Use rear gate' : '42 Private Lane'),
}));

vi.mock('../../src/db.js', () => ({
  db: {
    query: mocks.query,
    transaction: vi.fn(async (fn: (query: typeof mocks.query) => Promise<unknown>) => fn(mocks.query)),
  },
}));
vi.mock('../../src/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('../../src/services/TaskCreateService.js', () => ({
  TaskCreateService: { createInTransaction: mocks.createInTransaction },
}));
vi.mock('../../src/services/ComplianceGuardianService.js', () => ({
  ComplianceGuardianService: { evaluate: mocks.compliance },
}));
vi.mock('../../src/services/TaskLocationCrypto.js', () => ({ decryptTaskLocation: mocks.decrypt }));
vi.mock('../../src/services/TaskRiskClassifier.js', () => ({
  TaskRiskClassifier: {
    classifyWithTemplate: vi.fn(() => 'low'),
    toLegacyRiskLevel: vi.fn(() => 'LOW'),
  },
}));
vi.mock('../../src/services/TaskTemplateRegistry.js', () => ({ isCareContent: vi.fn(() => false) }));

import {
  createBusinessInvoiceSnapshot,
  createBusinessWorkOrder,
  listBusinessInvoiceSnapshots,
  listBusinessProviderPreferences,
  listBusinessWorkOrders,
  setBusinessProviderPreferenceByEmail,
} from '../../src/services/BusinessExecutionService.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';
const ORG = '10000000-0000-4000-8000-000000000001';
const APPROVAL = '20000000-0000-4000-8000-000000000001';
const LOCATION = '30000000-0000-4000-8000-000000000001';
const TASK = '40000000-0000-4000-8000-000000000001';

const WORK_ORDER = {
  actorId: ACTOR,
  organizationId: ORG,
  approvalRequestId: APPROVAL,
  title: 'Repair storefront fixture',
  description: 'Repair the approved storefront fixture and document completion.',
  requirements: 'Protect the customer area.',
  serviceWindowStart: '2026-07-20T16:00:00.000Z',
  serviceWindowEnd: '2026-07-20T18:00:00.000Z',
  expectedDurationMinutes: 120,
  requiredTools: ['drill'],
  proofChecklist: ['Complete repair', 'Upload final proof'],
  insideHome: false,
  peoplePresent: true,
  petsPresent: false,
  caregiving: false,
};

function approvedDemand() {
  return {
    approval_request_id: APPROVAL,
    canonical_task_id: null,
    amount_cents: 10_000,
    service_category: 'FACILITIES',
    location_id: LOCATION,
    location_name: 'Bellevue Store',
    rough_location: 'Downtown Bellevue',
    region_code: 'US-WA',
    exact_address_ciphertext: 'address-cipher',
    exact_address_nonce: 'address-nonce',
    exact_address_auth_tag: 'address-tag',
    exact_address_key_id: 'location-v1',
    access_ciphertext: 'access-cipher',
    access_nonce: 'access-nonce',
    access_auth_tag: 'access-tag',
    access_key_id: 'location-v1',
  };
}

describe('business canonical execution service boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.compliance.mockResolvedValue({ tier: 'allow' });
  });

  it('derives price, category, private location, and economics from approved server records', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [approvedDemand()] })
      .mockResolvedValueOnce({ rows: [{ canonical_task_id: TASK, idempotency_replayed: false }] });
    mocks.createInTransaction.mockResolvedValueOnce({ success: true, data: { id: TASK } });

    const result = await createBusinessWorkOrder(WORK_ORDER);

    expect(result).toEqual({ success: true, data: { taskId: TASK, idempotencyReplayed: false } });
    expect(mocks.createInTransaction).toHaveBeenCalledWith(mocks.query, expect.objectContaining({
      posterId: ACTOR,
      price: 10_000,
      category: 'FACILITIES',
      location: '42 Private Lane\nAccess procedure: Use rear gate',
      roughArea: 'Downtown Bellevue',
      regionCode: 'US-WA',
      clientIdempotencyKey: `business-work-order:${APPROVAL}`,
    }));
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([ORG, ACTOR, APPROVAL, TASK]);
  });

  it('creates nothing when safety policy hard-blocks the scope', async () => {
    mocks.compliance.mockResolvedValueOnce({ tier: 'hard_block' });
    const result = await createBusinessWorkOrder(WORK_ORDER);
    expect(result).toMatchObject({
      success: false, error: { code: 'BUSINESS_WORK_ORDER_COMPLIANCE_BLOCKED' },
    });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.createInTransaction).not.toHaveBeenCalled();
  });

  it('returns canonical task failure and never attempts the business bind', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [approvedDemand()] });
    mocks.createInTransaction.mockResolvedValueOnce({
      success: false, error: { code: 'REGION_POLICY_DENIED', message: 'Region is closed.' },
    });
    const result = await createBusinessWorkOrder(WORK_ORDER);
    expect(result).toEqual({
      success: false, error: { code: 'REGION_POLICY_DENIED', message: 'Region is closed.' },
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('normalizes provider email only after the database permission boundary', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      preference_id: 'preference-id', preference_priority: 'PRIMARY',
    }] });
    const result = await setBusinessProviderPreferenceByEmail({
      actorId: ACTOR, organizationId: ORG, locationId: null,
      serviceCategory: 'FACILITIES', providerEmail: ' Provider@Example.com ', priority: 'PRIMARY',
    });
    expect(result).toMatchObject({ success: true, data: { priority: 'PRIMARY' } });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      ORG, ACTOR, null, 'FACILITIES', 'provider@example.com', 'PRIMARY',
    ]);
  });

  it('lists safe provider and canonical work-order projections', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: 'preference-id', location_id: LOCATION, location_name: 'Bellevue Store',
      service_category: 'FACILITIES', provider_name: 'Primary Provider', priority: 'PRIMARY',
    }] });
    const preferences = await listBusinessProviderPreferences(ACTOR, ORG);
    expect(preferences).toMatchObject({ success: true, data: [{ providerName: 'Primary Provider' }] });
    expect(String(mocks.query.mock.calls[0]?.[0])).not.toMatch(/email|firebase/i);

    mocks.query.mockResolvedValueOnce({ rows: [{
      task_id: TASK, location_name: 'Bellevue Store', title: 'Repair storefront',
      category: 'FACILITIES', task_state: 'OPEN', progress_state: 'POSTED',
      worker_name: null, customer_total_cents: '10000', escrow_state: 'PENDING',
      refunded_cents: '0', deadline: '2026-07-20T18:00:00.000Z', completed_at: null,
      completed_on_time: null, created_at: '2026-07-18T12:00:00.000Z',
    }] });
    const workOrders = await listBusinessWorkOrders(ACTOR, ORG);
    expect(workOrders).toMatchObject({ success: true, data: [{
      taskId: TASK, customerTotalCents: 10_000, escrowState: 'PENDING',
    }] });
  });

  it('creates and lists immutable billing snapshot projections', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      invoice_snapshot_id: 'invoice-id', transaction_count: 2, settled_total_cents: '18000',
    }] });
    const created = await createBusinessInvoiceSnapshot({
      actorId: ACTOR, organizationId: ORG,
      periodStart: '2026-07-01T00:00:00.000Z', periodEnd: '2026-07-18T00:00:00.000Z',
      grouping: { groupBy: 'monthly' }, idempotencyKey: 'invoice:test:001',
    });
    expect(created).toEqual({ success: true, data: {
      id: 'invoice-id', transactionCount: 2, settledTotalCents: 18_000,
    } });

    mocks.query.mockResolvedValueOnce({ rows: [{
      id: 'invoice-id', period_start: '2026-07-01T00:00:00.000Z',
      period_end: '2026-07-18T00:00:00.000Z', transaction_count: 2,
      customer_total_cents: '20000', refunded_total_cents: '2000',
      settled_total_cents: '18000', status: 'SNAPSHOT',
      created_at: '2026-07-18T00:01:00.000Z',
    }] });
    const listed = await listBusinessInvoiceSnapshots(ACTOR, ORG);
    expect(listed).toMatchObject({ success: true, data: [{
      transactionCount: 2, refundedTotalCents: 2000, settledTotalCents: 18000,
    }] });
  });
});
