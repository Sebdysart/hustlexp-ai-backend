import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
}));

import { db } from '../../src/db';
import {
  cancelNotificationDeliveryRecovery,
  getOperationsExceptionDetail,
  getOperationsModelHealth,
  listOperationsExceptions,
  scheduleNotificationDeliveryRecovery,
} from '../../src/services/OperationsExceptionService';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const DELIVERY_ID = '22222222-2222-4222-8222-222222222222';
const ACTION_ID = '33333333-3333-4333-8333-333333333333';
const CANCEL_ID = '44444444-4444-4444-8444-444444444444';
const NOTIFICATION_ID = '55555555-5555-4555-8555-555555555555';
const CLUSTER = 'communication_failure:postmark:email';

const mockDb = vi.mocked(db);

describe('OperationsExceptionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.mockReset();
    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(async (fn: any) => fn(mockDb.query));
  });

  it('lists server-grouped root causes in canonical priority order without raw payloads', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{
      cluster_key: CLUSTER, priority_rank: '6', priority_class: 'COMMUNICATION',
      root_cause_code: 'TERMINAL_EMAIL_DELIVERY_FAILURE',
      root_cause_label: 'Terminal communication delivery failure', severity: 'MEDIUM',
      lifecycle_state: 'failed_terminal', signal_count: '3',
      oldest_detected_at: '2026-07-20T10:00:00Z', newest_detected_at: '2026-07-20T11:00:00Z',
      amount_cents: null, currency: null, policy_version: 'hxos-notification-delivery-v1',
      model_version: 'NOT_APPLICABLE', model_applicability: 'NOT_APPLICABLE',
      automation_class: 'A2', recovery_eligible: true,
      recovery_kind: 'MISSING_NOTIFICATION_WORK_RETRY', provider_name: 'postmark',
      assigned_admin_id: null, assigned_at: null, owned_by_current_operator: false,
    }], rowCount: 1 } as any);

    await expect(listOperationsExceptions({
      ownership: 'ALL', sort: 'PRIORITY', limit: 50, offset: 0,
    }, ADMIN_ID)).resolves.toMatchObject([{ priority_rank: 6, signal_count: 3 }]);

    const sql = String(mockDb.query.mock.calls[0]![0]);
    expect(sql).toContain('FROM operations_exception_signals signal');
    expect(sql).toContain('ORDER BY MIN(signal.priority_rank), MIN(signal.detected_at)');
    expect(sql).not.toContain('description');
    expect(sql).not.toContain('last_error');
    expect(sql).not.toContain('notification.body');
  });

  it('purpose-logs detail and returns explicit evidence fields without raw safety or notification data', async () => {
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM operations_exception_signals') && sql.includes('SELECT signal_id')) {
        return { rows: [{
          signal_id: `communication:${DELIVERY_ID}`, cluster_key: CLUSTER,
          source_id: DELIVERY_ID, source_type: 'notification_deliveries', task_id: null,
          evidence_summary: 'Provider-observable terminal failure; destination masked.',
        }], rowCount: 1 } as any;
      }
      if (sql.includes('FROM operations_exception_ownership WHERE')) return { rows: [], rowCount: 0 } as any;
      if (sql.includes('FROM operations_exception_ownership_events')) return { rows: [], rowCount: 0 } as any;
      if (sql.includes('FROM operations_exception_action_events')) return { rows: [], rowCount: 0 } as any;
      if (sql.includes('FROM major_action_events')) return { rows: [], rowCount: 0 } as any;
      if (sql.includes('FROM recommendations recommendation')) return { rows: [], rowCount: 0 } as any;
      if (sql.includes('INSERT INTO operations_exception_access_log')) return { rows: [], rowCount: 1 } as any;
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    });

    const result = await getOperationsExceptionDetail(
      CLUSTER,
      'Investigate canonical failure evidence and bounded recovery.',
      ADMIN_ID,
    );
    expect(result.operatorAccessRecorded).toBe(true);
    expect(result.signals).toHaveLength(1);
    const combined = mockDb.query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(combined).toContain('INSERT INTO operations_exception_access_log');
    expect(combined).not.toContain('incident.description');
    expect(combined).not.toContain('delivery.last_error');
    expect(combined).not.toContain('notification.body');
  });

  it('schedules one extra missing-work attempt without making a provider call', async () => {
    const scheduledFor = '2026-07-20T12:05:00.000Z';
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM operations_exception_action_events') && sql.includes('actor_admin_id')) return { rows: [], rowCount: 0 } as any;
      if (sql.includes('COUNT(*)::TEXT AS signal_count')) return { rows: [{ signal_count: '1' }], rowCount: 1 } as any;
      if (sql.includes('FROM notification_deliveries delivery') && sql.includes("state = 'failed_terminal'")) return { rows: [{
        id: DELIVERY_ID, notification_id: NOTIFICATION_ID, channel: 'email', state: 'failed_terminal',
        attempt_count: 3, max_attempts: 3, available_at: '2026-07-20T12:00:00Z',
        next_retry_at: null, terminal_failure_at: '2026-07-20T12:00:00Z',
      }], rowCount: 1 } as any;
      if (sql.includes('SELECT 1 FROM operations_exception_signals')) return { rows: [{ '?column?': 1 }], rowCount: 1 } as any;
      if (sql.includes('UPDATE notification_deliveries')) return { rows: [{
        state: 'retry_pending', attempt_count: 3, max_attempts: 4,
        available_at: scheduledFor, next_retry_at: scheduledFor, terminal_failure_at: null,
      }], rowCount: 1 } as any;
      if (sql.includes('INSERT INTO operations_exception_action_events')) return { rows: [{ id: ACTION_ID }], rowCount: 1 } as any;
      throw new Error(`unexpected SQL: ${sql.slice(0, 100)}`);
    });

    const result = await scheduleNotificationDeliveryRecovery({
      clusterKey: CLUSTER, deliveryId: DELIVERY_ID,
      idempotencyKey: '66666666-6666-4666-8666-666666666666',
    }, ADMIN_ID);
    expect(result).toMatchObject({
      actionEventId: ACTION_ID, state: 'retry_pending', delivered: false, scheduledFor,
    });
    const combined = mockDb.query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(combined).toContain("max_attempts = max_attempts + 1");
    expect(combined).toContain("NOW() + INTERVAL '5 minutes'");
    expect(combined).not.toContain('provider_accepted');
    expect(combined).not.toContain('NotificationService');
  });

  it('cancels only a not-yet-due retry and restores its exact terminal state', async () => {
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('actor_admin_id = $1') && sql.includes('idempotency_key = $2')) return { rows: [], rowCount: 0 } as any;
      if (sql.includes("action.action_type = 'NOTIFICATION_RETRY_SCHEDULED'")) return { rows: [{
        id: ACTION_ID, notification_delivery_id: DELIVERY_ID, previous_state: 'failed_terminal',
        previous_attempt_count: 3, previous_max_attempts: 3,
        previous_available_at: '2026-07-20T12:00:00Z', previous_next_retry_at: null,
        previous_terminal_failure_at: '2026-07-20T12:00:00Z', new_max_attempts: 4,
        new_available_at: '2026-07-20T12:05:00Z', new_next_retry_at: '2026-07-20T12:05:00Z',
      }], rowCount: 1 } as any;
      if (sql.includes('FROM notification_deliveries delivery') && sql.includes("delivery.state = 'retry_pending'")) return { rows: [{
        id: DELIVERY_ID, notification_id: NOTIFICATION_ID, state: 'retry_pending', attempt_count: 3,
        max_attempts: 4, available_at: '2026-07-20T12:05:00Z',
        next_retry_at: '2026-07-20T12:05:00Z', terminal_failure_at: null,
      }], rowCount: 1 } as any;
      if (sql.includes('UPDATE notification_deliveries')) return { rows: [{
        state: 'failed_terminal', attempt_count: 3, max_attempts: 3,
        available_at: '2026-07-20T12:00:00Z', next_retry_at: null,
        terminal_failure_at: '2026-07-20T12:00:00Z',
      }], rowCount: 1 } as any;
      if (sql.includes('INSERT INTO operations_exception_action_events')) return { rows: [{ id: CANCEL_ID }], rowCount: 1 } as any;
      throw new Error(`unexpected SQL: ${sql.slice(0, 100)}`);
    });

    await expect(cancelNotificationDeliveryRecovery({
      clusterKey: CLUSTER, actionEventId: ACTION_ID,
      idempotencyKey: '77777777-7777-4777-8777-777777777777',
    }, ADMIN_ID)).resolves.toMatchObject({
      actionEventId: CANCEL_ID, state: 'failed_terminal', cancelled: true,
    });
    const update = mockDb.query.mock.calls.find((call) => String(call[0]).includes('UPDATE notification_deliveries'))!;
    expect(update[1]).toEqual(expect.arrayContaining([
      DELIVERY_ID, 'failed_terminal', 3, 3, '2026-07-20T12:00:00Z', null,
    ]));
  });

  it('reports insufficient model data instead of a vanity accuracy score', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{
        model_version: 'match-v1', confidence_band: 'HIGH', recommendation_count: '3',
        outcome_observed_count: '1', positive_outcome_count: '1', adverse_outcome_count: '0',
        override_count: '0', recent_count: '3', recent_positive_count: '1',
        previous_count: '0', previous_positive_count: '0',
      }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    await expect(getOperationsModelHealth()).resolves.toMatchObject({
      dataState: 'INSUFFICIENT_DATA', accuracyClaimed: false,
      totals: { recommendations: 3, observedOutcomes: 1 },
    });
  });
});
