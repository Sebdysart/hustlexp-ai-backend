import { db, type Database, type QueryFn } from '../db.js';
import {
  type AuthenticatedCompletionDeliverySink,
  type UniversalV1CompletionDeliveryReceiptResult,
  type UniversalV1CompletionDeliveryReceiptWebhook,
  UniversalV1CompletionDeliveryError,
  universalV1CompletionDeliveryReceiptHash,
} from './UniversalV1CompletionDeliveryContracts.js';

interface ExistingReceiptRow {
  id: string;
  task_id: string;
  work_order_id: string | null;
  expected_completion_fact_id: string | null;
  provider_delivery_id: string;
  channel: 'SMS' | 'EMAIL' | 'PUSH';
  delivered_at: Date | string;
  provider_kind: 'SYNTHETIC_SINK' | null;
  provider_service_identity: string | null;
  request_sha256: string | null;
}

interface DeliveryContextRow {
  work_order_id: string;
  task_id: string;
  completion_fact_id: string;
  completion_version: number;
  completion_kind: string;
  completion_scope_version_id: string;
  execution_version: number;
  execution_state: string;
  execution_completion_fact_id: string | null;
  execution_scope_version_id: string;
  execution_contract_version: number;
  task_work_order_id: string | null;
  universal_contract_version: number;
  automation_classification: string | null;
  universal_payment_posture: string | null;
  worker_id: string | null;
  service_actor_valid: boolean;
}

function resultFromRow(
  row: ExistingReceiptRow,
  replayed: boolean
): UniversalV1CompletionDeliveryReceiptResult {
  return {
    delivery_event_id: row.id,
    task_id: row.task_id,
    work_order_id: row.work_order_id!,
    submitted_completion_fact_id: row.expected_completion_fact_id!,
    provider_delivery_id: row.provider_delivery_id,
    channel: row.channel,
    delivered_at: new Date(row.delivered_at).toISOString(),
    provider_kind: row.provider_kind!,
    provider_service_identity: row.provider_service_identity!,
    idempotency_replayed: replayed,
    payment_creation_performed: false,
    hard_assignment_created: false,
  };
}

function assertNewReceiptTimestamps(
  input: UniversalV1CompletionDeliveryReceiptWebhook,
  currentTime: number
): void {
  const clientTime = Date.parse(input.client_ts);
  if (!Number.isFinite(clientTime) || Math.abs(currentTime - clientTime) > 5 * 60_000) {
    throw new UniversalV1CompletionDeliveryError(
      'COMPLETION_DELIVERY_REQUEST_STALE',
      'The delivery callback timestamp is outside the accepted window.'
    );
  }
  const deliveredAt = Date.parse(input.delivered_at);
  if (!Number.isFinite(deliveredAt) || deliveredAt > currentTime + 5 * 60_000) {
    throw new UniversalV1CompletionDeliveryError(
      'COMPLETION_DELIVERY_TIMESTAMP_INVALID',
      'The provider delivery timestamp cannot be in the future.'
    );
  }
}

async function lockReceiptKeys(
  query: QueryFn,
  input: UniversalV1CompletionDeliveryReceiptWebhook
): Promise<void> {
  await query(
    `SELECT pg_advisory_xact_lock(
       hashtext('universal-v1-completion-delivery-idempotency'), hashtext($1)
     )`,
    [input.idempotency_key]
  );
  await query(
    `SELECT pg_advisory_xact_lock(
       hashtext('universal-v1-completion-delivery-provider-id'), hashtext($1)
     )`,
    [input.provider_delivery_id]
  );
}

