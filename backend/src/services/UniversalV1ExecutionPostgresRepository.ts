import { db, type Database, type QueryFn } from '../db.js';
import {
  type AdvanceUniversalV1WorkOrderExecutionPublic,
  type UniversalV1ExecutionAdvanceResult,
  UniversalV1ExecutionError,
  type UniversalV1ExecutionState,
  type UniversalV1ExecutionStateResult,
  type UniversalV1ExecutionTransitionKind,
  resolveUniversalV1ExecutionTransition,
} from './UniversalV1ExecutionContracts.js';

interface ExecutionContext {
  work_order_id: string;
  task_id: string;
  scope_version_id: string;
  scope_version: number;
  worker_id: string | null;
  provider_actor_authorized: boolean;
  provider_authority_current: boolean;
  incident_blocked: boolean;
  scope_change_pending: boolean;
}

interface ExecutionFactRow {
  execution_fact_id: string;
  work_order_id: string;
  task_id: string;
  scope_version_id: string;
  scope_version?: number;
  execution_version: number;
  state: UniversalV1ExecutionState;
  transition_kind: UniversalV1ExecutionTransitionKind;
  actor_user_id: string;
  idempotency_key: string;
  request_sha256: string;
  recorded_at: Date | string;
}

const EXECUTION_POLICY_VERSION = 'universal-v1-work-order-execution-1.0.0';

const CONTEXT_SQL = `
  SELECT work_order.id AS work_order_id,
         work_order.task_id,
         scope.id AS scope_version_id,
         scope.version AS scope_version,
         task.worker_id,
         (
           work_order.provider_user_id = actor.id
           OR EXISTS (
             SELECT 1
               FROM business_memberships membership
               JOIN business_organizations organization
                 ON organization.id = membership.organization_id
              WHERE membership.organization_id = work_order.provider_organization_id
                AND membership.user_id = actor.id
                AND membership.status = 'ACTIVE'
                AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
                AND organization.status = 'ACTIVE'
                AND organization.provider_enabled IS TRUE
           )
         ) AS provider_actor_authorized,
         public.universal_v1_invited_provider_authority_is_current(
           eligibility.provider_user_id,
           eligibility.provider_organization_id,
           eligibility.provider_class,
           eligibility.trade_credential_id,
           task.category,
           task.region_code
         ) AS provider_authority_current,
         EXISTS (
           SELECT 1
             FROM task_safety_incidents incident
            WHERE incident.task_id = task.id
              AND incident.status NOT IN ('resolved','closed')
         ) AS incident_blocked,
         EXISTS (
           SELECT 1
             FROM task_scope_change_proposals proposal
            WHERE proposal.task_id = task.id
              AND proposal.status = 'PENDING'
         ) AS scope_change_pending
    FROM task_work_orders work_order
    JOIN tasks task ON task.id = work_order.task_id
    JOIN task_drafts draft ON draft.id = work_order.task_draft_id
    JOIN task_provider_eligibility_decisions eligibility
      ON eligibility.id = work_order.eligibility_decision_id
     AND eligibility.task_id = task.id
     AND eligibility.provider_user_id IS NOT DISTINCT FROM work_order.provider_user_id
     AND eligibility.provider_organization_id IS NOT DISTINCT FROM work_order.provider_organization_id
    JOIN users actor ON actor.id = $2
    JOIN users provider ON provider.id = eligibility.provider_user_id
    JOIN LATERAL (
      SELECT COALESCE(
        (
          SELECT amendment.scope_version_id
            FROM task_work_order_amendments amendment
           WHERE amendment.work_order_id = work_order.id
           ORDER BY amendment.amendment_version DESC
           LIMIT 1
        ),
        work_order.scope_version_id
      ) AS id
    ) effective_scope ON TRUE
    JOIN task_scope_versions scope
      ON scope.id = effective_scope.id
     AND scope.task_id = task.id
     AND scope.universal_contract_version = 1
   WHERE work_order.id = $1
     AND work_order.execution_contract_version = 1
     AND task.work_order_id = work_order.id
     AND task.active_scope_version_id = scope.id
     AND task.universal_contract_version = 1
     AND draft.universal_contract_version = 1
     AND task.automation_classification = 'CONTROLLED_TEST'
     AND eligibility.task_eligible IS TRUE
     AND actor.account_status = 'ACTIVE'
     AND actor.is_minor IS FALSE
     AND COALESCE(actor.is_banned, FALSE) IS FALSE
     AND provider.account_status = 'ACTIVE'
     AND provider.is_minor IS FALSE
     AND COALESCE(provider.is_banned, FALSE) IS FALSE
     AND (
       task.poster_id = actor.id
       OR work_order.provider_user_id = actor.id
       OR EXISTS (
         SELECT 1
           FROM business_memberships membership
          WHERE membership.organization_id = work_order.provider_organization_id
            AND membership.user_id = actor.id
            AND membership.status = 'ACTIVE'
       )
     )`;

