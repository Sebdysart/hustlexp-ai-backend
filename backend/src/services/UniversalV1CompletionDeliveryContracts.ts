import { createHash } from 'node:crypto';

import { z } from 'zod';

const uuid = z.string().uuid();
const idempotencyKey = z
  .string()
  .trim()
  .min(16)
  .max(96)
  .regex(/^[A-Za-z0-9:_-]+$/u);

export const UniversalV1CompletionDeliveryReceiptWebhookSchema = z
  .object({
    schema_version: z.literal(1),
    event_type: z.literal('COMPLETION_NOTICE_DELIVERED'),
    task_id: uuid,
    work_order_id: uuid,
    submitted_completion_fact_id: uuid,
    expected_completion_version: z.number().int().positive().max(2_147_483_647),
    expected_execution_version: z.number().int().positive().max(2_147_483_647),
    provider_delivery_id: z
      .string()
      .trim()
      .min(8)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u),
    channel: z.enum(['SMS', 'EMAIL', 'PUSH']),
    delivered_at: z.string().datetime({ offset: true }),
    idempotency_key: idempotencyKey,
    client_ts: z.string().datetime({ offset: true }),
  })
  .strict();

export const SYNTHETIC_COMPLETION_DELIVERY_SERVICE_PREFIX =
  'hustlexp.synthetic-communications-sink.v1' as const;

export const AuthenticatedCompletionDeliverySinkSchema = z
  .object({
    providerKind: z.literal('SYNTHETIC_SINK'),
    serviceIdentity: z
      .string()
      .trim()
      .min(3)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u),
    actorUserId: uuid,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.serviceIdentity !==
      `${SYNTHETIC_COMPLETION_DELIVERY_SERVICE_PREFIX}:${value.actorUserId}`
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['serviceIdentity'],
        message: 'The sink service identity must be structurally bound to its actor user ID.',
      });
    }
  });

export type UniversalV1CompletionDeliveryReceiptWebhook = z.infer<
  typeof UniversalV1CompletionDeliveryReceiptWebhookSchema
>;
export type AuthenticatedCompletionDeliverySink = z.infer<
  typeof AuthenticatedCompletionDeliverySinkSchema
>;

export interface UniversalV1CompletionDeliveryReceiptResult {
  delivery_event_id: string;
  task_id: string;
  work_order_id: string;
  submitted_completion_fact_id: string;
  provider_delivery_id: string;
  channel: 'SMS' | 'EMAIL' | 'PUSH';
  delivered_at: string;
  provider_kind: 'SYNTHETIC_SINK';
  provider_service_identity: string;
  idempotency_replayed: boolean;
  payment_creation_performed: false;
  hard_assignment_created: false;
}

export type UniversalV1CompletionDeliveryErrorCode =
  | 'COMPLETION_DELIVERY_CONTEXT_UNAVAILABLE'
  | 'COMPLETION_DELIVERY_REQUEST_STALE'
  | 'COMPLETION_DELIVERY_TIMESTAMP_INVALID'
  | 'COMPLETION_DELIVERY_VERSION_CONFLICT'
  | 'COMPLETION_DELIVERY_STATE_CONFLICT'
  | 'COMPLETION_DELIVERY_IDEMPOTENCY_CONFLICT'
  | 'COMPLETION_DELIVERY_SERVICE_IDENTITY_INVALID';

export class UniversalV1CompletionDeliveryError extends Error {
  constructor(
    readonly code: UniversalV1CompletionDeliveryErrorCode,
    message: string
  ) {
    super(message);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function universalV1CompletionDeliveryReceiptHash(
  sink: AuthenticatedCompletionDeliverySink,
  input: UniversalV1CompletionDeliveryReceiptWebhook
): string {
  return createHash('sha256')
    .update(
      stableJson({
        contract: 'HUSTLEXP_UNIVERSAL_V1_COMPLETION_DELIVERY_RECEIPT_V1',
        sink,
        command: {
          ...input,
          delivered_at: new Date(input.delivered_at).toISOString(),
          client_ts: new Date(input.client_ts).toISOString(),
        },
      })
    )
    .digest('hex');
}
