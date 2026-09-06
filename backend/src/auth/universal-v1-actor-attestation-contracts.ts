import { WorkOrderHistoryPayloadSchema } from './work-order-history-command-contract.js';
import { ChangeOrderHistoryPayloadSchema } from './change-order-history-command-contract.js';
import {
  ChangeOrderKindPayloadSchema,
  PrepareChangeOrderPayloadSchema,
  FinalizeChangeOrderPayloadSchema,
} from './change-order-materialization-command-contract.js';
import {
  ProposeChangeOrderPayloadSchema,
  DecideChangeOrderPayloadSchema,
} from './change-order-command-contract.js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';
import { FakeFinancialPreparationPayloadSchema } from './financial-preparation-command-contract.js';
import { FakeFinancialProgressPayloadSchema } from './financial-progress-command-contract.js';
import { FakeFinancialPredecessorPayloadSchema } from './financial-predecessor-command-contract.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const RELEASE_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{16,96}$/u;
const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/u;
const CANONICAL_MILLISECOND_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const UNIVERSAL_V1_ACTOR_ATTESTATION_PATH =
  '/internal/v1/universal-v1/actor-assertions' as const;
// Full bounded ChangeOrder scopes include up to 50 checklist entries and two
// 5,000-character fields. The transport must carry the complete signed payload.
export const UNIVERSAL_V1_ACTOR_ATTESTATION_BODY_LIMIT_BYTES = 262_144;
export const UNIVERSAL_V1_ACTOR_ATTESTATION_RESPONSE_LIMIT_BYTES = 4_096;
export const UNIVERSAL_V1_ACTOR_ATTESTATION_MAX_CLOCK_SKEW_MS = 30_000;

export const UniversalV1ActorEnvironmentSchema = z.enum(['local', 'preview', 'staging']);
export type UniversalV1ActorEnvironment = z.infer<typeof UniversalV1ActorEnvironmentSchema>;

export const UniversalV1ActorCommandKindSchema = z.enum([
  'PREPARE_FAKE_FINANCIAL_COMMAND',
  'READ_FAKE_FINANCIAL_REQUEST_PROGRESS',
  'READ_FAKE_FINANCIAL_PREDECESSOR',
  'READ_FAKE_WORK_ORDER_HISTORY',
  'READ_FAKE_CHANGE_ORDER_HISTORY',
  'PROPOSE_FAKE_CHANGE_ORDER',
  'READ_FAKE_CHANGE_ORDER_KIND',
  'PREPARE_FAKE_CHANGE_ORDER',
  'FINALIZE_FAKE_CHANGE_ORDER',
  'DECIDE_FAKE_CHANGE_ORDER',
  'EXPRESS_POST_ESTIMATE_INTEREST',
  'PLACE_CONDITIONAL_HOLD',
  'PREPARE_FAKE_WORK_ORDER',
  'MATERIALIZE_FAKE_WORK_ORDER',
  'REQUEST_FAKE_WORK_ORDER_RECOVERY',
]);
export type UniversalV1ActorCommandKind = z.infer<typeof UniversalV1ActorCommandKindSchema>;

const uuid = z.string().uuid();
const expectedVersion = z.number().int().positive();
const idempotencyKey = z.string().regex(IDEMPOTENCY_KEY);
const timestampEpochMs = z.number().int().safe().nonnegative();

