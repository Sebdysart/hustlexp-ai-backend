import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPool, createTestUser, hasDb } from '../setup.js';

const DIGEST = 'a'.repeat(64);
const SECOND_DIGEST = 'b'.repeat(64);

let pool: pg.Pool | undefined;

async function database(): Promise<pg.Pool> {
  if (!pool) throw new Error('PostgreSQL test pool is unavailable');
  return pool;
}

async function operator(role: 'support' | 'admin'): Promise<string> {
  const db = await database();
  const userId = await createTestUser(
    db,
    `test-universal-ops-case-${role}-${randomUUID()}@hustlexp.test`
  );
  await db.query(
    `INSERT INTO admin_roles(user_id, role, can_manage_operations)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (user_id) DO UPDATE SET
       role = EXCLUDED.role,
       can_manage_operations = TRUE`,
    [userId, role]
  );
  return userId;
}

interface OccurrenceFixture {
  occurrenceId: string;
  eventName: string;
  eventVersion: number;
  aggregateKind: string;
  aggregateId: string;
  aggregateVersion: number;
}

async function occurrence(): Promise<OccurrenceFixture> {
  const db = await database();
  const occurrenceId = randomUUID();
  const aggregateId = randomUUID();
  const sourceEventId = `ops-case-${randomUUID()}`;
  const idempotencyKey = `ops-case-event-${randomUUID()}`;
  await db.query(
    `INSERT INTO major_action_events(
       id, event_name, event_version, action_class, automation_class,
       actor_role, actor_ref, aggregate_type, aggregate_id,
       previous_lifecycle_state, lifecycle_state, sync_state,
       entry_surface, context_source, policy_version, policy_applicability,
       model_version, model_applicability, risk_class, correlation_id,
       causation_id, idempotency_key, source_sequence, ordering_state,
       environment, is_test, payload_hash, result, latency_ms, latency_class,
       failure_reason_code, recovery_action_code, change_reason_code,
       experiment_variant, experiment_applicability, reversible,
       source_table, source_event_id, occurred_at
     ) VALUES (
       $1, 'task.execution.failed', 1, 'EXECUTION', 'A2',
       'SYSTEM', 'system:ops-case-test', 'task_draft', $2,
       'WORKING', 'FAILED', 'SERVER_CONFIRMED',
       'OPS_CASE_TEST', 'POSTGRESQL', 'universal-v1-ops-case-test-v1', 'APPLIED',
       'NOT_APPLICABLE', 'NOT_APPLICABLE', 'HIGH', $3,
       $4, $5, 7, 'IN_ORDER',
       'TEST', TRUE, $6, 'FAILURE', 1, 'LT_100MS',
       'EXECUTION_TEST_FAILURE', 'OPEN_OPERATIONS_CASE', 'OPS_CASE_TEST_FAILURE',
       'NOT_APPLICABLE', 'NOT_APPLICABLE', TRUE,
       'task_work_order_execution_facts', $7, clock_timestamp()
     )`,
    [
      occurrenceId,
      aggregateId,
      `ops-case-correlation:${randomUUID()}`,
      `ops-case-causation:${randomUUID()}`,
      idempotencyKey,
      DIGEST,
      sourceEventId,
    ]
  );
  return {
    occurrenceId,
    eventName: 'task.execution.failed',
    eventVersion: 1,
    aggregateKind: 'task_draft',
    aggregateId,
    aggregateVersion: 7,
  };
}

async function openCase(source: OccurrenceFixture, actorId: string, idempotencyKey = randomUUID()) {
  const db = await database();
  const result = await db.query<{
    case_id: string;
    case_status: string;
    case_version: string;
    idempotency_replayed: boolean;
  }>(
    `SELECT * FROM open_universal_v1_ops_case_v1(
       $1, $2, $3, $4, $5, $6,
       'FULFILLMENT', 'HIGH', $7, $8, $9, $10
     )`,
    [
      source.occurrenceId,
      source.eventName,
      source.eventVersion,
      source.aggregateKind,
      source.aggregateId,
      source.aggregateVersion,
      'Exact failed execution occurrence requires operator investigation.',
      DIGEST,
      actorId,
      idempotencyKey,
    ]
  );
  return { ...result.rows[0], idempotencyKey };
}

beforeAll(async () => {
  if (!hasDb) return;
  pool = createTestPool();
  await pool.query("SELECT to_regclass('public.universal_v1_ops_cases') AS relation");
});