function contextSql(lock: boolean): string {
  return lock
    ? `${CONTEXT_SQL}\n   FOR UPDATE OF work_order, task, draft, eligibility, actor, provider, scope`
    : CONTEXT_SQL;
}

function requireContext(row: ExecutionContext | undefined): ExecutionContext {
  if (!row) {
    throw new UniversalV1ExecutionError(
      'EXECUTION_CONTEXT_UNAVAILABLE',
      'The exact controlled-test Work Order execution context is unavailable.'
    );
  }
  return row;
}

async function loadContext(
  query: QueryFn,
  workOrderId: string,
  actorUserId: string,
  lock: boolean
): Promise<ExecutionContext> {
  const result = await query<ExecutionContext>(contextSql(lock), [workOrderId, actorUserId]);
  return requireContext(result.rows[0]);
}

async function loadCurrentFact(
  query: QueryFn,
  workOrderId: string,
  lock: boolean
): Promise<ExecutionFactRow> {
  const result = await query<ExecutionFactRow>(
    `SELECT fact.id AS execution_fact_id,
            fact.work_order_id,
            fact.task_id,
            fact.scope_version_id,
            fact_scope.version AS scope_version,
            fact.execution_version,
            fact.state,
            fact.transition_kind,
            fact.actor_user_id,
            fact.idempotency_key,
            fact.request_sha256,
            fact.recorded_at
       FROM task_work_order_execution_facts fact
       JOIN task_scope_versions fact_scope ON fact_scope.id = fact.scope_version_id
      WHERE fact.work_order_id = $1
      ORDER BY fact.execution_version DESC
      LIMIT 1${lock ? '\n      FOR UPDATE' : ''}`,
    [workOrderId]
  );
  const fact = result.rows[0];
  if (!fact) {
    throw new UniversalV1ExecutionError(
      'EXECUTION_CONTEXT_UNAVAILABLE',
      'The Work Order has no canonical execution-state fact.'
    );
  }
  return fact;
}

async function loadReplay(
  query: QueryFn,
  workOrderId: string,
  actorUserId: string,
  idempotencyKey: string
): Promise<ExecutionFactRow | null> {
  const result = await query<ExecutionFactRow>(
    `SELECT fact.id AS execution_fact_id,
            fact.work_order_id,
            fact.task_id,
            fact.scope_version_id,
            fact_scope.version AS scope_version,
            fact.execution_version,
            fact.state,
            fact.transition_kind,
            fact.actor_user_id,
            fact.idempotency_key,
            fact.request_sha256,
            fact.recorded_at
       FROM task_work_order_execution_facts fact
       JOIN task_scope_versions fact_scope ON fact_scope.id = fact.scope_version_id
      WHERE fact.work_order_id = $1
        AND fact.actor_user_id = $2
        AND fact.idempotency_key = $3
      FOR UPDATE`,
    [workOrderId, actorUserId, idempotencyKey]
  );
  return result.rows[0] ?? null;
}

function assertFactMatchesContext(fact: ExecutionFactRow, context: ExecutionContext): void {
  if (
    fact.work_order_id !== context.work_order_id ||
    fact.task_id !== context.task_id ||
    fact.scope_version_id !== context.scope_version_id
  ) {
    throw new UniversalV1ExecutionError(
      'EXECUTION_VERSION_CONFLICT',
      'The execution fact is not bound to the effective Work Order scope.'
    );
  }
}

