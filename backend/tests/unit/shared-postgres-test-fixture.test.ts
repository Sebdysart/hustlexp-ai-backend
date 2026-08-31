import { beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

const identityProvider = vi.hoisted(() => {
  const caseId = '44444444-4444-4444-8444-444444444444';
  return {
    caseId,
    prepare: vi.fn(async () => ({
      success: true as const,
      data: {
        caseId,
        status: 'PENDING' as const,
        provider: 'local_certification_identity' as const,
        environment: 'CONTROLLED_TEST' as const,
        isTest: true as const,
        idempotencyReplayed: false,
      },
    })),
    completeVerified: vi.fn(async () => ({
      success: true as const,
      data: {
        caseId,
        status: 'VERIFIED' as const,
        provider: 'local_certification_identity' as const,
        environment: 'CONTROLLED_TEST' as const,
        isTest: true as const,
        idempotencyReplayed: false,
      },
    })),
  };
});

vi.mock('../../src/services/LocalCertificationIdentityProvider.js', () => ({
  LocalCertificationIdentityProvider: {
    prepare: identityProvider.prepare,
    completeVerified: identityProvider.completeVerified,
  },
}));

import { createTestTask, createTestUser, promoteTestUserTrustSequentially } from '../setup.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const APPROVAL_ID = '33333333-3333-4333-8333-333333333333';
const WORKER_ID = '55555555-5555-4555-8555-555555555555';

function taskPool() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('activate_region_policy_with_legal_approval')) {
      return { rows: [{ approval_id: APPROVAL_ID }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO tasks')) {
      return { rows: [{ id: TASK_ID }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO users')) {
      return { rows: [{ id: USER_ID }], rowCount: 1 };
    }
    if (sql.includes('begin_identity_verification_case_v1')) {
      return {
        rows: [{ case_status: 'VERIFIED', identity_verified: true }],
        rowCount: 1,
      };
    }
    if (sql.includes('identity_verification_is_current_v1')) {
      return { rows: [{ is_current: true }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  return { pool: { query } as unknown as pg.Pool, query };
}

describe('shared PostgreSQL fixture contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an explicit adult ACTIVE user without forging identity verification', async () => {
    const { pool, query } = taskPool();
    await expect(createTestUser(pool)).resolves.toEqual({ id: USER_ID });

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('date_of_birth, is_minor, account_status');
    expect(sql).toContain("DATE '1990-01-01', FALSE, 'ACTIVE'");
    expect(sql).not.toContain('is_verified');
  });

  it('defaults to a controlled task without creating or binding production liquidity', async () => {
    const { pool, query } = taskPool();
    await createTestTask(pool, { posterId: USER_ID });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(query).toHaveBeenCalledOnce();
    expect(sql).toContain("WHERE $8 = 'PRODUCTION'");
    expect(sql).toContain("SELECT NULL::uuid, 'unmapped' WHERE $8 = 'CONTROLLED_TEST'");
    expect(values[7]).toBe('CONTROLLED_TEST');
    expect(values[8]).toBe('US-WA');
  });

  it('attests assigned controlled-test workers through the local provider service', async () => {
    const { pool, query } = taskPool();
    await createTestTask(pool, {
      posterId: USER_ID,
      workerId: WORKER_ID,
      state: 'COMPLETED',
    });

    expect(identityProvider.prepare).toHaveBeenCalledWith({
      userId: WORKER_ID,
      idempotencyKey: `fixture-identity-${WORKER_ID.replaceAll('-', '')}`,
    });
    expect(identityProvider.completeVerified).toHaveBeenCalledWith({
      userId: WORKER_ID,
      caseId: identityProvider.caseId,
      actorId: WORKER_ID,
      idempotencyKey: `fixture-identity-${WORKER_ID.replaceAll('-', '')}-verified`,
    });
    const current = query.mock.calls.find(([sql]) =>
      sql.includes('identity_verification_is_current_v1')
    ) as [string, unknown[]] | undefined;
    expect(current?.[1]).toEqual([WORKER_ID, 'CONTROLLED_TEST']);
    expect(query.mock.calls.some(([sql]) => /SET[\s\S]*is_verified\s*=/iu.test(sql))).toBe(false);
  });

  it('requires a governed isolated policy before seeding production-shaped cells', async () => {
    const { pool, query } = taskPool();
    await createTestTask(pool, {
      posterId: USER_ID,
      workerId: WORKER_ID,
      state: 'COMPLETED',
      automationClassification: 'PRODUCTION',
      productionPolicyFixture: 'GOVERNED_ISOLATED',
    });

    const calls = query.mock.calls as Array<[string, unknown[] | undefined]>;
    const activation = calls.find(([sql]) =>
      sql.includes('activate_region_policy_with_legal_approval')
    );
    const taskInsert = calls.find(([sql]) => sql.includes('INSERT INTO tasks'));
    const identityAttestation = calls.find(([sql]) =>
      sql.includes('begin_identity_verification_case_v1')
    );
    const currentIdentity = calls.find(([sql]) =>
      sql.includes('identity_verification_is_current_v1')
    );

    expect(activation?.[0]).toContain('Synthetic CI counsel field - not legal approval');
    expect(activation?.[0]).toContain('not-production-authority');
    expect(activation?.[1]).toEqual(['US-ZX', 'hx-ci-governed-production-shape-v1', USER_ID]);
    expect(calls.some(([sql]) => /UPDATE\s+region_policies\s+SET/i.test(sql))).toBe(false);
    expect(identityAttestation?.[0]).toContain('record_identity_verification_event_v1');
    expect(identityAttestation?.[0]).toContain("'PRODUCTION', FALSE");
    expect(identityAttestation?.[0]).toContain('isolated CI only');
    expect(identityAttestation?.[1]).toEqual([
      WORKER_ID,
      'hx_ci_attested_identity_fixture',
      'hx-ci-attested-production-identity-v1',
      `fixture-production-identity-consent:${WORKER_ID}`,
      `idv_hx_ci_attested_${WORKER_ID.replaceAll('-', '')}`,
      `fixture-production-identity-verified:${WORKER_ID}`,
    ]);
    expect(currentIdentity?.[1]).toEqual([WORKER_ID, 'PRODUCTION']);
    expect(identityProvider.prepare).not.toHaveBeenCalled();
    expect(identityProvider.completeVerified).not.toHaveBeenCalled();

    expect(taskInsert).toBeDefined();
    const [sql, values] = taskInsert!;
    expect(sql).toContain('minimum_provider_net_hourly_cents');
    expect(sql).toContain("'hxos-provider-economics-approved-test-v1'");
    expect(sql).toContain("'APPROVED'");
    expect(sql).toContain("'local-shared-pg-fixture-only'");
    expect(sql).toContain("environment = 'PRODUCTION', is_test = FALSE");
    expect(values[7]).toBe('PRODUCTION');
    expect(values[8]).toBe('US-ZX');
  });

  it('rejects production classification without the explicit governed fixture', async () => {
    const { pool, query } = taskPool();
    await expect(
      createTestTask(pool, {
        posterId: USER_ID,
        automationClassification: 'PRODUCTION',
      })
    ).rejects.toThrow(
      'PRODUCTION test tasks require the explicit GOVERNED_ISOLATED policy fixture'
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects the governed fixture marker on a controlled task', async () => {
    const { pool, query } = taskPool();
    await expect(
      createTestTask(pool, {
        posterId: USER_ID,
        productionPolicyFixture: 'GOVERNED_ISOLATED',
      })
    ).rejects.toThrow(
      'PRODUCTION test tasks require the explicit GOVERNED_ISOLATED policy fixture'
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('promotes through every trust tier under one transaction-local authority', async () => {
    const commands: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        commands.push({ sql, values });
        if (sql.startsWith('SELECT trust_tier')) {
          return { rows: [{ trust_tier: 1 }], rowCount: 1 };
        }
        if (sql.includes('UPDATE users')) {
          return { rows: [{ trust_tier: values?.[1] }], rowCount: 1 };
        }
        return { rows: [], rowCount: null };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as pg.Pool;

    await promoteTestUserTrustSequentially(pool, USER_ID, 4);

    expect(commands[0]?.sql).toBe('BEGIN');
    expect(commands[1]?.sql).toContain('FOR UPDATE');
    expect(commands[2]?.sql).toContain("'hustlexp.trust_promotion_authority'");
    expect(commands[2]?.values?.[0]).toMatch(/^hustler-trust-progression-v1:[0-9a-f-]{36}$/);
    const promotions = commands.filter(({ sql }) => sql.includes('UPDATE users'));
    expect(promotions.map(({ values }) => values?.slice(1))).toEqual([
      [2, 1],
      [3, 2],
      [4, 3],
    ]);
    expect(commands.at(-1)?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rolls back when a sequential trust promotion loses its exact precondition', async () => {
    const commands: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        commands.push(sql);
        if (sql.startsWith('SELECT trust_tier')) {
          return { rows: [{ trust_tier: 1 }], rowCount: 1 };
        }
        if (sql.includes('UPDATE users')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: null };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as pg.Pool;

    await expect(promoteTestUserTrustSequentially(pool, USER_ID, 2)).rejects.toThrow(
      'Concurrent test trust promotion detected'
    );
    expect(commands).toContain('ROLLBACK');
    expect(commands).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });
});