async function existingReceipt(
  query: QueryFn,
  input: UniversalV1CompletionDeliveryReceiptWebhook,
  requestHash: string
): Promise<UniversalV1CompletionDeliveryReceiptResult | null> {
  const existing = await query<ExistingReceiptRow>(
    `SELECT id, task_id, work_order_id, expected_completion_fact_id,
            provider_delivery_id, channel, delivered_at, provider_kind,
            provider_service_identity, request_sha256
       FROM task_completion_delivery_events
      WHERE idempotency_key = $1 OR provider_delivery_id = $2
      ORDER BY id`,
    [input.idempotency_key, input.provider_delivery_id]
  );
  if (existing.rows.length === 0) return null;
  if (existing.rows.length === 1 && existing.rows[0]!.request_sha256 === requestHash) {
    return resultFromRow(existing.rows[0]!, true);
  }
  throw new UniversalV1CompletionDeliveryError(
    'COMPLETION_DELIVERY_IDEMPOTENCY_CONFLICT',
    'The idempotency key or provider delivery ID is already bound to a different receipt.'
  );
}

async function lockDeliveryContext(
  query: QueryFn,
  sink: AuthenticatedCompletionDeliverySink,
  input: UniversalV1CompletionDeliveryReceiptWebhook
): Promise<DeliveryContextRow | undefined> {
  const context = await query<DeliveryContextRow>(
    `SELECT work_order.id AS work_order_id,
            task.id AS task_id,
            completion.id AS completion_fact_id,
            completion.completion_version,
            completion.fact_kind AS completion_kind,
            completion.scope_version_id AS completion_scope_version_id,
            execution.execution_version,
            execution.state AS execution_state,
            execution.completion_fact_id AS execution_completion_fact_id,
            execution.scope_version_id AS execution_scope_version_id,
            work_order.execution_contract_version,
            task.work_order_id AS task_work_order_id,
            task.universal_contract_version,
            task.automation_classification,
            task.universal_payment_posture,
            task.worker_id,
            EXISTS (
              SELECT 1
                FROM users service_actor
               WHERE service_actor.id = $4
                 AND service_actor.account_status = 'ACTIVE'
                 AND service_actor.is_minor IS FALSE
                 AND COALESCE(service_actor.is_banned, FALSE) IS FALSE
            ) AS service_actor_valid
       FROM task_work_orders work_order
       JOIN tasks task ON task.id = work_order.task_id
       JOIN task_completion_facts completion
         ON completion.id = $3
        AND completion.work_order_id = work_order.id
        AND completion.task_id = task.id
       JOIN LATERAL (
         SELECT fact.execution_version, fact.state, fact.completion_fact_id,
                fact.scope_version_id
           FROM task_work_order_execution_facts fact
          WHERE fact.work_order_id = work_order.id
          ORDER BY fact.execution_version DESC
          LIMIT 1
       ) execution ON TRUE
      WHERE work_order.id = $1
        AND task.id = $2
      FOR UPDATE OF work_order, task`,
    [input.work_order_id, input.task_id, input.submitted_completion_fact_id, sink.actorUserId]
  );
  return context.rows[0];
}

function assertDeliveryContext(
  context: DeliveryContextRow | undefined,
  input: UniversalV1CompletionDeliveryReceiptWebhook
): asserts context is DeliveryContextRow {
  if (!context) {
    throw new UniversalV1CompletionDeliveryError(
      'COMPLETION_DELIVERY_CONTEXT_UNAVAILABLE',
      'The completion receipt does not bind an existing task, Work Order, and completion fact.'
    );
  }
  if (!context.service_actor_valid) {
    throw new UniversalV1CompletionDeliveryError(
      'COMPLETION_DELIVERY_SERVICE_IDENTITY_INVALID',
      'The authenticated delivery sink actor is not an active service identity.'
    );
  }
  if (
    context.work_order_id !== input.work_order_id ||
    context.task_id !== input.task_id ||
    context.task_work_order_id !== input.work_order_id ||
    context.execution_contract_version !== 1 ||
    context.universal_contract_version !== 1 ||
    context.automation_classification !== 'CONTROLLED_TEST' ||
    context.universal_payment_posture !== 'PAYMENT_CREATION_FROZEN' ||
    context.worker_id !== null
  ) {
    throw new UniversalV1CompletionDeliveryError(
      'COMPLETION_DELIVERY_CONTEXT_UNAVAILABLE',
      'The receipt is outside the unassigned, payment-frozen Universal V1 boundary.'
    );
  }
  if (
    Number(context.completion_version) !== input.expected_completion_version ||
    Number(context.execution_version) !== input.expected_execution_version
  ) {
    throw new UniversalV1CompletionDeliveryError(
      'COMPLETION_DELIVERY_VERSION_CONFLICT',
      'The completion or execution version changed before delivery receipt recording.'
    );
  }
  if (
    context.completion_fact_id !== input.submitted_completion_fact_id ||
    context.completion_kind !== 'SUBMITTED' ||
    context.execution_state !== 'COMPLETION_SUBMITTED' ||
    context.execution_completion_fact_id !== input.submitted_completion_fact_id ||
    context.execution_scope_version_id !== context.completion_scope_version_id
  ) {
    throw new UniversalV1CompletionDeliveryError(
      'COMPLETION_DELIVERY_STATE_CONFLICT',
      'Delivery can be recorded only for the exact current submitted completion.'
    );
  }
}

