import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import {
  decodeFakeFinancialOutcomeRow,
  fakeFinancialOutcomeInputSchema,
  fakeFinancialOutcomeReceiptSchema,
  fakeFinancialTimestampMicros as micros,
  withCommittedFakeFinancialOutcomeAuthority,
} from './fake-financial-outcome.js';

const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .refine((value) => value !== '0'.repeat(64));
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine((value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  );
const terminalState = z.enum([
  'SUCCEEDED',
  'VOIDED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'REVERSED',
  'DECLINED',
  'FAILED',
]);
const lifecycleStatus = z.enum(['SUCCEEDED', 'DECLINED', 'FAILED']);
const inputSchema = fakeFinancialOutcomeInputSchema
  .omit({ workerInstanceId: true, recoveryLeaseId: true })
  .extend({ outcomeFactId: uuid })
  .strict();
export type FakeFinancialMaterializationInput = z.infer<typeof inputSchema>;
const eventKinds = {
  PREPARE_PAYMENT_METHOD: 'PAYMENT_METHOD_PREPARED',
  AUTHORIZE: 'AUTHORIZED',
  SECURE: 'SECURED',
  VOID: 'VOIDED',
  ADJUST: 'ADJUSTMENT_AUTHORIZED',
  CAPTURE: 'CAPTURED',
  REFUND: 'REFUNDED',
  REVERSAL: 'REVERSED',
  SETTLE: 'SETTLEMENT_OBSERVED',
  FUND: 'FUNDING_OBSERVED',
  PROVIDER_RELEASE: 'PROVIDER_RELEASED',
  PAYOUT: 'PAYOUT_OBSERVED',
  OBSERVE_BANK_SETTLEMENT: 'BANK_SETTLEMENT_OBSERVED',
} as const;
const eventKind = z.enum([
  'PAYMENT_METHOD_PREPARED',
  'AUTHORIZED',
  'SECURED',
  'VOIDED',
  'ADJUSTMENT_AUTHORIZED',
  'CAPTURED',
  'REFUNDED',
  'REVERSED',
  'SETTLEMENT_OBSERVED',
  'FUNDING_OBSERVED',
  'PROVIDER_RELEASED',
  'PAYOUT_OBSERVED',
  'BANK_SETTLEMENT_OBSERVED',
]);
const roots = {
  task_draft_id: uuid,
  task_id: uuid,
  eligibility_decision_id: uuid,
  scope_version_id: uuid,
  change_order_id: uuid.nullable(),
  completion_fact_id: uuid.nullable(),
  predecessor_event_id: uuid.nullable(),
  recorded_by: uuid,
  amount_cents: integer.refine((value) => value > 0).nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/u)
    .nullable(),
};
const financialEventSchema = z
  .object({
    id: uuid,
    ...roots,
    event_kind: eventKind,
    status: lifecycleStatus,
    operation_id: uuid,
    idempotency_key: z.string(),
    expected_version: integer.max(2_147_483_647),
    provider_kind: z.literal('FAKE'),
    external_reference: z.string(),
    evidence: z
      .object({
        providerState: terminalState,
        providerOperationVersion: integer.refine((value) => value > 0),
        providerIdempotencyReplayed: z.literal(false),
      })
      .strict(),
    occurred_at: timestamp,
    expires_at: timestamp.nullable(),
    created_at: timestamp,
  })
  .strict();
