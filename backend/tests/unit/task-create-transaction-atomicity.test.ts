import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../src/db.js', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  getErrorMessage: vi.fn(() => 'Database error'),
}));
vi.mock('../../src/logger.js', () => ({
  taskLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('../../src/lib/outbox-helpers.js', () => ({ writeToOutbox: vi.fn() }));
vi.mock('../../src/services/PlanService.js', () => ({
  PlanService: { canCreateTaskWithRisk: vi.fn().mockResolvedValue({ allowed: true }) },
}));
vi.mock('../../src/services/ScoperAIService.js', () => ({
  ScoperAIService: { analyzeTaskScope: vi.fn() },
}));
vi.mock('../../src/services/RegionPolicyService.js', () => ({
  resolveRegionPolicy: vi.fn().mockResolvedValue({
    id: '10000000-0000-4000-8000-000000000001', region_code: 'US-WA',
    version: 'test-v1', policy_hash: 'a'.repeat(64),
  }),
  evaluateTaskAgainstRegionPolicy: vi.fn().mockReturnValue({
    allowed: true,
    reasons: [],
    snapshot: {
      policyId: '10000000-0000-4000-8000-000000000001',
      policyVersion: 'test-v1', policyHash: 'a'.repeat(64), regionCode: 'US-WA',
      locationState: 'WA', licenseRequired: false, insuranceRequired: false,
      backgroundCheckRequired: false, proofRequired: true, proofMinPhotos: 1,
      proofMaxPhotos: 5, proofGpsRequired: false, currency: 'usd',
    },
  }),
}));
vi.mock('../../src/services/TaskLocationService.js', () => ({
  deriveRoughArea: vi.fn(() => 'Bellevue, WA'),
  redactPrivateLocation: vi.fn((value: string | undefined | null) => value ?? null),
}));
vi.mock('../../src/services/TaskLocationCrypto.js', () => ({
  TaskLocationCryptoError: class extends Error {},
  encryptTaskLocation: vi.fn(() => ({
    ciphertext: 'cipher', nonce: 'nonce', authTag: 'tag', keyId: 'key-v1',
    fingerprint: 'b'.repeat(64),
  })),
}));

import { TaskCreateService } from '../../src/services/TaskCreateService.js';

describe('transaction-bound task creation atomicity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rolls back its savepoint when a dependent write fails after task insertion', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] }) // SAVEPOINT
      .mockResolvedValueOnce({ rows: [] }) // advisory idempotency lock
      .mockResolvedValueOnce({ rows: [] }) // no prior request
      .mockResolvedValueOnce({ rows: [{
        id: '20000000-0000-4000-8000-000000000001',
        poster_id: '00000000-0000-4000-8000-000000000001',
        title: 'Business work order', description: 'Approved work order',
        requirements: null,
      }] })
      .mockResolvedValueOnce({ rows: [] }) // encrypted location vault
      .mockRejectedValueOnce(new Error('escrow insert failed'))
      .mockResolvedValueOnce({ rows: [] }) // rollback to savepoint
      .mockResolvedValueOnce({ rows: [] }); // release savepoint

    const result = await TaskCreateService.createInTransaction(mocks.query, {
      posterId: '00000000-0000-4000-8000-000000000001',
      title: 'Business work order',
      description: 'Approved work order',
      price: 10_000,
      hustlerPayoutCents: 8_000,
      platformMarginCents: 2_000,
      location: '42 Private Lane',
      roughArea: 'Bellevue, WA',
      regionCode: 'US-WA',
      category: 'FACILITIES',
      riskLevel: 'LOW',
      mode: 'STANDARD',
      instantMode: false,
      clientIdempotencyKey: 'business-work-order:001',
      automationClassification: 'CONTROLLED_TEST',
    });

    expect(result).toMatchObject({ success: false, error: { code: 'DB_ERROR' } });
    expect(mocks.query.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining([
      'SAVEPOINT hustlexp_task_create',
      'ROLLBACK TO SAVEPOINT hustlexp_task_create',
      'RELEASE SAVEPOINT hustlexp_task_create',
    ]));
  });
});
