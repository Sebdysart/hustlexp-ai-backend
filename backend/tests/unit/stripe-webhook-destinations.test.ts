import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config', () => ({
  config: {
    stripe: {
      secretKey: 'sk_test_destination_contract',
      webhookSecret: 'whsec_platform',
      connectWebhookSecret: 'whsec_connect',
    },
  },
}));

vi.mock('../../src/db', () => ({
  db: {
    transaction: vi.fn(),
  },
}));

vi.mock('../../src/lib/outbox-helpers', () => ({
  writeToOutbox: vi.fn().mockResolvedValue({ id: 'outbox-1' }),
}));

const { constructEvent } = vi.hoisted(() => ({ constructEvent: vi.fn() }));

vi.mock('stripe', () => ({
  default: vi.fn(function StripeConstructor() {
    return { webhooks: { constructEvent } };
  }),
}));

import { db } from '../../src/db';
import { writeToOutbox } from '../../src/lib/outbox-helpers';
import { processWebhook } from '../../src/services/StripeWebhookService';

const mockDb = vi.mocked(db);
const mockWriteToOutbox = vi.mocked(writeToOutbox);

function platformEvent() {
  return {
    id: 'evt_platform',
    type: 'payment_intent.succeeded',
    created: 1_700_000_000,
    data: { object: { id: 'pi_platform' } },
  };
}

function connectEvent(type = 'payout.paid') {
  return {
    id: 'evt_connect',
    account: 'acct_worker',
    type,
    created: 1_700_000_001,
    data: { object: { id: 'po_worker' } },
  };
}

function acceptInsert() {
  const tx = vi.fn().mockResolvedValue({ rows: [{ stripe_event_id: 'evt' }], rowCount: 1 });
  mockDb.transaction.mockImplementationOnce(async (callback: (query: typeof tx) => Promise<unknown>) => callback(tx));
}

beforeEach(() => {
  vi.clearAllMocks();
  constructEvent.mockImplementation((_body, signature, secret) => {
    if (signature === 'sig-platform' && secret === 'whsec_platform') return platformEvent();
    if (signature === 'sig-connect' && secret === 'whsec_connect') return connectEvent();
    throw new Error('No signatures found matching the expected signature');
  });
});

describe('Stripe destination-bound signature verification', () => {
  it('accepts a platform event only under the platform secret', async () => {
    acceptInsert();
    const result = await processWebhook('{}', 'sig-platform');
    expect(result.success).toBe(true);
    expect(mockWriteToOutbox).toHaveBeenCalledOnce();
  });

  it('accepts a connected-account payout only under the Connect secret', async () => {
    acceptInsert();
    const result = await processWebhook('{}', 'sig-connect');
    expect(result.success).toBe(true);
    expect(constructEvent).toHaveBeenNthCalledWith(1, '{}', 'sig-connect', 'whsec_platform');
    expect(constructEvent).toHaveBeenNthCalledWith(2, '{}', 'sig-connect', 'whsec_connect');
  });

  it('rejects a Connect signature carrying a platform-scoped event', async () => {
    constructEvent.mockImplementation((_body, signature, secret) => {
      if (signature === 'sig-connect' && secret === 'whsec_connect') return platformEvent();
      throw new Error('wrong secret');
    });
    const result = await processWebhook('{}', 'sig-connect');
    expect(result.error?.code).toBe('WEBHOOK_DESTINATION_MISMATCH');
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('rejects a platform signature carrying a connected-account event', async () => {
    constructEvent.mockImplementation((_body, signature, secret) => {
      if (signature === 'sig-platform' && secret === 'whsec_platform') return connectEvent();
      throw new Error('wrong secret');
    });
    const result = await processWebhook('{}', 'sig-platform');
    expect(result.error?.code).toBe('WEBHOOK_DESTINATION_MISMATCH');
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('rejects event types outside the destination authority', async () => {
    constructEvent.mockImplementation((_body, signature, secret) => {
      if (signature === 'sig-connect' && secret === 'whsec_connect') {
        return connectEvent('payment_intent.succeeded');
      }
      throw new Error('wrong secret');
    });
    const result = await processWebhook('{}', 'sig-connect');
    expect(result.error?.code).toBe('WEBHOOK_DESTINATION_MISMATCH');
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('rejects a signature unknown to both destinations', async () => {
    const result = await processWebhook('{}', 'sig-unknown');
    expect(result.error?.code).toBe('WEBHOOK_VERIFICATION_FAILED');
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
