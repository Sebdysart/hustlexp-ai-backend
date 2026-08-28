import { createHash } from 'node:crypto';

import { z } from 'zod';

const uuid = z.string().uuid();
const idempotencyKey = z
  .string()
  .trim()
  .min(16)
  .max(96)
  .regex(/^[A-Za-z0-9:_-]+$/u);
const clientTimestamp = z.string().datetime();
const description = z.string().trim().min(3).max(2_000);
const photoEvidence = z
  .object({
    uploadReceiptId: uuid,
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    fileSizeBytes: z
      .number()
      .int()
      .positive()
      .max(25 * 1024 * 1024),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    capturedAt: z.string().datetime().optional(),
  })
  .strict();

const evidencePayload = {
  work_order_id: uuid,
  expected_scope_version: z.number().int().positive(),
  expected_execution_version: z.number().int().positive(),
  description: description.optional(),
  photo_evidence: z.array(photoEvidence).max(10).default([]),
  idempotency_key: idempotencyKey,
  client_ts: clientTimestamp,
} as const;

function requireEvidence(
  value: { description?: string; photo_evidence: readonly unknown[] },
  context: z.RefinementCtx
): void {
  if (!value.description && value.photo_evidence.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['description'],
      message: 'A description or receipt-backed photo is required.',
    });
  }
}

export const RecordUniversalV1ExecutionEvidencePublicSchema = z
  .object({
    ...evidencePayload,
    evidence_kind: z.enum(['BEFORE', 'PROGRESS']),
  })
  .strict()
  .superRefine(requireEvidence);

export const SubmitUniversalV1CompletionEvidencePublicSchema = z
  .object({
    ...evidencePayload,
    decision_reason: z.string().trim().min(3).max(2_000),
  })
  .strict()
  .superRefine(requireEvidence);

export const DecideUniversalV1CompletionPublicSchema = z
  .object({
    work_order_id: uuid,
    submitted_completion_fact_id: uuid,
    expected_completion_version: z.number().int().positive(),
    expected_execution_version: z.number().int().positive(),
    decision: z.enum(['APPROVED', 'REJECTED']),
    delivery_event_id: uuid.optional(),
    decision_reason: z.string().trim().min(3).max(2_000),
    idempotency_key: idempotencyKey,
    client_ts: clientTimestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === 'APPROVED' && !value.delivery_event_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delivery_event_id'],
        message: 'Approval requires an existing provider-authenticated delivery event.',
      });
    }
    if (value.decision === 'REJECTED' && value.delivery_event_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delivery_event_id'],
        message: 'A rejection cannot claim approval-notice delivery.',
      });
    }
  });

export const CompleteUniversalV1FakeFinancialLifecyclePublicSchema = z
  .object({
    work_order_id: uuid,
    approved_completion_fact_id: uuid,
    path: z.enum(['SETTLED', 'FULL_REFUND']),
    expected_execution_version: z.number().int().positive(),
    expected_financial_version: z.number().int().nonnegative(),
    expected_reconciliation_version: z.number().int().nonnegative(),
    idempotency_key: idempotencyKey,
    client_ts: clientTimestamp,
  })
  .strict();

export type RecordExecutionEvidencePublic = z.infer<
  typeof RecordUniversalV1ExecutionEvidencePublicSchema
>;
export type SubmitCompletionEvidencePublic = z.infer<
  typeof SubmitUniversalV1CompletionEvidencePublicSchema
>;
export type DecideCompletionPublic = z.infer<typeof DecideUniversalV1CompletionPublicSchema>;
export type CompleteFakeFinancialLifecyclePublic = z.infer<
  typeof CompleteUniversalV1FakeFinancialLifecyclePublicSchema
>;

export type UniversalV1FulfillmentErrorCode =
  | 'FULFILLMENT_CONTEXT_UNAVAILABLE'
  | 'FULFILLMENT_REQUEST_STALE'
  | 'FULFILLMENT_VERSION_CONFLICT'
  | 'FULFILLMENT_IDEMPOTENCY_CONFLICT'
  | 'FULFILLMENT_PROVIDER_AUTHORITY_REVOKED'
  | 'FULFILLMENT_CUSTOMER_AUTHORITY_REQUIRED'
  | 'FULFILLMENT_EVIDENCE_STATE_CONFLICT'
  | 'FULFILLMENT_COMPLETION_STATE_CONFLICT'
  | 'FULFILLMENT_INCIDENT_BLOCKED'
  | 'FULFILLMENT_PROVIDER_ACCOUNT_UNAVAILABLE'
  | 'FULFILLMENT_FAKE_FINANCE_ONLY'
  | 'FULFILLMENT_HARD_ASSIGNMENT_FORBIDDEN';

export class UniversalV1FulfillmentError extends Error {
  constructor(
    readonly code: UniversalV1FulfillmentErrorCode,
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

export function universalV1FulfillmentCommandHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}
