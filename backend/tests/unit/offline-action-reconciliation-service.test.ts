import { describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../src/db.js';
import {
  reconcileOfflineActions,
  type OfflineActionProbe,
} from '../../src/services/OfflineActionReconciliationService.js';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const POSTER_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_ID = '33333333-3333-4333-8333-333333333333';
const OUTSIDER_ID = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);

const probe: OfflineActionProbe = {
  actionClass: 'PROOF_COMPLETION',
  clientIdentity: 'proof-submit:11111111-1111-4111-8111-111111111111',
  clientSequence: 101,
  priorServerVersion: 7,
  localOccurredAt: '2026-07-20T12:00:00.000Z',
  payloadHash: HASH,
};

type Fixture = {
  task?: null | Record<string, unknown>;
  stored?: null | Record<string, unknown>;
  latest?: number;
};

function fixtureQuery(fixture: Fixture = {}): QueryFn {
  const task = fixture.task === undefined ? {
    id: TASK_ID,
    poster_id: POSTER_ID,
    worker_id: WORKER_ID,
    state: 'ACCEPTED',
    progress_state: 'IN_PROGRESS',
    version: 7,
  } : fixture.task;
  return vi.fn(async (sql: string) => {
    if (sql.includes('FROM tasks WHERE id=$1')) return { rows: task ? [task] : [] };
    if (sql.includes('AS client_identity')) return { rows: fixture.stored ? [fixture.stored] : [] };
    if (sql.includes('MAX(client_sequence)')) return { rows: [{ client_sequence: fixture.latest ?? 0 }] };
    throw new Error(`Unexpected query: ${sql}`);
  }) as unknown as QueryFn;
}

function stored(overrides: Record<string, unknown> = {}) {
  return {
    client_identity: probe.clientIdentity,
    client_sequence: probe.clientSequence,
    prior_task_version: probe.priorServerVersion,
    offline_payload_hash: probe.payloadHash,
    reconciliation_contract_version: 1,
    local_occurred_at: probe.localOccurredAt,
    created_at: '2026-07-20T12:01:00.000Z',
    ...overrides,
  };
}

describe('offline action reconciliation service', () => {
  it('confirms only an exact server evidence match and identifies engine authority', async () => {
    const result = await reconcileOfflineActions({ taskId: TASK_ID, actions: [probe] }, WORKER_ID, fixtureQuery({ stored: stored() }));
    expect(result).toMatchObject({
      taskId: TASK_ID,
      lifecycleState: 'ACCEPTED',
      progressState: 'IN_PROGRESS',
      serverVersion: 7,
      lifecycleOwner: 'HUSTLER',
      confirmationAuthority: 'HUSTLEXP_ENGINE',
    });
    expect(result.actions).toEqual([expect.objectContaining({
      syncState: 'SERVER_CONFIRMED',
      evidenceMatch: 'EXACT',
      reasonCode: 'EXACT_SERVER_EVIDENCE_MATCH',
      recoveryAction: 'NONE',
      confirmedAt: '2026-07-20T12:01:00.000Z',
    })]);
  });

  it('labels pre-reconciliation records as legacy identity matches without claiming hash equality', async () => {
    const result = await reconcileOfflineActions(
      { taskId: TASK_ID, actions: [probe] },
      WORKER_ID,
      fixtureQuery({ stored: stored({ reconciliation_contract_version: 0, offline_payload_hash: null }) }),
    );
    expect(result.actions[0]).toMatchObject({
      syncState: 'SERVER_CONFIRMED',
      evidenceMatch: 'LEGACY_IDENTITY_ONLY',
      reasonCode: 'LEGACY_SERVER_IDENTITY_MATCH',
    });
  });

  it.each([
    ['payload hash', { offline_payload_hash: 'b'.repeat(64) }],
    ['client sequence', { client_sequence: 102 }],
    ['prior task version', { prior_task_version: 6 }],
    ['local occurrence time', { local_occurred_at: '2026-07-20T12:00:01.000Z' }],
  ])('classifies a stored %s mismatch as conflict', async (_label, mismatch) => {
    const result = await reconcileOfflineActions(
      { taskId: TASK_ID, actions: [probe] }, WORKER_ID,
      fixtureQuery({ stored: stored(mismatch) }),
    );
    expect(result.actions[0]).toMatchObject({
      syncState: 'CONFLICT', reasonCode: 'SERVER_EVIDENCE_MISMATCH',
      recoveryAction: 'REFRESH_AND_REVIEW', evidenceMatch: 'CONFLICT',
    });
  });

  it('rejects a missing action whose client sequence is not newer than server history', async () => {
    const result = await reconcileOfflineActions(
      { taskId: TASK_ID, actions: [probe] }, WORKER_ID,
      fixtureQuery({ stored: null, latest: probe.clientSequence }),
    );
    expect(result.actions[0]).toMatchObject({ syncState: 'CONFLICT', reasonCode: 'STALE_CLIENT_SEQUENCE' });
  });

  it('rejects a missing action created against a stale task version', async () => {
    const result = await reconcileOfflineActions(
      { taskId: TASK_ID, actions: [{ ...probe, priorServerVersion: 6 }] }, WORKER_ID,
      fixtureQuery({ stored: null, latest: 0 }),
    );
    expect(result.actions[0]).toMatchObject({ syncState: 'CONFLICT', reasonCode: 'STALE_TASK_VERSION' });
  });

  it('rejects completion proof when the lifecycle no longer accepts it', async () => {
    const result = await reconcileOfflineActions(
      { taskId: TASK_ID, actions: [probe] }, WORKER_ID,
      fixtureQuery({
        task: { id: TASK_ID, poster_id: POSTER_ID, worker_id: WORKER_ID, state: 'COMPLETED', progress_state: 'COMPLETED', version: 7 },
        stored: null,
      }),
    );
    expect(result.actions[0]).toMatchObject({
      syncState: 'SERVER_REJECTED', reasonCode: 'LIFECYCLE_NO_LONGER_ACCEPTS_ACTION',
      recoveryAction: 'START_NEW_ACTION', evidenceMatch: 'NOT_FOUND',
    });
  });

  it('keeps safety evidence locally pending regardless of lifecycle state', async () => {
    const safety = { ...probe, actionClass: 'SAFETY' as const, clientIdentity: '11111111-1111-4111-8111-111111111111' };
    const result = await reconcileOfflineActions(
      { taskId: TASK_ID, actions: [safety] }, POSTER_ID,
      fixtureQuery({
        task: { id: TASK_ID, poster_id: POSTER_ID, worker_id: WORKER_ID, state: 'COMPLETED', progress_state: 'COMPLETED', version: 7 },
        stored: null,
      }),
    );
    expect(result.actions[0]).toMatchObject({
      syncState: 'LOCAL_PENDING', reasonCode: 'NO_SERVER_RECORD', recoveryAction: 'RETRY_UNCHANGED',
    });
  });

  it('returns a current lifecycle result when no device actions exist', async () => {
    const result = await reconcileOfflineActions({ taskId: TASK_ID, actions: [] }, POSTER_ID, fixtureQuery());
    expect(result.actions).toEqual([]);
    expect(result.nextAction).toContain('submits proof');
  });

  it.each([
    ['absent task', fixtureQuery({ task: null }), WORKER_ID],
    ['nonparticipant', fixtureQuery(), OUTSIDER_ID],
  ])('hides the task from an %s', async (_label, query, userId) => {
    await expect(reconcileOfflineActions({ taskId: TASK_ID, actions: [probe] }, userId, query))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Task not found' });
  });
});
