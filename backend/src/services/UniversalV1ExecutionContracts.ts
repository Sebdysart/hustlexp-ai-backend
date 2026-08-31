import { createHash } from 'node:crypto';

import { z } from 'zod';

const uuid = z.string().uuid();
const idempotencyKey = z
  .string()
  .trim()
  .min(16)
  .max(96)
  .regex(/^[A-Za-z0-9:_-]+$/u);

export const UniversalV1ExecutionStateSchema = z.enum([
  'MATERIALIZED',
  'ACKNOWLEDGED',
  'EN_ROUTE',
  'ARRIVED',
  'IN_PROGRESS',
  'PAUSED',
  'COMPLETION_SUBMITTED',
  'REWORK_REQUIRED',
  'COMPLETED',
]);

export const UniversalV1ExecutionActionSchema = z.enum([
  'ACKNOWLEDGE',
  'MARK_EN_ROUTE',
  'MARK_ARRIVED',
  'START_WORK',
  'PAUSE_WORK',
  'RESUME_WORK',
  'RESUME_REWORK',
]);

export const GetUniversalV1WorkOrderExecutionStatePublicSchema = z
  .object({
    work_order_id: uuid,
  })
  .strict();

export const AdvanceUniversalV1WorkOrderExecutionPublicSchema = z
  .object({
    work_order_id: uuid,
    action: UniversalV1ExecutionActionSchema,
    expected_execution_version: z.number().int().nonnegative(),
    expected_scope_version: z.number().int().positive(),
    idempotency_key: idempotencyKey,
    client_ts: z.string().datetime(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.action === 'PAUSE_WORK' && !input.reason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A bounded reason is required when pausing work.',
      });
    }
    if (input.action !== 'PAUSE_WORK' && input.reason !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A reason is accepted only when pausing work.',
      });
    }
  });

export type UniversalV1ExecutionState = z.infer<typeof UniversalV1ExecutionStateSchema>;
export type UniversalV1ExecutionAction = z.infer<typeof UniversalV1ExecutionActionSchema>;
export type GetUniversalV1WorkOrderExecutionStatePublic = z.infer<
  typeof GetUniversalV1WorkOrderExecutionStatePublicSchema
>;
export type AdvanceUniversalV1WorkOrderExecutionPublic = z.infer<
  typeof AdvanceUniversalV1WorkOrderExecutionPublicSchema
>;

export type UniversalV1ExecutionTransitionKind =
  | 'MATERIALIZED'
  | UniversalV1ExecutionAction
  | 'APPLY_AMENDMENT'
  | 'COMPLETION_SUBMITTED'
  | 'COMPLETION_APPROVED'
  | 'COMPLETION_REJECTED';

export interface UniversalV1ExecutionStateResult {
  execution_fact_id: string;
  work_order_id: string;
  task_id: string;
  scope_version_id: string;
  scope_version: number;
  execution_version: number;
  state: UniversalV1ExecutionState;
  transition_kind: UniversalV1ExecutionTransitionKind;
  recorded_at: string;
  hard_assignment_created: false;
  payment_creation_performed: false;
}

export interface UniversalV1ExecutionAdvanceResult extends UniversalV1ExecutionStateResult {
  replayed: boolean;
}

export type UniversalV1ExecutionErrorCode =
  | 'EXECUTION_CONTEXT_UNAVAILABLE'
  | 'EXECUTION_REQUEST_STALE'
  | 'EXECUTION_VERSION_CONFLICT'
  | 'EXECUTION_IDEMPOTENCY_CONFLICT'
  | 'EXECUTION_INVALID_TRANSITION'
  | 'EXECUTION_PROVIDER_AUTHORITY_REVOKED'
  | 'EXECUTION_INCIDENT_BLOCKED'
  | 'EXECUTION_SCOPE_CHANGE_PENDING'
  | 'EXECUTION_HARD_ASSIGNMENT_FORBIDDEN';

export class UniversalV1ExecutionError extends Error {
  constructor(
    readonly code: UniversalV1ExecutionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'UniversalV1ExecutionError';
  }
}

const transitions: Readonly<
  Partial<
    Record<
      UniversalV1ExecutionState,
      Partial<Record<UniversalV1ExecutionAction, UniversalV1ExecutionState>>
    >
  >
> = {
  MATERIALIZED: { ACKNOWLEDGE: 'ACKNOWLEDGED' },
  ACKNOWLEDGED: {
    MARK_EN_ROUTE: 'EN_ROUTE',
    MARK_ARRIVED: 'ARRIVED',
    START_WORK: 'IN_PROGRESS',
  },
  EN_ROUTE: { MARK_ARRIVED: 'ARRIVED' },
  ARRIVED: { START_WORK: 'IN_PROGRESS' },
  IN_PROGRESS: { PAUSE_WORK: 'PAUSED' },
  PAUSED: { RESUME_WORK: 'IN_PROGRESS' },
  REWORK_REQUIRED: { RESUME_REWORK: 'IN_PROGRESS' },
};

export function resolveUniversalV1ExecutionTransition(
  state: UniversalV1ExecutionState,
  action: UniversalV1ExecutionAction
): UniversalV1ExecutionState | null {
  return transitions[state]?.[action] ?? null;
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

export function universalV1ExecutionRequestSha256(
  actorUserId: string,
  input: AdvanceUniversalV1WorkOrderExecutionPublic
): string {
  return createHash('sha256')
    .update(
      stableJson({
        actor_user_id: actorUserId.toLowerCase(),
        command: {
          ...input,
          client_ts: new Date(input.client_ts).toISOString(),
          work_order_id: input.work_order_id.toLowerCase(),
        },
        contract_version: 1,
        operation: 'ADVANCE_WORK_ORDER_EXECUTION',
      })
    )
    .digest('hex');
}
