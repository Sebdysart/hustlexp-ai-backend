import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../db.js';

export const operationsPriorityClasses = [
  'SAFETY', 'MONEY', 'ACTIVE_TASK', 'SLA', 'TRUST', 'COMMUNICATION', 'DATA',
] as const;
export type OperationsPriorityClass = typeof operationsPriorityClasses[number];

export type OperationsExceptionListInput = {
  priorityClass?: OperationsPriorityClass;
  ownership: 'ALL' | 'MINE' | 'UNASSIGNED';
  search?: string;
  sort: 'PRIORITY' | 'OLDEST' | 'NEWEST' | 'SIGNAL_COUNT';
  limit: number;
  offset: number;
};

export type OperationsOwnershipInput = {
  clusterKey: string;
  idempotencyKey: string;
};

export type NotificationRecoveryInput = OperationsOwnershipInput & {
  deliveryId: string;
};

export type NotificationRecoveryCancellationInput = OperationsOwnershipInput & {
  actionEventId: string;
};

function requestHash(value: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function requireMatchingReplay(
  prior: { request_hash: string } | undefined,
  hash: string,
  mismatchMessage: string,
): boolean {
  if (!prior) return false;
  if (prior.request_hash !== hash) {
    throw new TRPCError({ code: 'CONFLICT', message: mismatchMessage });
  }
  return true;
}

async function requireCurrentCluster(query: QueryFn, clusterKey: string) {
  const current = await query<{ signal_count: string }>(
    `SELECT COUNT(*)::TEXT AS signal_count
       FROM operations_exception_signals
      WHERE cluster_key = $1
     HAVING COUNT(*) > 0`,
    [clusterKey],
  );
  if (!current.rows[0]) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Operations exception is no longer active.' });
  }
  return numberValue(current.rows[0].signal_count);
}

function missingWorkPredicate(alias: string, notificationAlias: string): string {
  return `(
    (${alias}.channel = 'email' AND NOT EXISTS (
      SELECT 1 FROM email_outbox item WHERE item.notification_id = ${alias}.notification_id
    ))
    OR (${alias}.channel = 'sms' AND NOT EXISTS (
      SELECT 1 FROM sms_outbox item WHERE item.notification_id = ${alias}.notification_id
    ))
    OR (${alias}.channel = 'push' AND NOT EXISTS (
      SELECT 1 FROM outbox_events item
       WHERE item.event_type = 'push.send_requested'
         AND item.aggregate_id = ${alias}.notification_id
    ))
  )
  AND ${notificationAlias}.superseded_at IS NULL
  AND (${notificationAlias}.expires_at IS NULL OR ${notificationAlias}.expires_at > NOW())`;
}

