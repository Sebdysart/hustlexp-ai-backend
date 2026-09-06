import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryFn } from '../../src/database-contracts.js';
import { readNonproductionFinancialBootstrapReadiness } from '../../src/services/payment/NonproductionFinancialBootstrapReadiness.js';
import {
  createFinancialReadinessDatabase,
  financialReadinessSnapshot,
  type FinancialReadinessDatabase,
} from '../helpers/universal-v1-financial-readiness-database.js';

const describePg = describe.skipIf(!process.env.DATABASE_URL).sequential;
describePg('nonproduction financial bootstrap PostgreSQL authority policy', () => {
  let context: FinancialReadinessDatabase;
  beforeAll(async () => {
    context = await createFinancialReadinessDatabase();
  }, 120_000);
  afterAll(async () => {
    await context?.close();
  }, 30_000);

  function readinessOptions() {
    return {
      environment: 'local',
      component: 'backend' as const,
      env: {
        ...context.environment,
        HX_ENVIRONMENT: 'local',
        NODE_ENV: 'test',
        HX_PAYMENT_CREATION_MODE: 'frozen',
        HX_RUNTIME_DATABASE_NAME: new URL(context.fixture.databaseUrl).pathname.slice(1),
      },
      release: context.authority.release,
      identity: context.authority.identity,
    };
  }

  it('rejects the overprivileged runner in an exact snapshot with configured API authority', async () => {
    const client = await context.fixture.pool.connect();
    try {
      const result = await readNonproductionFinancialBootstrapReadiness({
        ...readinessOptions(),
        database: financialReadinessSnapshot(client),
      });
      expect(result).toMatchObject({
        required: true,
        ready: false,
        status: 'database_authority_violation',
        environment: 'local',
        releaseId: context.authority.manifest.releaseId,
      });
    } finally {
      client.release();
    }
  });

  it('returns the distinct fail-closed status before schema or ACL attestation on identity drift', async () => {
    const base = financialReadinessSnapshot(context.clients.get('apiRole')!);
    let semanticCatalogQueries = 0;
    let authorityQueries = 0;
    const database = {
      readOnlyAttestationTransaction: <T>(fn: (query: QueryFn) => Promise<T>) =>
        base.readOnlyAttestationTransaction((query) =>
          fn(async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
            const result = await query<R>(sql, params);
            if (sql.includes('identity_documents')) semanticCatalogQueries += 1;
            if (sql.includes('runtime_authority_v13') || sql.includes('violations(violation_code)'))
              authorityQueries += 1;
            if (!sql.includes('hxos_nonproduction_database_identity_v1')) return result;
            return {
              rows: result.rows.map((row) => ({ ...row, allows_connections: false })) as R[],
              rowCount: result.rowCount,
            };
          })
        ),
    };
    const result = await readNonproductionFinancialBootstrapReadiness({
      ...readinessOptions(),
      database,
    });
    expect(result).toMatchObject({
      required: true,
      ready: false,
      status: 'database_identity_mismatch',
      releaseId: context.authority.manifest.releaseId,
    });
    expect(semanticCatalogQueries).toBe(0);
    expect(authorityQueries).toBe(0);
  });

  it('executes real restricted authority and all identity SQL, rejecting incorrect schema evidence', async () => {
    const base = financialReadinessSnapshot(context.clients.get('apiRole')!);
    const captured: Array<{ identity_name: string; identity_sha256: string }> = [];
    const violations: unknown[] = [];
    let postgreSqlMajorIdentityExecutions = 0;
    let databaseIdentityExecutions = 0;
    let custodyExecutions = 0;
    const database = {
      readOnlyAttestationTransaction: <T>(fn: (query: QueryFn) => Promise<T>) =>
        base.readOnlyAttestationTransaction((query) =>
          fn(async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
            const result = await query<R>(sql, params);
            if (sql.includes('financial_readiness_custody_v13')) {
              custodyExecutions += 1;
              violations.push(...result.rows);
            }
            if (sql.includes('hxos_nonproduction_postgresql_major_v1'))
              postgreSqlMajorIdentityExecutions += 1;
            if (sql.includes('hxos_nonproduction_database_identity_v1'))
              databaseIdentityExecutions += 1;
            if (sql.includes('identity_documents'))
              captured.push(
                ...(result.rows as Array<{ identity_name: string; identity_sha256: string }>)
              );
            // Observe actual database results without suppressing authorization findings.
            return result;
          })
        ),
    };
    const placeholderEvidence = [
      'relations',
      'constraints',
      'indexes',
      'functions',
      'triggers',
      'rewrite_rules',
      'constraint_triggers',
      'policies',
      'extensions',
    ].map((identityName, index) => ({ identityName, sha256: String(index + 1).repeat(64) }));
    const discovery = await readNonproductionFinancialBootstrapReadiness({
      ...readinessOptions(),
      database,
      expectedCriticalSchemaEvidence: placeholderEvidence,
    });
    expect(discovery).toMatchObject({ ready: false, status: 'schema_evidence_mismatch' });
    expect(postgreSqlMajorIdentityExecutions).toBe(1);
    expect(databaseIdentityExecutions).toBe(1);
    expect(custodyExecutions).toBe(1);
    expect(violations).toEqual([]);
    expect(captured).toHaveLength(9);
    expect(captured.every(({ identity_sha256 }) => /^[a-f0-9]{64}$/u.test(identity_sha256))).toBe(
      true
    );
    const exactEvidence = placeholderEvidence.map(({ identityName }) => {
      const entry = captured.find(({ identity_name }) => identity_name === identityName);
      expect(entry).toBeDefined();
      return { identityName, sha256: entry?.identity_sha256 ?? '' };
    });
    const exact = await readNonproductionFinancialBootstrapReadiness({
      ...readinessOptions(),
      database,
      expectedCriticalSchemaEvidence: exactEvidence,
    });
    expect(exact).toMatchObject({ ready: true, status: 'ready' });
    expect(postgreSqlMajorIdentityExecutions).toBe(2);
    expect(databaseIdentityExecutions).toBe(2);
    expect(custodyExecutions).toBe(2);
    expect(violations).toEqual([]);
  });
});