async function insertReceipt(
  query: QueryFn,
  sink: AuthenticatedCompletionDeliverySink,
  input: UniversalV1CompletionDeliveryReceiptWebhook,
  requestHash: string
): Promise<UniversalV1CompletionDeliveryReceiptResult> {
  const inserted = await query<ExistingReceiptRow>(
    `INSERT INTO task_completion_delivery_events (
       task_id, work_order_id, expected_completion_fact_id,
       expected_completion_version, expected_execution_version,
       provider_delivery_id, channel, delivered_at, recorded_by,
       provider_kind, provider_service_identity, idempotency_key,
       request_sha256, provider_callback_at, policy_version
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, $11, $12, $13, $14,
       'universal-v1-completion-delivery-receipt-1.0.0'
     )
     RETURNING id, task_id, work_order_id, expected_completion_fact_id,
               provider_delivery_id, channel, delivered_at, provider_kind,
               provider_service_identity, request_sha256`,
    [
      input.task_id,
      input.work_order_id,
      input.submitted_completion_fact_id,
      input.expected_completion_version,
      input.expected_execution_version,
      input.provider_delivery_id,
      input.channel,
      new Date(input.delivered_at),
      sink.actorUserId,
      sink.providerKind,
      sink.serviceIdentity,
      input.idempotency_key,
      requestHash,
      new Date(input.client_ts),
    ]
  );
  return resultFromRow(inserted.rows[0]!, false);
}

/**
 * Append-only provider delivery receipt repository.
 *
 * Its only write is one immutable receipt fact. It never updates tasks,
 * creates an assignment, or touches any financial operation/event table.
 */
export class PostgresUniversalV1CompletionDeliveryRepository {
  constructor(
    private readonly database: Database = db,
    private readonly now: () => number = Date.now
  ) {}

  record(
    sink: AuthenticatedCompletionDeliverySink,
    input: UniversalV1CompletionDeliveryReceiptWebhook
  ): Promise<UniversalV1CompletionDeliveryReceiptResult> {
    const requestHash = universalV1CompletionDeliveryReceiptHash(sink, input);
    // READ COMMITTED is intentional here. The transaction-scoped advisory
    // locks serialize both receipt identities, and the SELECT that follows a
    // wait must take a fresh snapshot so an exact concurrent replay can see
    // the receipt committed by the first request. A SERIALIZABLE snapshot is
    // fixed before the advisory-lock wait and can turn that harmless replay
    // into a serialization or unique-constraint failure. The locked Work
    // Order/task context and the database trigger still fail closed if the
    // submitted completion changes before this append-only insert.
    return this.database.transaction(async (query) => {
      await query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await lockReceiptKeys(query, input);
      const replay = await existingReceipt(query, input, requestHash);
      if (replay) return replay;
      assertNewReceiptTimestamps(input, this.now());
      const context = await lockDeliveryContext(query, sink, input);
      assertDeliveryContext(context, input);
      return insertReceipt(query, sink, input, requestHash);
    });
  }
}