export async function listOperationsExceptions(
  input: OperationsExceptionListInput,
  adminUserId: string,
) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.priorityClass) {
    params.push(input.priorityClass);
    conditions.push(`signal.priority_class = $${params.length}`);
  }
  if (input.ownership === 'MINE') {
    params.push(adminUserId);
    conditions.push(`owner.assigned_admin_id = $${params.length}`);
  } else if (input.ownership === 'UNASSIGNED') {
    conditions.push('owner.assigned_admin_id IS NULL');
  }
  if (input.search) {
    params.push(`%${input.search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
    conditions.push(`(
      signal.cluster_key ILIKE $${params.length} ESCAPE '\\'
      OR signal.root_cause_code ILIKE $${params.length} ESCAPE '\\'
      OR signal.root_cause_label ILIKE $${params.length} ESCAPE '\\'
    )`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = {
    PRIORITY: 'MIN(signal.priority_rank), MIN(signal.detected_at), signal.cluster_key',
    OLDEST: 'MIN(signal.detected_at), MIN(signal.priority_rank), signal.cluster_key',
    NEWEST: 'MAX(signal.detected_at) DESC, MIN(signal.priority_rank), signal.cluster_key',
    SIGNAL_COUNT: 'COUNT(*) DESC, MIN(signal.priority_rank), MIN(signal.detected_at)',
  }[input.sort];
  params.push(input.limit, input.offset);
  const result = await db.query<{
    cluster_key: string;
    priority_rank: string | number;
    priority_class: OperationsPriorityClass;
    root_cause_code: string;
    root_cause_label: string;
    severity: string;
    lifecycle_state: string;
    signal_count: string;
    oldest_detected_at: Date | string;
    newest_detected_at: Date | string;
    amount_cents: string | null;
    currency: string | null;
    policy_version: string;
    model_version: string;
    model_applicability: string;
    automation_class: string;
    recovery_eligible: boolean;
    recovery_kind: string | null;
    provider_name: string | null;
    assigned_admin_id: string | null;
    assigned_at: Date | string | null;
    owned_by_current_operator: boolean;
  }>(
    `SELECT signal.cluster_key,
            MIN(signal.priority_rank) AS priority_rank,
            MIN(signal.priority_class) AS priority_class,
            MIN(signal.root_cause_code) AS root_cause_code,
            MIN(signal.root_cause_label) AS root_cause_label,
            MAX(signal.severity) AS severity,
            MIN(signal.lifecycle_state) AS lifecycle_state,
            COUNT(*)::TEXT AS signal_count,
            MIN(signal.detected_at) AS oldest_detected_at,
            MAX(signal.detected_at) AS newest_detected_at,
            SUM(signal.amount_cents)::TEXT AS amount_cents,
            MIN(signal.currency) AS currency,
            MIN(signal.policy_version) AS policy_version,
            MIN(signal.model_version) AS model_version,
            MIN(signal.model_applicability) AS model_applicability,
            MIN(signal.automation_class) AS automation_class,
            BOOL_OR(signal.recovery_eligible) AS recovery_eligible,
            MIN(signal.recovery_kind) AS recovery_kind,
            MIN(signal.provider_name) AS provider_name,
            owner.assigned_admin_id,
            owner.assigned_at,
            owner.assigned_admin_id = $${params.length + 1}::UUID AS owned_by_current_operator
       FROM operations_exception_signals signal
       LEFT JOIN operations_exception_ownership owner ON owner.cluster_key = signal.cluster_key
       ${where}
      GROUP BY signal.cluster_key, owner.assigned_admin_id, owner.assigned_at
      ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    [...params, adminUserId],
  );
  return result.rows.map((row) => ({
    ...row,
    priority_rank: numberValue(row.priority_rank),
    signal_count: numberValue(row.signal_count),
    amount_cents: row.amount_cents === null ? null : numberValue(row.amount_cents),
  }));
}