afterAll(async () => {
  await pool?.end();
});

describe.skipIf(!hasDb)('Universal V1 authoritative Operations cases', () => {
  it('runs OPEN through RESOLVED with exact versions and two distinct operators', async () => {
    const db = await database();
    const requesterId = await operator('admin');
    const approverId = await operator('admin');
    const source = await occurrence();
    const sourceBefore = await db.query<{ snapshot: Record<string, unknown> }>(
      'SELECT to_jsonb(event) AS snapshot FROM major_action_events event WHERE id = $1',
      [source.occurrenceId]
    );
    const opened = await openCase(source, requesterId);
    expect(opened).toMatchObject({ case_status: 'OPEN', case_version: '1' });

    const acknowledged = await db.query(
      `SELECT * FROM acknowledge_universal_v1_ops_case_v1(
         $1, 1, $2, $3, $4, $5
       )`,
      [
        opened.case_id,
        'Acknowledge exact immutable evidence and begin investigation.',
        DIGEST,
        requesterId,
        randomUUID(),
      ]
    );
    expect(acknowledged.rows[0]).toMatchObject({
      case_status: 'ACKNOWLEDGED',
      case_version: '2',
    });

    const containment = await db.query(
      `SELECT * FROM request_universal_v1_ops_case_transition_v1(
         $1, 2, 'CONTAIN', $2, $3, $4, $5
       )`,
      [
        opened.case_id,
        'Request bounded case containment after reviewing exact evidence.',
        DIGEST,
        requesterId,
        randomUUID(),
      ]
    );
    await expect(
      db.query(
        `SELECT * FROM decide_universal_v1_ops_case_transition_v1(
           $1, 1, 2, 'APPROVE', $2, $3, $4, $5
         )`,
        [
          containment.rows[0].transition_request_id,
          'Attempt self approval of the containment transition request.',
          DIGEST,
          requesterId,
          randomUUID(),
        ]
      )
    ).rejects.toThrow(/HXUOC16/);
    const contained = await db.query(
      `SELECT * FROM decide_universal_v1_ops_case_transition_v1(
         $1, 1, 2, 'APPROVE', $2, $3, $4, $5
       )`,
      [
        containment.rows[0].transition_request_id,
        'Independently approve evidence-only Operations case containment.',
        SECOND_DIGEST,
        approverId,
        randomUUID(),
      ]
    );
    expect(contained.rows[0]).toMatchObject({
      case_status: 'CONTAINED',
      case_version: '3',
      request_status: 'APPROVED',
      request_version: '2',
    });

    const resolution = await db.query(
      `SELECT * FROM request_universal_v1_ops_case_transition_v1(
         $1, 3, 'RESOLVE', $2, $3, $4, $5
       )`,
      [
        opened.case_id,
        'Request resolution after containment evidence was independently verified.',
        DIGEST,
        requesterId,
        randomUUID(),
      ]
    );
    const resolved = await db.query(
      `SELECT * FROM decide_universal_v1_ops_case_transition_v1(
         $1, 1, 3, 'APPROVE', $2, $3, $4, $5
       )`,
      [
        resolution.rows[0].transition_request_id,
        'Independently approve resolution of the exact contained case.',
        SECOND_DIGEST,
        approverId,
        randomUUID(),
      ]
    );
    expect(resolved.rows[0]).toMatchObject({
      case_status: 'RESOLVED',
      case_version: '4',
      request_status: 'APPROVED',
      request_version: '2',
    });

    const timeline = await db.query<{ event_type: string; sequence: string }>(
      `SELECT event_type, sequence
         FROM universal_v1_ops_case_timeline
        WHERE case_id = $1
        ORDER BY sequence`,
      [opened.case_id]
    );
    expect(timeline.rows.map((row) => row.event_type)).toEqual([
      'OPENED',
      'ACKNOWLEDGED',
      'CONTAINMENT_REQUESTED',
      'CONTAINED',
      'RESOLUTION_REQUESTED',
      'RESOLVED',
    ]);
    expect(timeline.rows.map((row) => row.sequence)).toEqual(['1', '2', '3', '4', '5', '6']);

    const sourceAfter = await db.query<{ snapshot: Record<string, unknown> }>(
      'SELECT to_jsonb(event) AS snapshot FROM major_action_events event WHERE id = $1',
      [source.occurrenceId]
    );
    expect(sourceAfter.rows[0]?.snapshot).toEqual(sourceBefore.rows[0]?.snapshot);
  });

  it('fails closed on mismatched occurrence versions and replays only exact open input', async () => {
    const db = await database();
    const actorId = await operator('support');
    const source = await occurrence();
    const key = randomUUID();
    await expect(
      db.query(
        `SELECT * FROM open_universal_v1_ops_case_v1(
           $1, $2, 99, $3, $4, $5,
           'DATA_INTEGRITY', 'HIGH', $6, $7, $8, $9
         )`,
        [
          source.occurrenceId,
          source.eventName,
          source.aggregateKind,
          source.aggregateId,
          source.aggregateVersion,
          'Reject a stale or fabricated occurrence version before case opening.',
          DIGEST,
          actorId,
          key,
        ]
      )
    ).rejects.toThrow(/HXUOC5/);

    const opened = await openCase(source, actorId, key);
    const replay = await openCase(source, actorId, key);
    expect(replay).toMatchObject({
      case_id: opened.case_id,
      case_status: 'OPEN',
      case_version: '1',
      idempotency_replayed: true,
    });
    await expect(
      db.query(
        `SELECT * FROM open_universal_v1_ops_case_v1(
           $1, $2, $3, $4, $5, $6,
           'FULFILLMENT', 'CRITICAL', $7, $8, $9, $10
         )`,
        [
          source.occurrenceId,
          source.eventName,
          source.eventVersion,
          source.aggregateKind,
          source.aggregateId,
          source.aggregateVersion,
          'Exact failed execution occurrence requires operator investigation.',
          DIGEST,
          actorId,
          key,
        ]
      )
    ).rejects.toThrow(/HXUOC20/);
  });

  it('rejects arbitrary lifecycle jumps and all timeline mutation', async () => {
    const db = await database();
    const actorId = await operator('support');
    const source = await occurrence();
    const opened = await openCase(source, actorId);
    await expect(
      db.query(
        `UPDATE universal_v1_ops_cases
            SET status = 'CONTAINED',
                version = version + 1,
                contained_by = $2,
                contained_at = clock_timestamp(),
                last_transition_at = clock_timestamp()
          WHERE id = $1`,
        [opened.case_id, actorId]
      )
    ).rejects.toThrow(/HXUOC11|violates check constraint/);
    await expect(
      db.query(
        `UPDATE universal_v1_ops_case_timeline
            SET reason = 'Attempt to rewrite immutable case evidence.'
          WHERE case_id = $1`,
        [opened.case_id]
      )
    ).rejects.toThrow(/HXUOC19/);
    await expect(
      db.query('DELETE FROM universal_v1_ops_case_timeline WHERE case_id = $1', [opened.case_id])
    ).rejects.toThrow(/HXUOC19/);
  });

  it('lets a distinct admin reject a request without changing case state', async () => {
    const db = await database();
    const requesterId = await operator('support');
    const approverId = await operator('admin');
    const source = await occurrence();
    const opened = await openCase(source, requesterId);
    await db.query(
      `SELECT * FROM acknowledge_universal_v1_ops_case_v1(
         $1, 1, $2, $3, $4, $5
       )`,
      [
        opened.case_id,
        'Acknowledge exact evidence before requesting containment review.',
        DIGEST,
        requesterId,
        randomUUID(),
      ]
    );
    const requested = await db.query(
      `SELECT * FROM request_universal_v1_ops_case_transition_v1(
         $1, 2, 'CONTAIN', $2, $3, $4, $5
       )`,
      [
        opened.case_id,
        'Request containment for independent operational review.',
        DIGEST,
        requesterId,
        randomUUID(),
      ]
    );
    const rejected = await db.query(
      `SELECT * FROM decide_universal_v1_ops_case_transition_v1(
         $1, 1, 2, 'REJECT', $2, $3, $4, $5
       )`,
      [
        requested.rows[0].transition_request_id,
        'Reject because containment evidence is not yet sufficient.',
        SECOND_DIGEST,
        approverId,
        randomUUID(),
      ]
    );
    expect(rejected.rows[0]).toMatchObject({
      case_status: 'ACKNOWLEDGED',
      case_version: '2',
      request_status: 'REJECTED',
      request_version: '2',
    });
    const latest = await db.query(
      'SELECT status, version FROM universal_v1_ops_cases WHERE id = $1',
      [opened.case_id]
    );
    expect(latest.rows[0]).toEqual({ status: 'ACKNOWLEDGED', version: '2' });
  });
});
