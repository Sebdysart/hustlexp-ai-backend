import { describe, expect, it } from 'vitest';

import {
  UniversalV1CompletionDeliveryReceiptWebhookSchema,
  universalV1CompletionDeliveryReceiptHash,
} from '../../src/services/UniversalV1CompletionDeliveryContracts.js';

const sink = {
  providerKind: 'SYNTHETIC_SINK' as const,
  serviceIdentity: 'hustlexp.synthetic-communications-sink.v1:00000000-0000-4000-8000-000000000011',
  actorUserId: '00000000-0000-4000-8000-000000000011',
};

const command = {
  schema_version: 1 as const,
  event_type: 'COMPLETION_NOTICE_DELIVERED' as const,
  task_id: '00000000-0000-4000-8000-000000000012',
  work_order_id: '00000000-0000-4000-8000-000000000013',
  submitted_completion_fact_id: '00000000-0000-4000-8000-000000000014',
  expected_completion_version: 1,
  expected_execution_version: 4,
  provider_delivery_id: 'sink-delivery:00000001',
  channel: 'EMAIL' as const,
  delivered_at: '2027-01-15T12:00:00.000Z',
  idempotency_key: 'completion-delivery:test-0001',
  client_ts: '2027-01-15T12:00:01.000Z',
};

describe('Universal V1 completion-delivery receipt contract', () => {
  it('accepts the exact versioned sink receipt and rejects unknown or malformed fields', () => {
    expect(UniversalV1CompletionDeliveryReceiptWebhookSchema.parse(command)).toEqual(command);
    expect(
      UniversalV1CompletionDeliveryReceiptWebhookSchema.safeParse({
        ...command,
        taskId: command.task_id,
      }).success
    ).toBe(false);
    expect(
      UniversalV1CompletionDeliveryReceiptWebhookSchema.safeParse({
        ...command,
        provider_delivery_id: '../forbidden',
      }).success
    ).toBe(false);
    expect(
      UniversalV1CompletionDeliveryReceiptWebhookSchema.safeParse({
        ...command,
        expected_execution_version: 2_147_483_648,
      }).success
    ).toBe(false);
  });

  it('binds the digest to every command field and authenticated service identity', () => {
    const digest = universalV1CompletionDeliveryReceiptHash(sink, command);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      universalV1CompletionDeliveryReceiptHash(sink, {
        ...command,
        expected_execution_version: command.expected_execution_version + 1,
      })
    ).not.toBe(digest);
    expect(
      universalV1CompletionDeliveryReceiptHash(
        {
          ...sink,
          actorUserId: '00000000-0000-4000-8000-000000000099',
          serviceIdentity:
            'hustlexp.synthetic-communications-sink.v1:00000000-0000-4000-8000-000000000099',
        },
        command
      )
    ).not.toBe(digest);
  });
});