export function getOperationsExceptionDetail(
  clusterKey: string,
  purpose: string,
  adminUserId: string,
) {
  return db.transaction(async (query) => {
    const signals = await query(
      `SELECT signal_id, cluster_key, priority_rank, priority_class,
              root_cause_code, root_cause_label, source_type, source_id, task_id,
              severity, lifecycle_state, detected_at, amount_cents, currency,
              policy_version, model_version, model_applicability, automation_class,
              attempt_count, max_attempts, recovery_eligible, recovery_kind,
              evidence_summary, provider_name
         FROM operations_exception_signals
        WHERE cluster_key = $1
        ORDER BY priority_rank, detected_at, signal_id`,
      [clusterKey],
    );
    if (signals.rows.length === 0) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Operations exception is no longer active.' });
    }

    const sourceIds = signals.rows.map((row) => String(row.source_id));
    const taskIds = [...new Set(signals.rows
      .map((row) => row.task_id)
      .filter((value): value is string => typeof value === 'string'))];

    const [ownership, ownershipEvents, actionEvents, majorActions, recommendations] = await Promise.all([
      query(
        `SELECT assigned_admin_id, assigned_at, updated_at, version,
                assigned_admin_id = $2 AS owned_by_current_operator
           FROM operations_exception_ownership WHERE cluster_key = $1`,
        [clusterKey, adminUserId],
      ),
      query(
        `SELECT event_type, previous_assignee_id IS NOT NULL AS previously_assigned,
                new_assignee_id IS NOT NULL AS newly_assigned, reason_code, created_at,
                actor_admin_id = $2 AS acted_by_current_operator
           FROM operations_exception_ownership_events
          WHERE cluster_key = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
        [clusterKey, adminUserId],
      ),
      query(
        `SELECT id, action_type, notification_delivery_id, reason_code,
                previous_state, new_state, previous_attempt_count, new_attempt_count,
                previous_max_attempts, new_max_attempts, new_next_retry_at,
                reversal_of_action_id, created_at,
                actor_admin_id = $2 AS acted_by_current_operator
           FROM operations_exception_action_events
          WHERE cluster_key = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
        [clusterKey, adminUserId],
      ),
      query(
        `SELECT id, event_name, action_class, automation_class, actor_role,
                aggregate_type, aggregate_id, previous_lifecycle_state, lifecycle_state,
                sync_state, policy_version, policy_applicability, recommendation_id,
                model_version, model_applicability, risk_class, result,
                failure_reason_code, recovery_action_code, reversible,
                source_table, source_event_id, occurred_at, recorded_at
           FROM major_action_events
          WHERE source_event_id = ANY($1::TEXT[])
             OR aggregate_id = ANY($1::TEXT[])
             OR (aggregate_type = 'task' AND aggregate_id = ANY($2::TEXT[]))
          ORDER BY occurred_at DESC, id DESC LIMIT 100`,
        [sourceIds, taskIds],
      ),
      query(
        `SELECT recommendation.id, recommendation.subject_type, recommendation.subject_id,
                recommendation.recommendation_class, recommendation.source_type,
                recommendation.recommendation_text, recommendation.reason,
                recommendation.evidence_classes, recommendation.expected_benefit,
                recommendation.downside, recommendation.confidence_band,
                recommendation.model_version, recommendation.policy_version,
                recommendation.scope_affected, recommendation.user_controls,
                recommendation.autonomy_level, recommendation.displayed_at,
                COALESCE(events.events, '[]'::JSONB) AS events,
                COALESCE(outcomes.outcomes, '[]'::JSONB) AS outcomes
           FROM recommendations recommendation
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object(
               'eventType', event.event_type, 'createdAt', event.created_at
             ) ORDER BY event.created_at, event.id) AS events
               FROM recommendation_events event
              WHERE event.recommendation_id = recommendation.id
           ) events ON TRUE
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object(
               'outcomeType', outcome.outcome_type,
               'realizedValue', outcome.realized_value,
               'measuredAt', outcome.measured_at
             ) ORDER BY outcome.measured_at, outcome.id) AS outcomes
               FROM recommendation_outcomes outcome
              WHERE outcome.recommendation_id = recommendation.id
           ) outcomes ON TRUE
          WHERE recommendation.subject_id::TEXT = ANY($1::TEXT[])
             OR recommendation.id IN (
               SELECT action.recommendation_id FROM major_action_events action
                WHERE action.recommendation_id IS NOT NULL
                  AND (action.source_event_id = ANY($2::TEXT[])
                    OR action.aggregate_id = ANY($2::TEXT[]))
             )
          ORDER BY recommendation.displayed_at DESC LIMIT 50`,
        [taskIds, sourceIds],
      ),
    ]);

    await query(
      `INSERT INTO operations_exception_access_log (
         cluster_key, admin_user_id, purpose, signal_count
       ) VALUES ($1, $2, $3, $4)`,
      [clusterKey, adminUserId, purpose, signals.rows.length],
    );

    return {
      clusterKey,
      signals: signals.rows,
      ownership: ownership.rows[0] ?? null,
      ownershipHistory: ownershipEvents.rows,
      actionHistory: actionEvents.rows,
      automationTimeline: majorActions.rows,
      recommendations: recommendations.rows,
      operatorAccessRecorded: true as const,
    };
  });
}

