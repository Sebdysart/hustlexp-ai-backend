import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  create: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock('../../src/db', () => ({
  db: { query: mocks.query },
}));

vi.mock('../../src/logger', () => ({
  taskLogger: { child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) },
}));

vi.mock('../../src/services/TaskCreateService', () => ({
  TaskCreateService: { create: mocks.create },
}));

vi.mock('../../src/services/TaskLocationCrypto', () => ({
  decryptTaskLocation: mocks.decrypt,
  TaskLocationCryptoError: class TaskLocationCryptoError extends Error {},
}));

import { CompletionRetentionService } from '../../src/services/CompletionRetentionService';

const SOURCE = {
  id: '11111111-1111-4111-8111-111111111111',
  poster_id: '22222222-2222-4222-8222-222222222222',
  worker_id: '33333333-3333-4333-8333-333333333333',
  state: 'COMPLETED',
  title: 'Move two boxes',
  description: 'Move two boxes into the garage.',
  price: 7500,
  hustler_payout_cents: 6000,
  platform_margin_cents: 1500,
  requirements: 'Keep both boxes upright.',
  rough_location: 'Bellevue, WA',
  category: 'moving_labor',
  trade_type: 'moving_labor',
  requires_proof: true,
  risk_level: 'LOW',
  template_slug: 'standard_physical',
  estimated_duration_minutes: 60,
  required_tools: ['hand truck'],
  region_code: 'US-WA',
  automation_classification: 'PRODUCTION',
  checklist: ['Move both boxes', 'Capture completion evidence'],
  location_ciphertext: 'ciphertext',
  location_nonce: 'nonce',
  location_auth_tag: 'tag',
  location_key_id: 'location-v1',
};

describe('CompletionRetentionService.rebook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [SOURCE] });
    mocks.decrypt.mockReturnValue('123 Main St, Bellevue, WA 98004');
    mocks.create.mockResolvedValue({
      success: true,
      data: { id: '44444444-4444-4444-8444-444444444444', state: 'OPEN' },
    });
  });

  it('creates a new canonical task linked to the completed transaction with fresh funding required', async () => {
    const result = await CompletionRetentionService.rebook({
      sourceTaskId: SOURCE.id,
      posterId: SOURCE.poster_id,
      clientIdempotencyKey: 'rebook-request-0001',
      scheduledFor: new Date('2026-07-25T18:00:00.000Z'),
    });

    expect(result).toEqual({
      success: true,
      data: {
        taskId: '44444444-4444-4444-8444-444444444444',
        sourceTaskId: SOURCE.id,
        preferredWorkerId: SOURCE.worker_id,
        state: 'OPEN',
        paymentState: 'PENDING',
        requiresNewFunding: true,
        idempotencyReplayed: false,
      },
    });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      posterId: SOURCE.poster_id,
      repeatSourceTaskId: SOURCE.id,
      preferredWorkerId: SOURCE.worker_id,
      retentionConversion: 'REBOOK',
      location: '123 Main St, Bellevue, WA 98004',
      roughArea: 'Bellevue, WA',
      regionCode: 'US-WA',
      category: 'moving_labor',
      price: 7500,
      hustlerPayoutCents: 6000,
      platformMarginCents: 1500,
      deadline: new Date('2026-07-25T18:00:00.000Z'),
      automationClassification: 'PRODUCTION',
      clientIdempotencyKey: `rebook:${SOURCE.id}:rebook-request-0001`,
    }));
  });

  it('does not clone a task for anyone except the original poster', async () => {
    const result = await CompletionRetentionService.rebook({
      sourceTaskId: SOURCE.id,
      posterId: '55555555-5555-4555-8555-555555555555',
      clientIdempotencyKey: 'rebook-request-0002',
    });

    expect(result).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });

  it('requires a completed source transaction with a real provider', async () => {
    mocks.query.mockResolvedValue({ rows: [{ ...SOURCE, state: 'PROOF_SUBMITTED' }] });

    const result = await CompletionRetentionService.rebook({
      sourceTaskId: SOURCE.id,
      posterId: SOURCE.poster_id,
      clientIdempotencyKey: 'rebook-request-0003',
    });

    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('preserves task-create idempotency replay evidence without creating a second payment state', async () => {
    mocks.create.mockResolvedValue({
      success: true,
      data: {
        id: '44444444-4444-4444-8444-444444444444',
        state: 'OPEN',
        idempotency_replayed: true,
      },
    });

    const result = await CompletionRetentionService.rebook({
      sourceTaskId: SOURCE.id,
      posterId: SOURCE.poster_id,
      clientIdempotencyKey: 'rebook-request-0001',
    });

    expect(result).toMatchObject({
      success: true,
      data: { paymentState: 'PENDING', requiresNewFunding: true, idempotencyReplayed: true },
    });
  });
});
