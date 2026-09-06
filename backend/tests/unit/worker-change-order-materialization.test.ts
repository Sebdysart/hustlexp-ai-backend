import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/db.js';
import { PostgresUniversalV1WorkerChangeOrderMaterialization } from '../../src/services/UniversalV1WorkerChangeOrderMaterialization.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const manifest = 'sha256:' + 'b'.repeat(64);
const authority = {
  databaseName: 'hx_ci_test',
  serviceLogin: 'hx_ci_worker',
  environment: 'local' as const,
  manifestDigest: manifest,
  targetDigest: 'sha256:' + 'a'.repeat(64),
};
const command = {
  lease: {
    proposal_id: id(1),
    recovery_lease_id: id(2),
    lease_owner_id: id(3),
    witness_request_sha256: 'c'.repeat(64),
    work_order_id: id(4),
    acquired_at: '2026-09-06T05:00:00.000Z',
    expires_at: '2026-09-06T05:01:00.000Z',
    target_authority_id: id(5),
    release_manifest_digest: manifest,
  },
  adjustmentEventId: id(6),
  actorUserId: id(7),
  replacementScopeVersionId: id(8),
  replacementScopeVersion: 2,
};
const materialized = {
  amendment_id: id(9),
  amendment_version: 1,
  proposal_id: id(1),
  scope_version_id: id(8),
  scope_version: 2,
  adjustment_event_id: id(6),
  provider_kind: 'FAKE',
  replayed: false,
  payment_creation_performed: false,
  hard_assignment_created: false,
};
const workerOrigin = {
  amendment_id: id(9),
  execution_fact_id: id(10),
  proposal_id: id(1),
  recovery_lease_id: id(2),
  lease_owner_id: id(3),
  target_authority_id: id(5),
  release_environment: 'local',
  release_manifest_digest: manifest,
  service_database_role: 'hx_ci_worker',
  witness_request_sha256: 'c'.repeat(64),
  adjustment_event_id: id(6),
  recorded_at: '2026-09-06T05:00:01.123456+00:00',
};
const receipt = {
  result: materialized,
  worker_origin: workerOrigin,
  actor_user_id: id(7),
  observed_at: '2026-09-06T05:00:02.000Z',
  target_authority_id: id(5),
  release_manifest_digest: manifest,
};

function fixture(raw: unknown = structuredClone(receipt), authorize = () => authority) {
  const query = vi.fn(async (sql: string) => ({
    rowCount: 1,
    rows: [
      sql.includes('runtime_authority')
        ? {
            session_database_role: authority.serviceLogin,
            target_authority_id: id(5),
            target_database_name: authority.databaseName,
            environment: authority.environment,
            release_manifest_sha256: manifest,
          }
        : raw,
    ],
  }));
  const transaction = vi.fn(async (work: (query: unknown) => Promise<unknown>) => work(query));
  const database = { transaction } as unknown as Pick<Database, 'transaction'>;
  return {
    query,
    transaction,
    database,
    adapter: new PostgresUniversalV1WorkerChangeOrderMaterialization(database, authorize),
  };
}