export function claimOperationsException(input: OperationsOwnershipInput, adminUserId: string) {
  const hash = requestHash({
    action: 'CLAIMED', clusterKey: input.clusterKey, idempotencyKey: input.idempotencyKey,
  });
  return db.transaction(async (query) => {
    const prior = await query<{ request_hash: string }>(
      `SELECT request_hash FROM operations_exception_ownership_events
        WHERE actor_admin_id = $1 AND idempotency_key = $2`,
      [adminUserId, input.idempotencyKey],
    );
    if (requireMatchingReplay(prior.rows[0], hash, 'Ownership key was reused for a different claim.')) {
      return { clusterKey: input.clusterKey, assignedAdminId: adminUserId, changed: false, idempotencyReplayed: true };
    }
    await requireCurrentCluster(query, input.clusterKey);
    const current = await query<{ assigned_admin_id: string }>(
      `SELECT assigned_admin_id FROM operations_exception_ownership
        WHERE cluster_key = $1 FOR UPDATE`,
      [input.clusterKey],
    );
    const owner = current.rows[0]?.assigned_admin_id;
    if (owner && owner !== adminUserId) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Another operator already owns this exception cluster.' });
    }
    const changed = !owner;
    if (changed) {
      await query(
        `INSERT INTO operations_exception_ownership (cluster_key, assigned_admin_id)
         VALUES ($1, $2)`,
        [input.clusterKey, adminUserId],
      );
    }
    await query(
      `INSERT INTO operations_exception_ownership_events (
         cluster_key, actor_admin_id, event_type, previous_assignee_id,
         new_assignee_id, reason_code, idempotency_key, request_hash
       ) VALUES ($1, $2, 'CLAIMED', $3, $2, 'OPERATOR_CLAIM', $4, $5)`,
      [input.clusterKey, adminUserId, owner ?? null, input.idempotencyKey, hash],
    );
    return { clusterKey: input.clusterKey, assignedAdminId: adminUserId, changed, idempotencyReplayed: false };
  });
}

export function releaseOperationsException(input: OperationsOwnershipInput, adminUserId: string) {
  const hash = requestHash({
    action: 'RELEASED', clusterKey: input.clusterKey, idempotencyKey: input.idempotencyKey,
  });
  return db.transaction(async (query) => {
    const prior = await query<{ request_hash: string }>(
      `SELECT request_hash FROM operations_exception_ownership_events
        WHERE actor_admin_id = $1 AND idempotency_key = $2`,
      [adminUserId, input.idempotencyKey],
    );
    if (requireMatchingReplay(prior.rows[0], hash, 'Ownership key was reused for a different release.')) {
      return { clusterKey: input.clusterKey, assignedAdminId: null, changed: false, idempotencyReplayed: true };
    }
    const current = await query<{ assigned_admin_id: string }>(
      `SELECT assigned_admin_id FROM operations_exception_ownership
        WHERE cluster_key = $1 FOR UPDATE`,
      [input.clusterKey],
    );
    const owner = current.rows[0]?.assigned_admin_id;
    if (!owner) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This exception cluster is not assigned.' });
    }
    if (owner !== adminUserId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the assigned operator can release this exception cluster.' });
    }
    await query('DELETE FROM operations_exception_ownership WHERE cluster_key = $1', [input.clusterKey]);
    await query(
      `INSERT INTO operations_exception_ownership_events (
         cluster_key, actor_admin_id, event_type, previous_assignee_id,
         new_assignee_id, reason_code, idempotency_key, request_hash
       ) VALUES ($1, $2, 'RELEASED', $2, NULL, 'OPERATOR_RELEASE', $3, $4)`,
      [input.clusterKey, adminUserId, input.idempotencyKey, hash],
    );
    return { clusterKey: input.clusterKey, assignedAdminId: null, changed: true, idempotencyReplayed: false };
  });
}