function asIsoString(value: Date | string): string {
  return new Date(value).toISOString();
}

function stateResult(
  fact: ExecutionFactRow,
  context: ExecutionContext
): UniversalV1ExecutionStateResult {
  return {
    execution_fact_id: fact.execution_fact_id,
    work_order_id: fact.work_order_id,
    task_id: fact.task_id,
    scope_version_id: fact.scope_version_id,
    scope_version: Number(fact.scope_version ?? context.scope_version),
    execution_version: Number(fact.execution_version),
    state: fact.state,
    transition_kind: fact.transition_kind,
    recorded_at: asIsoString(fact.recorded_at),
    hard_assignment_created: false,
    payment_creation_performed: false,
  };
}

function replayResult(
  replay: ExecutionFactRow,
  context: ExecutionContext,
  requestSha256: string
): UniversalV1ExecutionAdvanceResult {
  if (replay.request_sha256 !== requestSha256) {
    throw new UniversalV1ExecutionError(
      'EXECUTION_IDEMPOTENCY_CONFLICT',
      'The execution idempotency key was already used for a different command.'
    );
  }
  return { ...stateResult(replay, context), replayed: true };
}

function assertNewCommandAuthority(
  context: ExecutionContext,
  input: AdvanceUniversalV1WorkOrderExecutionPublic
): void {
  if (context.worker_id) {
    throw new UniversalV1ExecutionError(
      'EXECUTION_HARD_ASSIGNMENT_FORBIDDEN',
      'Universal V1 execution cannot proceed from a hard-assigned task.'
    );
  }
  if (!context.provider_actor_authorized || !context.provider_authority_current) {
    throw new UniversalV1ExecutionError(
      'EXECUTION_PROVIDER_AUTHORITY_REVOKED',
      'The actor no longer has current provider authority for this Work Order.'
    );
  }
  if (context.incident_blocked && input.action !== 'PAUSE_WORK') {
    throw new UniversalV1ExecutionError(
      'EXECUTION_INCIDENT_BLOCKED',
      'An open safety incident blocks forward execution transitions.'
    );
  }
  if (context.scope_change_pending && input.action !== 'PAUSE_WORK') {
    throw new UniversalV1ExecutionError(
      'EXECUTION_SCOPE_CHANGE_PENDING',
      'A pending scope change blocks forward execution transitions.'
    );
  }
}

function translateDatabaseConflict(error: unknown): never {
  if (error instanceof UniversalV1ExecutionError) throw error;
  const candidate = error as { code?: string; constraint?: string; message?: string };
  if (candidate.code === 'P0001' && /^HXUV1-EXEC-/u.test(candidate.message ?? '')) {
    const databaseCode = /^HXUV1-EXEC-(\d+):/u.exec(candidate.message ?? '')?.[1];
    if (databaseCode === '2') {
      throw new UniversalV1ExecutionError(
        'EXECUTION_REQUEST_STALE',
        'The execution command timestamp is outside the accepted window.'
      );
    }
    if (databaseCode === '5' || databaseCode === '6') {
      throw new UniversalV1ExecutionError(
        'EXECUTION_VERSION_CONFLICT',
        'The execution state changed concurrently.'
      );
    }
    if (databaseCode === '7') {
      throw new UniversalV1ExecutionError(
        'EXECUTION_INVALID_TRANSITION',
        'The requested execution transition is no longer valid.'
      );
    }
    if (databaseCode === '8') {
      throw new UniversalV1ExecutionError(
        'EXECUTION_PROVIDER_AUTHORITY_REVOKED',
        'Current provider execution authority is absent.'
      );
    }
    if (databaseCode === '10') {
      throw new UniversalV1ExecutionError(
        'EXECUTION_IDEMPOTENCY_CONFLICT',
        'The execution request digest was rejected.'
      );
    }
    throw new UniversalV1ExecutionError(
      'EXECUTION_CONTEXT_UNAVAILABLE',
      'The database rejected the execution command authority context.'
    );
  }
  if (candidate.code === '40001' || candidate.code === '40P01') {
    throw new UniversalV1ExecutionError(
      'EXECUTION_VERSION_CONFLICT',
      'The execution state changed concurrently.'
    );
  }
  if (candidate.code === '23505') {
    if (candidate.constraint?.includes('idempotency')) {
      throw new UniversalV1ExecutionError(
        'EXECUTION_IDEMPOTENCY_CONFLICT',
        'The execution idempotency key was committed concurrently.'
      );
    }
    throw new UniversalV1ExecutionError(
      'EXECUTION_VERSION_CONFLICT',
      'The execution version was committed concurrently.'
    );
  }
  throw error;
}