const bridgeSchema = z
  .object({
    bridge_id: uuid,
    prepared_command_id: uuid,
    command_id: uuid,
    dispatch_attempt_id: uuid,
    outcome_fact_id: uuid,
    fake_operation_event_id: uuid,
    task_financial_security_event_id: uuid,
    fake_operation_id: uuid,
    fake_operation_kind: z.enum([
      'PREPARE_PAYMENT_METHOD',
      'AUTHORIZE',
      'SECURE',
      'VOID',
      'ADJUST',
      'CAPTURE',
      'REFUND',
      'REVERSAL',
      'SETTLE',
      'FUND',
      'PROVIDER_RELEASE',
      'PAYOUT',
      'OBSERVE_BANK_SETTLEMENT',
    ]),
    fake_event_version: integer.refine((value) => value > 0),
    fake_provider_state: terminalState,
    lifecycle_event_kind: eventKind,
    lifecycle_status: lifecycleStatus,
    provider_expected_version: integer,
    lifecycle_expected_version: integer.max(2_147_483_647),
    ...roots,
    related_operation_id: uuid.nullable(),
    prepared_authority_sha256: digest,
    provider_request_sha256: digest,
    command_identity_sha256: digest,
    dispatch_attempt_identity_sha256: digest,
    outcome_identity_sha256: digest,
    fake_operation_identity_sha256: digest,
    fake_event_request_sha256: digest,
    fake_event_response_sha256: digest,
    external_reference_sha256: digest,
    lifecycle_event_identity_sha256: digest,
    authority_chain_sha256: digest,
    provider_recorded_at: timestamp,
    provider_expires_at: timestamp.nullable(),
    expiry_authority_sha256: digest,
    materialized_at: timestamp,
  })
  .strict();
const resolvedBridgeSchema = bridgeSchema
  .extend({
    resolution_contract_version: z.literal(1),
    resolution_observation_id: uuid,
    resolution_receipt_id: uuid,
    resolution_identity_sha256: digest,
  })
  .strict();
const responseSchema = fakeFinancialOutcomeReceiptSchema
  .extend({
    financial_event: financialEventSchema,
    lifecycle_bridge: z.union([bridgeSchema, resolvedBridgeSchema]),
  })
  .strict();
const hash = (parts: readonly (string | number | null)[]) =>
  createHash('sha256')
    .update(parts.map((value) => value ?? '').join(':'))
    .digest('hex');
function refuse(reason: string): never {
  throw new Error(`FAKE_FINANCIAL_MATERIALIZATION_${reason}`);
}

/** Materializes only an exact previously committed outcome through the sealed DB
 * port. Lost COMMIT acknowledgements propagate; the caller retains these IDs for
 * explicit recovery. Neither this receipt nor an expired recording lease grants
 * permission to dispatch a provider again. */
export async function materializeFakeFinancialEvent(value: FakeFinancialMaterializationInput) {
  const input = inputSchema.parse(value);
  if (
    input.jobId !==
    `hx-fake-fin-${input.payload.commandId.replaceAll('-', '')}-${input.payload.jobAuthoritySha256}`
  )
    return refuse('JOB_IDENTITY_MISMATCH');
  Object.freeze(input.payload);
  Object.freeze(input);
  return withCommittedFakeFinancialOutcomeAuthority((authority) =>
    db.transaction(async (query) => {
      const result = await query(
        'SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)',
        [input.jobValidationId, input.outcomeFactId]
      );
      if (result.rowCount !== 1 || result.rows.length !== 1) return refuse('CARDINALITY');
      return decodeFakeFinancialMaterializationRow(result.rows[0], input, authority);
    })
  );
}