export function scheduleNotificationDeliveryRecovery(
  input: NotificationRecoveryInput,
  adminUserId: string,
) {
  const hash = requestHash({
    action: 'NOTIFICATION_RETRY_SCHEDULED', clusterKey: input.clusterKey,
    deliveryId: input.deliveryId, idempotencyKey: input.idempotencyKey,
  });
  return db.transaction(async (query) => {
    const prior = await query<{ id: string; request_hash: string; new_next_retry_at: Date | string | null }>(
      `SELECT id, request_hash, new_next_retry_at
         FROM operations_exception_action_events
        WHERE actor_admin_id = $1 AND idempotency_key = $2`,
      [adminUserId, input.idempotencyKey],
    );
    if (requireMatchingReplay(prior.rows[0], hash, 'Recovery key was reused for a different action.')) {
      return {
        actionEventId: prior.rows[0]!.id,
        clusterKey: input.clusterKey,
        deliveryId: input.deliveryId,
        state: 'retry_pending' as const,
        scheduledFor: prior.rows[0]!.new_next_retry_at,
        delivered: false as const,
        idempotencyReplayed: true,
      };
    }
    await requireCurrentCluster(query, input.clusterKey);
    const locked = await query<{
      id: string; notification_id: string; channel: string; state: string;
      attempt_count: number; max_attempts: number; available_at: Date | string;
      next_retry_at: Date | string | null; terminal_failure_at: Date | string | null;
    }>(
      `SELECT delivery.id, delivery.notification_id, delivery.channel, delivery.state,
              delivery.attempt_count, delivery.max_attempts, delivery.available_at,
              delivery.next_retry_at, delivery.terminal_failure_at
         FROM notification_deliveries delivery
         JOIN notifications notification ON notification.id = delivery.notification_id
        WHERE delivery.id = $1
          AND delivery.channel IN ('email', 'push', 'sms')
          AND delivery.state = 'failed_terminal'
          AND delivery.attempt_count < 5
          AND delivery.max_attempts < 5
          AND ${missingWorkPredicate('delivery', 'notification')}
        FOR UPDATE OF delivery`,
      [input.deliveryId],
    );
    const delivery = locked.rows[0];
    if (!delivery) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This delivery is not eligible for a missing-work retry.',
      });
    }
    const signal = await query(
      `SELECT 1 FROM operations_exception_signals
        WHERE cluster_key = $1 AND source_type = 'notification_deliveries' AND source_id = $2`,
      [input.clusterKey, input.deliveryId],
    );
    if (signal.rows.length === 0) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Delivery does not belong to this active exception cluster.' });
    }
    const updated = await query<{
      state: string; attempt_count: number; max_attempts: number;
      available_at: Date | string; next_retry_at: Date | string;
      terminal_failure_at: Date | string | null;
    }>(
      `UPDATE notification_deliveries
          SET state = 'retry_pending',
              max_attempts = max_attempts + 1,
              available_at = NOW() + INTERVAL '5 minutes',
              next_retry_at = NOW() + INTERVAL '5 minutes',
              terminal_failure_at = NULL,
              updated_at = NOW()
        WHERE id = $1 AND state = 'failed_terminal'
        RETURNING state, attempt_count, max_attempts, available_at,
                  next_retry_at, terminal_failure_at`,
      [input.deliveryId],
    );
    const next = updated.rows[0];
    if (!next) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Delivery state changed before retry scheduling.' });
    }
    const action = await query<{ id: string }>(
      `INSERT INTO operations_exception_action_events (
         cluster_key, actor_admin_id, action_type, notification_delivery_id,
         idempotency_key, request_hash, reason_code, previous_state, new_state,
         previous_attempt_count, new_attempt_count, previous_max_attempts, new_max_attempts,
         previous_available_at, new_available_at, previous_next_retry_at, new_next_retry_at,
         previous_terminal_failure_at, new_terminal_failure_at
       ) VALUES (
         $1, $2, 'NOTIFICATION_RETRY_SCHEDULED', $3, $4, $5,
         'OPERATOR_MISSING_WORK_RETRY', $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17
       ) RETURNING id`,
      [
        input.clusterKey, adminUserId, input.deliveryId, input.idempotencyKey, hash,
        delivery.state, next.state, delivery.attempt_count, next.attempt_count,
        delivery.max_attempts, next.max_attempts, delivery.available_at, next.available_at,
        delivery.next_retry_at, next.next_retry_at, delivery.terminal_failure_at,
        next.terminal_failure_at,
      ],
    );
    return {
      actionEventId: action.rows[0]!.id,
      clusterKey: input.clusterKey,
      deliveryId: input.deliveryId,
      state: 'retry_pending' as const,
      scheduledFor: next.next_retry_at,
      delivered: false as const,
      idempotencyReplayed: false,
    };
  });
}