describe('worker change order materialization adapter', () => {
  it('binds exact lease and ADJUST to one owned transaction and preserves immutable microsecond provenance', async () => {
    const f = fixture(),
      result = await f.adapter.materialize(command);
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(f.query).toHaveBeenLastCalledWith(
      'SELECT * FROM public.hxos_finalize_worker_change_order_v13($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        id(5),
        authority.databaseName,
        'local',
        manifest,
        id(1),
        id(2),
        id(3),
        'c'.repeat(64),
        id(4),
        id(6),
      ]
    );
    expect(result.result).toEqual(materialized);
    expect(result.workerOrigin).toEqual(workerOrigin);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.result)).toBe(true);
    expect(Object.isFrozen(result.workerOrigin)).toBe(true);
  });

  it.each([true, false])(
    'replays committed history after lease expiry with worker origin=%s',
    async (withOrigin) => {
      const raw = {
        ...structuredClone(receipt),
        result: { ...materialized, replayed: true },
        worker_origin: withOrigin ? workerOrigin : null,
        observed_at: '2026-09-07T05:00:00.000Z',
      };
      const f = fixture(raw),
        result = await f.adapter.materialize(command);
      expect(result.result.replayed).toBe(true);
      expect(result.workerOrigin).toEqual(raw.worker_origin);
    }
  );

  it('uses fresh target metadata while preserving the original worker provenance on replay', async () => {
    const f = fixture({
      ...structuredClone(receipt),
      result: { ...materialized, replayed: true },
      target_authority_id: id(11),
    });
    f.query.mockImplementation(async (sql: string) => ({
      rowCount: 1,
      rows: [
        sql.includes('runtime_authority')
          ? {
              session_database_role: authority.serviceLogin,
              target_authority_id: id(11),
              target_database_name: authority.databaseName,
              environment: 'local',
              release_manifest_sha256: manifest,
            }
          : {
              ...receipt,
              result: { ...materialized, replayed: true },
              target_authority_id: id(11),
            },
      ],
    }));
    const result = await f.adapter.materialize(command);
    expect(result.workerOrigin?.target_authority_id).toBe(id(5));
    expect(f.query.mock.calls[1]?.[0]).toContain('hxos_finalize_worker_change_order_v13');
  });

  it.each([
    [
      'wrong actor',
      (r: Record<string, any>) => {
        r.actor_user_id = id(20);
      },
    ],
    [
      'wrong scope',
      (r: Record<string, any>) => {
        r.result.scope_version_id = id(20);
      },
    ],
    [
      'wrong scope version',
      (r: Record<string, any>) => {
        r.result.scope_version = 3;
      },
    ],
    [
      'wrong ADJUST',
      (r: Record<string, any>) => {
        r.result.adjustment_event_id = id(20);
      },
    ],
    [
      'wrong proposal',
      (r: Record<string, any>) => {
        r.result.proposal_id = id(20);
      },
    ],
    [
      'payment effect',
      (r: Record<string, any>) => {
        r.result.payment_creation_performed = true;
      },
    ],
    [
      'hard assignment',
      (r: Record<string, any>) => {
        r.result.hard_assignment_created = true;
      },
    ],
    [
      'missing new origin',
      (r: Record<string, any>) => {
        r.worker_origin = null;
      },
    ],
    [
      'wrong origin amendment',
      (r: Record<string, any>) => {
        r.worker_origin.amendment_id = id(20);
      },
    ],
    [
      'wrong new origin lease',
      (r: Record<string, any>) => {
        r.worker_origin.recovery_lease_id = id(20);
      },
    ],
    [
      'wrong new worker',
      (r: Record<string, any>) => {
        r.worker_origin.service_database_role = 'another_worker';
      },
    ],
    [
      'new effect after expiry',
      (r: Record<string, any>) => {
        r.observed_at = '2026-09-06T05:01:01.000Z';
      },
    ],
    [
      'origin after observation',
      (r: Record<string, any>) => {
        r.worker_origin.recorded_at = '2026-09-06T05:00:03.000Z';
      },
    ],
    [
      'extra receipt field',
      (r: Record<string, any>) => {
        r.unverified = true;
      },
    ],
  ])('rejects %s before transaction completion', async (_label, mutate) => {
    const raw = structuredClone(receipt);
    mutate(raw);
    await expect(fixture(raw).adapter.materialize(command)).rejects.toThrow();
  });

  it('detects authority changes before commit', async () => {
    let calls = 0;
    const f = fixture(receipt, () =>
      ++calls === 1 ? authority : { ...authority, targetDigest: 'sha256:' + 'f'.repeat(64) }
    );
    await expect(f.adapter.materialize(command)).rejects.toThrow('AUTHORITY_CHANGED');
  });

  it('propagates uncertain commit acknowledgement and lets a fresh adapter recover the committed history', async () => {
    const f = fixture(),
      committed = vi.fn();
    const database = {
      transaction: async (work: Parameters<Database['transaction']>[0]) => {
        const result = await f.database.transaction(work);
        committed();
        throw Error('COMMIT_ACKNOWLEDGEMENT_LOST');
        return result;
      },
    } as Pick<Database, 'transaction'>;
    await expect(
      new PostgresUniversalV1WorkerChangeOrderMaterialization(
        database,
        () => authority
      ).materialize(command)
    ).rejects.toThrow('COMMIT_ACKNOWLEDGEMENT_LOST');
    expect(committed).toHaveBeenCalledTimes(1);
    const resumed = await fixture({
      ...receipt,
      result: { ...materialized, replayed: true },
    }).adapter.materialize(command);
    expect(resumed.workerOrigin).toEqual(workerOrigin);
  });
});