/** Pure receipt validation; does not issue any runtime capability or DB write. */
export function decodeFakeFinancialMaterializationRow(
  value: unknown,
  input: FakeFinancialMaterializationInput,
  authority: Parameters<typeof decodeFakeFinancialOutcomeRow>[2]
) {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) return refuse('RESPONSE_INVALID');
  const { financial_event: event, lifecycle_bridge: bridge, ...outcomeRow } = parsed.data;
  // The recorded lease belongs to the durable outcome, not to this restarted
  // reader. Its original DISPATCH/RECONCILE binding is verified by the shared decoder.
  const recorded = decodeFakeFinancialOutcomeRow(
    { ...outcomeRow, idempotency_replayed: true },
    {
      jobId: input.jobId,
      payload: input.payload,
      jobValidationId: input.jobValidationId,
      workerInstanceId: outcomeRow.recovery_lease.lease_owner_id,
      recoveryLeaseId: outcomeRow.recovery_lease.recovery_lease_id,
    },
    authority
  );
  const { admission, outcome, observation, resolution } = recorded;
  if (
    outcome.outcome_fact_id !== input.outcomeFactId ||
    outcome.outcome_kind !== 'OUTCOME_OBSERVED' ||
    outcome.retryable ||
    outcome.recovery_not_before !== null ||
    !observation ||
    !terminalState.safeParse(outcome.provider_state).success
  )
    return refuse('TERMINAL_OUTCOME_REQUIRED');
  const raw = observation.event;
  const effective = resolution?.providerResult ?? raw;
  const resolutionParts: (string | number)[] = [];
  if (resolution) {
    if (
      !('resolution_contract_version' in bridge) ||
      bridge.resolution_contract_version !== resolution.evidence.contract_version ||
      bridge.resolution_observation_id !== resolution.evidence.observation_id ||
      bridge.resolution_receipt_id !== resolution.evidence.receipt_id ||
      bridge.resolution_identity_sha256 !== resolution.evidence.resolution_identity_sha256
    )
      return refuse('RESOLUTION_PROVENANCE_MISMATCH');
    resolutionParts.push(
      1,
      bridge.resolution_observation_id,
      bridge.resolution_receipt_id,
      bridge.resolution_identity_sha256
    );
  } else if ('resolution_contract_version' in bridge) {
    return refuse('RESOLUTION_PROVENANCE_MISMATCH');
  }
  const witness = admission.evidence;
  const expectedStatus =
    effective.state === 'DECLINED'
      ? 'DECLINED'
      : effective.state === 'FAILED'
        ? 'FAILED'
        : 'SUCCEEDED';
  if (
    event.operation_id !== witness.operation_id ||
    event.idempotency_key !== witness.idempotency_key ||
    event.event_kind !== eventKinds[admission.durableRequest.operationKind] ||
    event.status !== expectedStatus ||
    event.external_reference !== raw.externalReference ||
    event.amount_cents !== outcome.amount_cents ||
    event.currency !== outcome.currency ||
    event.evidence.providerState !== effective.state ||
    event.evidence.providerOperationVersion !== raw.version ||
    micros(event.occurred_at) !== micros(effective.recordedAt) ||
    (event.expires_at === null
      ? effective.expiresAt !== null
      : effective.expiresAt === null || micros(event.expires_at) !== micros(effective.expiresAt))
  )
    return refuse('EVENT_PROJECTION_MISMATCH');
  if (
    (raw.operationKind === 'PREPARE_PAYMENT_METHOD'
      ? event.status !== 'SUCCEEDED' ||
        event.expected_version !== 0 ||
        event.predecessor_event_id !== null ||
        event.completion_fact_id !== null ||
        event.amount_cents !== null ||
        event.currency !== null ||
        event.change_order_id !== null
      : event.expected_version === 0 || event.predecessor_event_id === null) ||
    (raw.operationKind === 'ADJUST') !== (event.change_order_id !== null) ||
    (raw.operationKind === 'CAPTURE' && event.completion_fact_id === null)
  )
    return refuse('EVENT_LIFECYCLE_INVALID');
  if (
    bridge.prepared_command_id !== witness.prepared_command_id ||
    bridge.command_id !== witness.command_id ||
    bridge.dispatch_attempt_id !== witness.dispatch_attempt_id ||
    bridge.outcome_fact_id !== input.outcomeFactId ||
    bridge.fake_operation_event_id !== raw.eventId ||
    bridge.task_financial_security_event_id !== event.id ||
    bridge.fake_operation_id !== raw.operationId ||
    bridge.fake_operation_kind !== raw.operationKind ||
    bridge.fake_event_version !== raw.version ||
    bridge.fake_provider_state !== effective.state ||
    bridge.lifecycle_event_kind !== event.event_kind ||
    bridge.lifecycle_status !== event.status ||
    bridge.provider_expected_version !== witness.provider_expected_version ||
    bridge.lifecycle_expected_version !== event.expected_version ||
    bridge.related_operation_id !== raw.relatedOperationId ||
    bridge.prepared_authority_sha256 !== witness.prepared_authority_sha256 ||
    bridge.provider_request_sha256 !== witness.provider_request_sha256 ||
    bridge.command_identity_sha256 !== witness.command_identity_sha256 ||
    bridge.outcome_identity_sha256 !== outcome.outcome_identity_sha256 ||
    bridge.fake_operation_identity_sha256 !== raw.identitySha256 ||
    bridge.fake_event_request_sha256 !== raw.requestSha256 ||
    bridge.fake_event_response_sha256 !== raw.responseSha256 ||
    bridge.external_reference_sha256 !== outcome.external_reference_sha256 ||
    (Object.keys(roots) as (keyof typeof roots)[]).some((key) => bridge[key] !== event[key])
  )
    return refuse('BRIDGE_BINDING_MISMATCH');
  if (
    micros(bridge.provider_recorded_at) !== micros(effective.recordedAt) ||
    (bridge.provider_expires_at === null
      ? effective.expiresAt !== null
      : effective.expiresAt === null ||
        micros(bridge.provider_expires_at) !== micros(effective.expiresAt)) ||
    bridge.expiry_authority_sha256 !==
      hash([
        ...(resolution ? ['HUSTLEXP_UNIVERSAL_V1_FAKE_EXPIRY_RESOLUTION_V1'] : []),
        raw.eventId,
        event.id,
        micros(effective.recordedAt).toString(),
        effective.expiresAt === null ? 'NO_EXPIRY' : micros(effective.expiresAt).toString(),
        ...resolutionParts,
      ])
  )
    return refuse('EXPIRY_AUTHORITY_MISMATCH');
  const lifecycleHash = hash([
    resolution
      ? 'HUSTLEXP_UNIVERSAL_V1_FAKE_LIFECYCLE_EVENT_RESOLUTION_V1'
      : 'HUSTLEXP_UNIVERSAL_V1_FAKE_LIFECYCLE_EVENT_V1',
    event.id,
    event.operation_id,
    event.event_kind,
    event.status,
    event.expected_version,
    event.task_draft_id,
    event.task_id,
    event.eligibility_decision_id,
    event.scope_version_id,
    event.change_order_id,
    event.completion_fact_id,
    event.predecessor_event_id,
    event.amount_cents,
    event.currency,
    event.recorded_by,
    raw.eventId,
    raw.responseSha256,
    ...resolutionParts,
  ]);
  if (
    bridge.lifecycle_event_identity_sha256 !== lifecycleHash ||
    bridge.authority_chain_sha256 !==
      hash([
        resolution
          ? 'HUSTLEXP_UNIVERSAL_V1_FAKE_FINANCIAL_LIFECYCLE_BRIDGE_RESOLUTION_V1'
          : 'HUSTLEXP_UNIVERSAL_V1_FAKE_FINANCIAL_LIFECYCLE_BRIDGE_V1',
        witness.prepared_command_id,
        witness.prepared_authority_sha256,
        witness.command_id,
        witness.command_identity_sha256,
        witness.dispatch_attempt_id,
        bridge.dispatch_attempt_identity_sha256,
        outcome.outcome_fact_id,
        outcome.outcome_identity_sha256,
        raw.operationId,
        raw.operationKind,
        raw.identitySha256,
        raw.eventId,
        raw.version,
        raw.providerRequestSha256,
        raw.requestSha256,
        raw.responseSha256,
        event.id,
        lifecycleHash,
        ...resolutionParts,
      ])
  )
    return refuse('BRIDGE_HASH_MISMATCH');
  return Object.freeze({
    ...recorded,
    financialEvent: Object.freeze({ ...event, evidence: Object.freeze(event.evidence) }),
    lifecycleBridge: Object.freeze(bridge),
    idempotencyReplayed: parsed.data.idempotency_replayed,
    providerExecutionCapability: false as const,
    positiveMoneyCapability: false as const,
    productionCapability: false as const,
  });
}