const commandPayloadSchemas = {
  PREPARE_FAKE_FINANCIAL_COMMAND: FakeFinancialPreparationPayloadSchema,
  READ_FAKE_FINANCIAL_REQUEST_PROGRESS: FakeFinancialProgressPayloadSchema,
  READ_FAKE_FINANCIAL_PREDECESSOR: FakeFinancialPredecessorPayloadSchema,
  READ_FAKE_WORK_ORDER_HISTORY: WorkOrderHistoryPayloadSchema,
  READ_FAKE_CHANGE_ORDER_HISTORY: ChangeOrderHistoryPayloadSchema,
  PROPOSE_FAKE_CHANGE_ORDER: ProposeChangeOrderPayloadSchema,
  READ_FAKE_CHANGE_ORDER_KIND: ChangeOrderKindPayloadSchema,
  PREPARE_FAKE_CHANGE_ORDER: PrepareChangeOrderPayloadSchema,
  FINALIZE_FAKE_CHANGE_ORDER: FinalizeChangeOrderPayloadSchema,
  DECIDE_FAKE_CHANGE_ORDER: DecideChangeOrderPayloadSchema,
  EXPRESS_POST_ESTIMATE_INTEREST: z
    .object({
      task_id: uuid,
      expected_scope_version: expectedVersion,
      idempotency_key: idempotencyKey,
      client_timestamp_epoch_ms: timestampEpochMs,
    })
    .strict(),
  PLACE_CONDITIONAL_HOLD: z
    .object({
      interest_application_id: uuid,
      expected_eligibility_version: expectedVersion,
      idempotency_key: idempotencyKey,
      client_timestamp_epoch_ms: timestampEpochMs,
    })
    .strict(),
  PREPARE_FAKE_WORK_ORDER: z
    .object({
      conditional_hold_id: uuid,
      expected_eligibility_version: expectedVersion,
      idempotency_key: idempotencyKey,
      client_timestamp_epoch_ms: timestampEpochMs,
    })
    .strict(),
  MATERIALIZE_FAKE_WORK_ORDER: z
    .object({
      idempotency_key: idempotencyKey,
      request_sha256: z.string().regex(SHA256),
      secured_event_id: uuid,
    })
    .strict(),
  REQUEST_FAKE_WORK_ORDER_RECOVERY: z
    .object({
      idempotency_key: idempotencyKey,
      request_sha256: z.string().regex(SHA256),
      secured_event_id: uuid,
    })
    .strict(),
} satisfies Record<UniversalV1ActorCommandKind, z.ZodType<Record<string, unknown>>>;

export type UniversalV1ActorCommand = {
  readonly [Kind in UniversalV1ActorCommandKind]: {
    readonly commandKind: Kind;
    readonly commandPayload: z.infer<(typeof commandPayloadSchemas)[Kind]>;
  };
}[UniversalV1ActorCommandKind];

export function parseUniversalV1ActorCommandPayload(
  commandKind: UniversalV1ActorCommandKind,
  commandPayload: unknown
): Record<string, unknown> {
  return commandPayloadSchemas[commandKind].parse(commandPayload);
}

export const UniversalV1AuthenticationRequirementsSchema = z
  .object({
    mfa_required: z.literal(false),
    step_up_required: z.literal(false),
    max_auth_age_seconds: z.literal(300),
    max_step_up_age_seconds: z.null(),
  })
  .strict();

export const UniversalV1ActorTargetAuthoritySchema = z
  .object({
    id: uuid,
    version: z.number().int().positive().max(999_999_999),
    database: z.string().regex(DATABASE_NAME),
    environment: UniversalV1ActorEnvironmentSchema,
    release: z.string().regex(RELEASE_SHA256),
  })
  .strict();

export type UniversalV1ActorTargetAuthority = z.infer<typeof UniversalV1ActorTargetAuthoritySchema>;

export const UniversalV1CanonicalActorRequestSchema = z
  .object({
    schema_version: z.literal(1),
    command_kind: UniversalV1ActorCommandKindSchema,
    release_manifest_sha256: z.string().regex(RELEASE_SHA256),
    target_authority: UniversalV1ActorTargetAuthoritySchema,
    authentication_requirements: UniversalV1AuthenticationRequirementsSchema,
    command_payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type UniversalV1CanonicalActorRequest = z.infer<
  typeof UniversalV1CanonicalActorRequestSchema
>;

export const UniversalV1ActorAttestationTransportBodySchema = z
  .object({
    schema_version: z.literal(1),
    environment: UniversalV1ActorEnvironmentSchema,
    command_kind: UniversalV1ActorCommandKindSchema,
    canonical_request: UniversalV1CanonicalActorRequestSchema,
    canonical_request_sha256: z.string().regex(SHA256),
  })
  .strict()
  .superRefine((body, context) => {
    if (body.command_kind !== body.canonical_request.command_kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'outer and canonical command kinds must match',
        path: ['canonical_request', 'command_kind'],
      });
    }
    if (body.environment !== body.canonical_request.target_authority.environment) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'outer and target environments must match',
        path: ['canonical_request', 'target_authority', 'environment'],
      });
    }
    if (
      body.canonical_request.release_manifest_sha256 !==
      body.canonical_request.target_authority.release
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'canonical and target releases must match',
        path: ['canonical_request', 'target_authority', 'release'],
      });
    }
    const result = commandPayloadSchemas[body.command_kind].safeParse(
      body.canonical_request.command_payload
    );
    if (!result.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'command payload does not match command kind',
        path: ['canonical_request', 'command_payload'],
      });
    }
  });