export function cancelNotificationDeliveryRecovery(
  input: NotificationRecoveryCancellationInput,
  adminUserId: string,
) {
  const hash = requestHash({
    action: 'NOTIFICATION_RETRY_CANCELLED', clusterKey: input.clusterKey,
    actionEventId: input.actionEventId, idempotencyKey: input.idempotencyKey,
  });
  return db.transaction(async (query) => {
    const prior = await query<{ id: string; request_hash: string; notification_delivery_id: string }>(
      `SELECT id, request_hash, notification_delivery_id
         FROM operations_exception_action_events
        WHERE actor_admin_id = $1 AND idempotency_key = $2`,
      [adminUserId, input.idempotencyKey],
    );
    if (requireMatchingReplay(prior.rows[0], hash, 'Cancellation key was reused for a different action.')) {
      return {
        actionEventId: prior.rows[0]!.id, clusterKey: input.clusterKey,
        deliveryId: prior.rows[0]!.notification_delivery_id,
        state: 'failed_terminal' as const, cancelled: true as const, idempotencyReplayed: true,
      };
    }
    const scheduled = await query<{
      id: string; notification_delivery_id: string; previous_state: string;
      previous_attempt_count: number; previous_max_attempts: number;
      previous_available_at: Date | string; previous_next_retry_at: Date | string | null;
      previous_terminal_failure_at: Date | string | null;
      new_max_attempts: number; new_available_at: Date | string;
      new_next_retry_at: Date | string | null;
    }>(
      `SELECT id, notification_delivery_id, previous_state, previous_attempt_count,
              previous_max_attempts, previous_available_at, previous_next_retry_at,
              previous_terminal_failure_at, new_max_attempts, new_available_at, new_next_retry_at
         FROM operations_exception_action_events action
        WHERE action.id = $1
          AND action.cluster_key = $2
          AND action.action_type = 'NOTIFICATION_RETRY_SCHEDULED'
          AND NOT EXISTS (
            SELECT 1 FROM operations_exception_action_events reversal
             WHERE reversal.reversal_of_action_id = action.id
          )`,
      [input.actionEventId, input.clusterKey],
    );
    const schedule = scheduled.rows[0];
    if (!schedule) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Retry is missing, already cancelled, or belongs to another cluster.' });
    }
    const locked = await query<{
      id: string; notification_id: string; state: string; attempt_count: number;
      max_attempts: number; available_at: Date | string; next_retry_at: Date | string | null;
      terminal_failure_at: Date | string | null;
    }>(
      `SELECT delivery.id, delivery.notification_id, delivery.state, delivery.attempt_count,
              delivery.max_attempts, delivery.available_at, delivery.next_retry_at,
              delivery.terminal_failure_at
         FROM notification_deliveries delivery
         JOIN notifications notification ON notification.id = delivery.notification_id
        WHERE delivery.id = $1
          AND delivery.state = 'retry_pending'
          AND delivery.next_retry_at > NOW()
          AND delivery.max_attempts = $2
          AND ${missingWorkPredicate('delivery', 'notification')}
        FOR UPDATE OF delivery`,
      [schedule.notification_delivery_id, schedule.new_max_attempts],
    );
    const delivery = locked.rows[0];
    if (!delivery) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Retry can no longer be cancelled because recovery work is due, queued, or state changed.',
      });
    }
    const restored = await query<{
      state: string; attempt_count: number; max_attempts: number;
      available_at: Date | string; next_retry_at: Date | string | null;
      terminal_failure_at: Date | string | null;
    }>(
      `UPDATE notification_deliveries
          SET state = $2,
              attempt_count = $3,
              max_attempts = $4,
              available_at = $5,
              next_retry_at = $6,
              terminal_failure_at = $7,
              updated_at = NOW()
        WHERE id = $1 AND state = 'retry_pending'
        RETURNING state, attempt_count, max_attempts, available_at,
                  next_retry_at, terminal_failure_at`,
      [
        delivery.id, schedule.previous_state, schedule.previous_attempt_count,
        schedule.previous_max_attempts, schedule.previous_available_at,
        schedule.previous_next_retry_at, schedule.previous_terminal_failure_at,
      ],
    );
    const next = restored.rows[0];
    if (!next) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Delivery state changed before cancellation.' });
    }
    const action = await query<{ id: string }>(
      `INSERT INTO operations_exception_action_events (
         cluster_key, actor_admin_id, action_type, notification_delivery_id,
         idempotency_key, request_hash, reason_code, previous_state, new_state,
         previous_attempt_count, new_attempt_count, previous_max_attempts, new_max_attempts,
         previous_available_at, new_available_at, previous_next_retry_at, new_next_retry_at,
         previous_terminal_failure_at, new_terminal_failure_at, reversal_of_action_id
       ) VALUES (
         $1, $2, 'NOTIFICATION_RETRY_CANCELLED', $3, $4, $5,
         'OPERATOR_RETRY_CANCELLED', $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17, $18
       ) RETURNING id`,
      [
        input.clusterKey, adminUserId, delivery.id, input.idempotencyKey, hash,
        delivery.state, next.state, delivery.attempt_count, next.attempt_count,
        delivery.max_attempts, next.max_attempts, delivery.available_at, next.available_at,
        delivery.next_retry_at, next.next_retry_at, delivery.terminal_failure_at,
        next.terminal_failure_at, schedule.id,
      ],
    );
    return {
      actionEventId: action.rows[0]!.id, clusterKey: input.clusterKey,
      deliveryId: delivery.id, state: 'failed_terminal' as const,
      cancelled: true as const, idempotencyReplayed: false,
    };
  });
}

