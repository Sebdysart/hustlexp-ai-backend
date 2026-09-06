import { createHash } from 'node:crypto';

import { clientTimestampEpochMs } from '../auth/universal-v1-actor-attestation-contracts.js';
import { db, type Database, type QueryFn } from '../db.js';
import {
  type HoldContext,
  type ProviderInterestContext,
  UniversalV1WorkOrderError,
  type WorkOrderContext,
} from './UniversalV1WorkOrderContracts.js';

const ASSERTION_TOKEN = /^[0-9a-f]{64}$/u;

export interface InterestResult {
  interest_application_id: string;
  eligibility_decision_id: string;
  eligibility_version: number;
  replayed: boolean;
}

export interface HoldResult {
  conditional_hold_id: string;
  expires_at: string;
  replayed: boolean;
}

export interface WorkOrderResult {
  work_order_id: string;
  financial_security_event_id: string;
  replayed: boolean;
  hard_assignment_created: false;
  payment_creation_performed: false;
}

export interface WorkOrderCompensationCommand {
  compensation_command_id: string;
  work_order_idempotency_key: string;
  task_draft_id: string;
  task_id: string;
  scope_version_id: string;
  eligibility_decision_id: string;
  secured_event_id: string;
  secured_operation_id: string;
  void_operation_id: string;
  void_idempotency_key: string;
  amount_cents: number;
  currency: string;
  requested_by: string;
  created_at: string;
}

export type WorkOrderCompensationResolution =
  | { completed: true; result: WorkOrderResult }
  | { completed: false; command: WorkOrderCompensationCommand };

export type WorkOrderMaterializationPhase =
  | { completed: true; result: WorkOrderResult }
  | {
      completed: false;
      context: WorkOrderContext;
      idempotencyKey: string;
      requestSha256: string;
      occurredAt: string;
    };

interface PortSafetyResult {
  hard_assignment_created: boolean;
  payment_creation_performed: boolean;
}

interface InterestPortRow extends PortSafetyResult {
  interest_application_id: string;
  eligibility_decision_id: string;
  eligibility_version: number;
  replayed: boolean;
}

interface HoldPortRow extends PortSafetyResult {
  conditional_hold_id: string;
  expires_at: string | Date;
  replayed: boolean;
}

interface PreparePortRow extends PortSafetyResult {
  completed: boolean;
  work_order_id: string | null;
  financial_security_event_id: string | null;
  task_id: string | null;
  task_draft_id: string | null;
  scope_version_id: string | null;
  scope_version: number | null;
  routing_decision_id: string | null;
  provider_user_id: string | null;
  provider_organization_id: string | null;
  provider_class: WorkOrderContext['provider_class'] | null;
  trade_credential_id: string | null;
  predecessor_eligibility_id: string | null;
  predecessor_eligibility_version: number | null;
  predecessor_valid_until: string | Date | null;
  poster_user_id: string | null;
  interest_application_id: string | null;
  eligibility_decision_id: string | null;
  eligibility_version: number | null;
  eligibility_valid_until: string | Date | null;
  conditional_hold_id: string | null;
  hold_reserved_at: string | Date | null;
  hold_expires_at: string | Date | null;
  provider_estimate_submission_id: string | null;
  customer_total_cents: string | number | null;
  currency: string | null;
  idempotency_key: string | null;
  request_sha256: string | null;
  occurred_at: string | Date | null;
  replayed: boolean;
}

interface MaterializePortRow extends PortSafetyResult {
  work_order_id: string;
  financial_security_event_id: string;
  replayed: boolean;
}

interface RecoveryPortRow extends PortSafetyResult {
  completed: boolean;
  work_order_id: string | null;
  financial_security_event_id: string | null;
  compensation_command_id: string | null;
  work_order_idempotency_key: string;
  task_draft_id: string;
  task_id: string;
  scope_version_id: string;
  eligibility_decision_id: string;
  compensation_secured_event_id: string;
  secured_operation_id: string | null;
  void_operation_id: string | null;
  void_idempotency_key: string | null;
  amount_cents: string | number;
  currency: string;
  requested_by: string;
  created_at: string | Date | null;
  replayed: boolean;
}