export type UniversalV1ActorAttestationTransportBody = z.infer<
  typeof UniversalV1ActorAttestationTransportBodySchema
>;

export const UniversalV1ActorAttestationResponseSchema = z
  .object({
    schema_version: z.literal(1),
    command_kind: UniversalV1ActorCommandKindSchema,
    canonical_request_sha256: z.string().regex(SHA256),
    actor_assertion_token: z.string().regex(SHA256),
    assertion_expires_at: z.string().datetime(),
  })
  .strict();

export type UniversalV1ActorAttestationResponse = z.infer<
  typeof UniversalV1ActorAttestationResponseSchema
>;

export interface UniversalV1ActorAttestationHandle {
  issue(command: UniversalV1ActorCommand): Promise<UniversalV1ActorAttestationResponse>;
}

export function buildUniversalV1CanonicalActorRequest(
  releaseManifestSha256: string,
  command: UniversalV1ActorCommand,
  targetAuthority: UniversalV1ActorTargetAuthority
): UniversalV1CanonicalActorRequest {
  const parsedRelease = z.string().regex(RELEASE_SHA256).parse(releaseManifestSha256);
  const commandPayload = parseUniversalV1ActorCommandPayload(
    command.commandKind,
    command.commandPayload
  );
  const parsedTarget = UniversalV1ActorTargetAuthoritySchema.parse(targetAuthority);
  if (parsedTarget.release !== parsedRelease) {
    throw new Error('UNIVERSAL_V1_ACTOR_ATTESTATION_REFUSED:TARGET_RELEASE_MISMATCH');
  }
  return {
    schema_version: 1,
    command_kind: command.commandKind,
    release_manifest_sha256: parsedRelease,
    target_authority: parsedTarget,
    authentication_requirements: {
      mfa_required: false,
      step_up_required: false,
      max_auth_age_seconds: 300,
      max_step_up_age_seconds: null,
    },
    command_payload: commandPayload,
  };
}

export function clientTimestampEpochMs(value: string): number {
  if (!CANONICAL_MILLISECOND_TIMESTAMP.test(value)) {
    throw new Error('UNIVERSAL_V1_ACTOR_ATTESTATION_REFUSED:CLIENT_TIMESTAMP_INVALID');
  }
  const epochMs = Date.parse(value);
  if (!Number.isSafeInteger(epochMs) || new Date(epochMs).toISOString() !== value) {
    throw new Error('UNIVERSAL_V1_ACTOR_ATTESTATION_REFUSED:CLIENT_TIMESTAMP_INVALID');
  }
  return epochMs;
}

export function sha256LowerHex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function actorAttesterRequestSignaturePayload(input: {
  readonly timestampMs: number;
  readonly nonce: string;
  readonly bodySha256: string;
  readonly bearerSha256: string;
}): string {
  return [
    'HUSTLEXP_UNIVERSAL_V1_ACTOR_ATTESTER_REQUEST_V1',
    String(input.timestampMs),
    input.nonce,
    input.bodySha256,
    input.bearerSha256,
  ].join('\n');
}

export function actorAttesterResponseSignaturePayload(input: {
  readonly requestNonce: string;
  readonly status: number;
  readonly bodySha256: string;
}): string {
  return [
    'HUSTLEXP_UNIVERSAL_V1_ACTOR_ATTESTER_RESPONSE_V1',
    input.requestNonce,
    String(input.status),
    input.bodySha256,
  ].join('\n');
}

export function hmacSha256LowerHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

export function equalLowerHex(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii'));
}