export async function getOperationsModelHealth() {
  const [calibration, automation, samples] = await Promise.all([
    db.query<{
      model_version: string; confidence_band: string; recommendation_count: string;
      outcome_observed_count: string; positive_outcome_count: string;
      adverse_outcome_count: string; override_count: string;
      recent_count: string; recent_positive_count: string;
      previous_count: string; previous_positive_count: string;
    }>(
      `WITH outcome AS (
         SELECT recommendation_id,
                TRUE AS observed,
                BOOL_OR(outcome_type IN ('TASK_ACCEPTED','TASK_COMPLETED','TASK_SETTLED')) AS positive,
                BOOL_OR(outcome_type IN ('TASK_CANCELLED','TASK_DISPUTED')) AS adverse
           FROM recommendation_outcomes GROUP BY recommendation_id
       ), event AS (
         SELECT recommendation_id, BOOL_OR(event_type = 'OVERRIDDEN') AS overridden
           FROM recommendation_events GROUP BY recommendation_id
       )
       SELECT COALESCE(recommendation.model_version, 'UNATTRIBUTED') AS model_version,
              recommendation.confidence_band,
              COUNT(*)::TEXT AS recommendation_count,
              COUNT(*) FILTER (WHERE outcome.observed)::TEXT AS outcome_observed_count,
              COUNT(*) FILTER (WHERE outcome.positive)::TEXT AS positive_outcome_count,
              COUNT(*) FILTER (WHERE outcome.adverse)::TEXT AS adverse_outcome_count,
              COUNT(*) FILTER (WHERE event.overridden)::TEXT AS override_count,
              COUNT(*) FILTER (WHERE recommendation.created_at >= NOW() - INTERVAL '14 days')::TEXT AS recent_count,
              COUNT(*) FILTER (WHERE recommendation.created_at >= NOW() - INTERVAL '14 days' AND outcome.positive)::TEXT AS recent_positive_count,
              COUNT(*) FILTER (WHERE recommendation.created_at >= NOW() - INTERVAL '28 days'
                                AND recommendation.created_at < NOW() - INTERVAL '14 days')::TEXT AS previous_count,
              COUNT(*) FILTER (WHERE recommendation.created_at >= NOW() - INTERVAL '28 days'
                                AND recommendation.created_at < NOW() - INTERVAL '14 days'
                                AND outcome.positive)::TEXT AS previous_positive_count
         FROM recommendations recommendation
         LEFT JOIN outcome ON outcome.recommendation_id = recommendation.id
         LEFT JOIN event ON event.recommendation_id = recommendation.id
        WHERE recommendation.created_at >= NOW() - INTERVAL '28 days'
        GROUP BY COALESCE(recommendation.model_version, 'UNATTRIBUTED'), recommendation.confidence_band
        ORDER BY 1, 2`,
    ),
    db.query<{
      model_version: string; action_class: string; action_count: string;
      failure_count: string; recovery_count: string; recent_failure_count: string;
      previous_failure_count: string;
    }>(
      `SELECT model_version, action_class,
              COUNT(*)::TEXT AS action_count,
              COUNT(*) FILTER (WHERE result IN ('FAILURE','REJECTED','CONFLICT'))::TEXT AS failure_count,
              COUNT(*) FILTER (WHERE recovery_action_code IS NOT NULL)::TEXT AS recovery_count,
              COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '14 days'
                                AND result IN ('FAILURE','REJECTED','CONFLICT'))::TEXT AS recent_failure_count,
              COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '28 days'
                                AND occurred_at < NOW() - INTERVAL '14 days'
                                AND result IN ('FAILURE','REJECTED','CONFLICT'))::TEXT AS previous_failure_count
         FROM major_action_events
        WHERE model_applicability = 'APPLIED'
          AND occurred_at >= NOW() - INTERVAL '28 days'
        GROUP BY model_version, action_class ORDER BY model_version, action_class`,
    ),
    db.query(
      `WITH classified AS (
         SELECT recommendation.id, recommendation.subject_type, recommendation.subject_id,
                recommendation.recommendation_class, recommendation.confidence_band,
                COALESCE(recommendation.model_version, 'UNATTRIBUTED') AS model_version,
                recommendation.policy_version, recommendation.reason,
                BOOL_OR(outcome.outcome_type IN ('TASK_CANCELLED','TASK_DISPUTED')) AS adverse,
                BOOL_OR(outcome.outcome_type IN ('TASK_ACCEPTED','TASK_COMPLETED','TASK_SETTLED')) AS positive
           FROM recommendations recommendation
           JOIN recommendation_outcomes outcome ON outcome.recommendation_id = recommendation.id
          WHERE recommendation.created_at >= NOW() - INTERVAL '28 days'
          GROUP BY recommendation.id
       )
       SELECT id, subject_type, subject_id, recommendation_class, confidence_band,
              model_version, policy_version, reason,
              CASE WHEN adverse AND confidence_band = 'HIGH' THEN 'HIGH_CONFIDENCE_ADVERSE'
                   ELSE 'LOW_CONFIDENCE_POSITIVE' END AS review_signal
         FROM classified
        WHERE (adverse AND confidence_band = 'HIGH')
           OR (positive AND confidence_band = 'LOW')
        ORDER BY id LIMIT 20`,
    ),
  ]);

  const calibrationRows = calibration.rows.map((row) => {
    const recent = numberValue(row.recent_count);
    const previous = numberValue(row.previous_count);
    const recentPositive = numberValue(row.recent_positive_count);
    const previousPositive = numberValue(row.previous_positive_count);
    return {
      modelVersion: row.model_version,
      confidenceBand: row.confidence_band,
      recommendationCount: numberValue(row.recommendation_count),
      outcomeObservedCount: numberValue(row.outcome_observed_count),
      positiveOutcomeCount: numberValue(row.positive_outcome_count),
      adverseOutcomeCount: numberValue(row.adverse_outcome_count),
      overrideCount: numberValue(row.override_count),
      recentCount: recent,
      previousCount: previous,
      realizedOutcomeDrift: recent >= 5 && previous >= 5
        ? recentPositive / recent - previousPositive / previous
        : null,
    };
  });
  const totalRecommendations = calibrationRows.reduce((sum, row) => sum + row.recommendationCount, 0);
  const totalObserved = calibrationRows.reduce((sum, row) => sum + row.outcomeObservedCount, 0);
  return {
    windowDays: 28 as const,
    dataState: totalRecommendations >= 20 && totalObserved >= 10
      ? 'MEASURED' as const : 'INSUFFICIENT_DATA' as const,
    minimums: { recommendations: 20, observedOutcomes: 10 },
    totals: { recommendations: totalRecommendations, observedOutcomes: totalObserved },
    calibration: calibrationRows,
    automation: automation.rows.map((row) => ({
      modelVersion: row.model_version,
      actionClass: row.action_class,
      actionCount: numberValue(row.action_count),
      failureCount: numberValue(row.failure_count),
      recoveryCount: numberValue(row.recovery_count),
      recentFailureCount: numberValue(row.recent_failure_count),
      previousFailureCount: numberValue(row.previous_failure_count),
    })),
    reviewSamples: samples.rows,
    accuracyClaimed: false as const,
  };
}

export const OperationsExceptionService = {
  list: listOperationsExceptions,
  getDetail: getOperationsExceptionDetail,
  claim: claimOperationsException,
  release: releaseOperationsException,
  scheduleNotificationRecovery: scheduleNotificationDeliveryRecovery,
  cancelNotificationRecovery: cancelNotificationDeliveryRecovery,
  getModelHealth: getOperationsModelHealth,
};