export function transactionBoundDatabase(query: QueryFn, outer: Database): Database {
  return {
    ...outer,
    query,
    readQuery: query,
    transaction: (fn) => fn(query),
    serializableTransaction: (fn) => fn(query),
  };
}

function exactAssertionToken(value: string): string {
  if (!ASSERTION_TOKEN.test(value) || /^0{64}$/u.test(value)) {
    throw new UniversalV1WorkOrderError(
      'WORK_ORDER_AUTHORITY_REVOKED',
      'A current one-time actor assertion is required.'
    );
  }
  return value;
}

function exactClientTimestamp(value: string): string {
  try {
    clientTimestampEpochMs(value);
  } catch {
    throw new UniversalV1WorkOrderError(
      'WORK_ORDER_REQUEST_STALE',
      'An exact client timestamp is required.'
    );
  }
  return value;
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function portSafety(row: PortSafetyResult): void {
  if (row.hard_assignment_created) {
    throw new UniversalV1WorkOrderError(
      'WORK_ORDER_HARD_ASSIGNMENT_FORBIDDEN',
      'Universal V1 Work Orders cannot create hard assignment.'
    );
  }
  if (row.payment_creation_performed) {
    throw new UniversalV1WorkOrderError(
      'WORK_ORDER_MATERIALIZATION_FAILED',
      'Production payment creation is frozen.'
    );
  }
}

function oneRow<T>(rows: readonly T[], operation: string): T {
  if (rows.length !== 1 || !rows[0]) {
    throw new UniversalV1WorkOrderError(
      'WORK_ORDER_MATERIALIZATION_FAILED',
      `${operation} did not return exactly one authoritative result.`
    );
  }
  return rows[0];
}

function required<T>(value: T | null | undefined, field: string): T {
  if (value === null || value === undefined || value === '') {
    throw new UniversalV1WorkOrderError(
      'WORK_ORDER_MATERIALIZATION_FAILED',
      `The sealed Work Order result omitted ${field}.`
    );
  }
  return value;
}

function translatePortFailure(error: unknown): never {
  if (error instanceof UniversalV1WorkOrderError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/HXUV1-WOCMD-(?:11|21|32|41|51|55)/u.test(message)) {
    throw new UniversalV1WorkOrderError(
      'WORK_ORDER_IDEMPOTENCY_CONFLICT',
      'The exact Work Order command binding changed.'
    );
  }
  if (/HXUV1-WOCMD-(?:47|53)/u.test(message)) {
    throw new UniversalV1WorkOrderError(
      'WORK_ORDER_HARD_ASSIGNMENT_FORBIDDEN',
      'Universal V1 Work Orders cannot create hard assignment.'
    );
  }
  if (/HXUV1-(?:ACTOR|WOCMD)-[0-9]+/u.test(message)) {
    throw new UniversalV1WorkOrderError(
      'WORK_ORDER_AUTHORITY_REVOKED',
      'The sealed Work Order authority is unavailable.'
    );
  }
  throw new UniversalV1WorkOrderError(
    'WORK_ORDER_MATERIALIZATION_FAILED',
    'The sealed Work Order command failed closed.'
  );
}

export class PostgresUniversalV1WorkOrderRepository {
  constructor(private readonly database: Database = db) {}

  async express(
    context: ProviderInterestContext,
    actorAssertionToken: string,
    idempotencyKey: string,
    clientTimestamp: string
  ): Promise<InterestResult> {
    try {
      return await this.database.serializableTransaction(async (query) => {
        const result = await query<InterestPortRow>(
          `SELECT * FROM public.hxos_express_universal_v1_post_estimate_interest_v1(
             $1, $2, $3, $4, $5
           )`,
          [
            exactAssertionToken(actorAssertionToken),
            context.task_id,
            context.scope_version,
            idempotencyKey,
            exactClientTimestamp(clientTimestamp),
          ]
        );
        const row = oneRow(result.rows, 'Provider interest');
        portSafety(row);
        return {
          interest_application_id: row.interest_application_id,
          eligibility_decision_id: row.eligibility_decision_id,
          eligibility_version: Number(row.eligibility_version),
          replayed: row.replayed,
        };
      });
    } catch (error) {
      return translatePortFailure(error);
    }
  }

  async hold(
    context: HoldContext,
    actorAssertionToken: string,
    idempotencyKey: string,
    clientTimestamp: string
  ): Promise<HoldResult> {
    try {
      return await this.database.serializableTransaction(async (query) => {
        const result = await query<HoldPortRow>(
          `SELECT * FROM public.hxos_place_universal_v1_conditional_hold_v1(
             $1, $2, $3, $4, $5
           )`,
          [
            exactAssertionToken(actorAssertionToken),
            context.interest_application_id,
            context.eligibility_version,
            idempotencyKey,
            exactClientTimestamp(clientTimestamp),
          ]
        );
        const row = oneRow(result.rows, 'Conditional hold');
        portSafety(row);
        return {
          conditional_hold_id: row.conditional_hold_id,
          expires_at: iso(row.expires_at),
          replayed: row.replayed,
        };
      });
    } catch (error) {
      return translatePortFailure(error);
    }
  }

  async prepareMaterialization(
    context: Pick<WorkOrderContext, 'conditional_hold_id' | 'eligibility_version'>,
    idempotencyKey: string,
    actorAssertionToken: string,
    clientTimestamp: string
  ): Promise<WorkOrderMaterializationPhase> {
    try {
      return await this.database.serializableTransaction(async (query) => {
        const result = await query<PreparePortRow>(
          `SELECT * FROM public.hxos_prepare_universal_v1_fake_work_order_v1(
             $1, $2, $3, $4, $5
           )`,
          [
            exactAssertionToken(actorAssertionToken),
            context.conditional_hold_id,
            context.eligibility_version,
            idempotencyKey,
            exactClientTimestamp(clientTimestamp),
          ]
        );
        const row = oneRow(result.rows, 'Work Order preparation');
        portSafety(row);
        if (row.completed) {
          return {
            completed: true,
            result: {
              work_order_id: required(row.work_order_id, 'work_order_id'),
              financial_security_event_id: required(
                row.financial_security_event_id,
                'financial_security_event_id'
              ),
              replayed: row.replayed,
              hard_assignment_created: false,
              payment_creation_performed: false,
            },
          };
        }
        const live: WorkOrderContext = {
          task_id: required(row.task_id, 'task_id'),
          task_draft_id: required(row.task_draft_id, 'task_draft_id'),
          scope_version_id: required(row.scope_version_id, 'scope_version_id'),
          scope_version: Number(required(row.scope_version, 'scope_version')),
          routing_decision_id: required(row.routing_decision_id, 'routing_decision_id'),
          provider_user_id: required(row.provider_user_id, 'provider_user_id'),
          provider_organization_id: row.provider_organization_id,
          provider_class: required(row.provider_class, 'provider_class'),
          trade_credential_id: row.trade_credential_id,
          predecessor_eligibility_id: required(
            row.predecessor_eligibility_id,
            'predecessor_eligibility_id'
          ),
          predecessor_eligibility_version: Number(
            required(row.predecessor_eligibility_version, 'predecessor_eligibility_version')
          ),
          predecessor_valid_until: iso(
            required(row.predecessor_valid_until, 'predecessor_valid_until')
          ),
          poster_user_id: required(row.poster_user_id, 'poster_user_id'),
          interest_application_id: required(row.interest_application_id, 'interest_application_id'),
          eligibility_decision_id: required(row.eligibility_decision_id, 'eligibility_decision_id'),
          eligibility_version: Number(required(row.eligibility_version, 'eligibility_version')),
          eligibility_valid_until: iso(
            required(row.eligibility_valid_until, 'eligibility_valid_until')
          ),
          conditional_hold_id: required(row.conditional_hold_id, 'conditional_hold_id'),
          hold_reserved_at: iso(required(row.hold_reserved_at, 'hold_reserved_at')),
          hold_expires_at: iso(required(row.hold_expires_at, 'hold_expires_at')),
          provider_estimate_submission_id: required(
            row.provider_estimate_submission_id,
            'provider_estimate_submission_id'
          ),
          customer_total_cents: Number(required(row.customer_total_cents, 'customer_total_cents')),
          currency: required(row.currency, 'currency'),
        };
        return {
          completed: false,
          context: live,
          idempotencyKey: required(row.idempotency_key, 'idempotency_key'),
          requestSha256: required(row.request_sha256, 'request_sha256'),
          occurredAt: iso(required(row.occurred_at, 'occurred_at')),
        };
      });
    } catch (error) {
      return translatePortFailure(error);
    }
  }

  async finalizeMaterialization(
    phase: Extract<WorkOrderMaterializationPhase, { completed: false }>,
    securedEventId: string,
    actorAssertionToken: string
  ): Promise<WorkOrderResult> {
    try {
      return await this.database.serializableTransaction(async (query) => {
        const result = await query<MaterializePortRow>(
          `SELECT * FROM public.hxos_materialize_universal_v1_fake_work_order_v1(
             $1, $2, $3, $4
           )`,
          [
            exactAssertionToken(actorAssertionToken),
            phase.idempotencyKey,
            phase.requestSha256,
            securedEventId,
          ]
        );
        const row = oneRow(result.rows, 'Work Order materialization');
        portSafety(row);
        return {
          work_order_id: row.work_order_id,
          financial_security_event_id: row.financial_security_event_id,
          replayed: row.replayed,
          hard_assignment_created: false,
          payment_creation_performed: false,
        };
      });
    } catch (error) {
      return translatePortFailure(error);
    }
  }

  async claimMaterializationCompensation(
    phase: Extract<WorkOrderMaterializationPhase, { completed: false }>,
    securedEventId: string,
    actorAssertionToken: string
  ): Promise<WorkOrderCompensationResolution> {
    try {
      return await this.database.serializableTransaction(async (query) => {
        const result = await query<RecoveryPortRow>(
          `SELECT * FROM public.hxos_request_universal_v1_fake_work_order_recovery_v1(
             $1, $2, $3, $4
           )`,
          [
            exactAssertionToken(actorAssertionToken),
            phase.idempotencyKey,
            phase.requestSha256,
            securedEventId,
          ]
        );
        const row = oneRow(result.rows, 'Work Order recovery');
        portSafety(row);
        if (row.completed) {
          return {
            completed: true,
            result: {
              work_order_id: required(row.work_order_id, 'work_order_id'),
              financial_security_event_id: required(
                row.financial_security_event_id,
                'financial_security_event_id'
              ),
              replayed: row.replayed,
              hard_assignment_created: false,
              payment_creation_performed: false,
            },
          };
        }
        return {
          completed: false,
          command: {
            compensation_command_id: required(
              row.compensation_command_id,
              'compensation_command_id'
            ),
            work_order_idempotency_key: row.work_order_idempotency_key,
            task_draft_id: row.task_draft_id,
            task_id: row.task_id,
            scope_version_id: row.scope_version_id,
            eligibility_decision_id: row.eligibility_decision_id,
            secured_event_id: row.compensation_secured_event_id,
            secured_operation_id: required(row.secured_operation_id, 'secured_operation_id'),
            void_operation_id: required(row.void_operation_id, 'void_operation_id'),
            void_idempotency_key: required(row.void_idempotency_key, 'void_idempotency_key'),
            amount_cents: Number(row.amount_cents),
            currency: row.currency,
            requested_by: row.requested_by,
            created_at: iso(required(row.created_at, 'created_at')),
          },
        };
      });
    } catch (error) {
      return translatePortFailure(error);
    }
  }
}

export function deterministicUuid(key: string, label: string): string {
  const hexadecimal = createHash('sha256')
    .update(`${key}:${label}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hexadecimal[12] = '4';
  hexadecimal[16] = ((Number.parseInt(hexadecimal[16]!, 16) & 3) | 8).toString(16);
  const value = hexadecimal.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