export class PostgresUniversalV1ExecutionRepository {
  constructor(private readonly database: Database = db) {}

  async getWorkOrderExecutionState(
    actorUserId: string,
    workOrderId: string
  ): Promise<UniversalV1ExecutionStateResult> {
    return this.database.serializableTransaction(async (query) => {
      const context = await loadContext(query, workOrderId, actorUserId, false);
      const current = await loadCurrentFact(query, workOrderId, false);
      assertFactMatchesContext(current, context);
      return stateResult(current, context);
    });
  }

  async advanceWorkOrderExecution(
    actorUserId: string,
    input: AdvanceUniversalV1WorkOrderExecutionPublic,
    requestSha256: string
  ): Promise<UniversalV1ExecutionAdvanceResult> {
    try {
      return await this.database.serializableTransaction(async (query) => {
        await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `fulfillment:${input.work_order_id}`,
        ]);
        const context = await loadContext(query, input.work_order_id, actorUserId, true);

        // Replays deliberately precede current-state and authority validation. A
        // committed response remains repeatable after the state or scope advances.
        const replay = await loadReplay(
          query,
          input.work_order_id,
          actorUserId,
          input.idempotency_key
        );
        if (replay) return replayResult(replay, context, requestSha256);

        assertNewCommandAuthority(context, input);
        const current = await loadCurrentFact(query, input.work_order_id, true);
        assertFactMatchesContext(current, context);

        if (
          Number(current.execution_version) !== input.expected_execution_version ||
          Number(context.scope_version) !== input.expected_scope_version
        ) {
          throw new UniversalV1ExecutionError(
            'EXECUTION_VERSION_CONFLICT',
            'The execution or effective scope version changed.'
          );
        }

        const nextState = resolveUniversalV1ExecutionTransition(current.state, input.action);
        if (!nextState) {
          throw new UniversalV1ExecutionError(
            'EXECUTION_INVALID_TRANSITION',
            `Action ${input.action} cannot follow execution state ${current.state}.`
          );
        }

        const inserted = await query<ExecutionFactRow>(
          `INSERT INTO task_work_order_execution_facts (
             work_order_id,
             task_id,
             scope_version_id,
             execution_version,
             supersedes_fact_id,
             state,
             transition_kind,
             completion_fact_id,
             work_order_amendment_id,
             actor_role,
             actor_user_id,
             reason,
             idempotency_key,
             request_sha256,
             client_occurred_at,
             policy_version,
             recorded_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,NULL,NULL,'PROVIDER',$8,$9,$10,$11,$12,$13,clock_timestamp()
           )
           RETURNING id AS execution_fact_id,
                     work_order_id,
                     task_id,
                     scope_version_id,
                     execution_version,
                     state,
                     transition_kind,
                     actor_user_id,
                     idempotency_key,
                     request_sha256,
                     recorded_at`,
          [
            context.work_order_id,
            context.task_id,
            context.scope_version_id,
            Number(current.execution_version) + 1,
            current.execution_fact_id,
            nextState,
            input.action,
            actorUserId,
            input.reason ?? null,
            input.idempotency_key,
            requestSha256,
            input.client_ts,
            EXECUTION_POLICY_VERSION,
          ]
        );
        const fact = inserted.rows[0];
        if (!fact) {
          throw new UniversalV1ExecutionError(
            'EXECUTION_VERSION_CONFLICT',
            'The execution fact was not created.'
          );
        }
        return { ...stateResult(fact, context), replayed: false };
      });
    } catch (error) {
      return translateDatabaseConflict(error);
    }
  }
}
