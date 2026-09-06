import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { MigrationClient } from '../../src/jobs/engine-automation-migration.js';
import {
  abortFakeFinancialMigrationOperation,
  assertFakeFinancialExecutionReceipt,
  authorizeFakeFinancialExecutionSession,
  beginFakeFinancialMigrationOperation,
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES,
  canonicalFakeFinancialMigrationSha256,
  completeFakeFinancialExecutionSession,
  completeFakeFinancialMigrationOperation,
  type FakeFinancialExecutionReceipt,
  type FakeFinancialExecutionSession,
  type FakeFinancialMigrationPlanEntry,
  type FakeFinancialOperationPermit,
} from '../../src/jobs/nonproduction-fake-financial-execution.js';
import {
  assertIssuedMigrationExecutionAuthority,
  assertMigrationExecutionAuthorized,
} from '../../src/jobs/migration-execution-authority.js';

const DATABASE_URL = 'postgresql://hx_ci_runner@127.0.0.1:5432/hx_ci_system_test';
const ENV = {
  NODE_ENV: 'test',
  SERVICE_ROLE: 'migration',
  HX_ENVIRONMENT: 'local',
  HXOS_LOCAL_TEST_DATABASE_NAME: 'hx_ci_system_test',
  HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_ci_runner',
};

function digest(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function plan(): FakeFinancialMigrationPlanEntry[] {
  return CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.map((registration) => {
    const sql = readFileSync(
      new URL(`../../database/migrations/${registration.fileName}`, import.meta.url),
      'utf8',
    );
    return {
      name: registration.name,
      evidenceTable: registration.evidenceTable,
      sql,
      sourcePath: `/app/backend/database/migrations/${registration.fileName}`,
      sha256: digest(sql),
    };
  });
}

interface ClientState {
  backendPid: number;
  sessionMarker: string | null;
  identityRole: string;
  beforeMarkerRead?: () => Promise<void>;
}

function client(overrides: Partial<ClientState> = {}): MigrationClient & { state: ClientState } {
  const state: ClientState = {
    backendPid: 7123,
    sessionMarker: null,
    identityRole: 'hx_ci_runner',
    ...overrides,
  };
  return {
    state,
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('current_database()::text AS database_name')) {
        return {
          rows: [{
            database_name: 'hx_ci_system_test',
            role_name: state.identityRole,
            session_role_name: state.identityRole,
            server_address: '127.0.0.1',
            server_port: 5432,
            schema_name: 'public',
            search_path: 'public',
            effective_schemas: ['public'],
          }],
        };
      }
      if (sql.includes("set_config('hustlexp.supplemental_migration_session'")) {
        state.sessionMarker = String(values?.[0] ?? '');
        return {
          rows: [{ backend_pid: state.backendPid, session_marker: state.sessionMarker }],
        };
      }
      if (sql.includes("current_setting('hustlexp.supplemental_migration_session'")) {
        await state.beforeMarkerRead?.();
        return {
          rows: [{ backend_pid: state.backendPid, session_marker: state.sessionMarker }],
        };
      }
      return { rows: [] };
    }) as MigrationClient['query'],
  };
}

function authority() {
  return assertMigrationExecutionAuthorized({
    env: ENV,
    migrationArtifactDigest: 'a'.repeat(64),
    databaseUrl: DATABASE_URL,
  });
}

async function execution(migrationClient = client()) {
  const issuedAuthority = authority();
  return {
    authority: issuedAuthority,
    migrationClient,
    authorized: await authorizeFakeFinancialExecutionSession({
      authority: issuedAuthority,
      databaseUrl: DATABASE_URL,
      client: migrationClient,
      entries: plan(),
    }),
  };
}

describe('opaque fake-financial execution session', () => {
  it('pins v13 after the ordered v1-v12-plus-seal chain and its exact artifact digest', () => {
    expect(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES).toHaveLength(14);
    expect(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.at(-3)).toEqual({
      name: '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12',
      fileName: '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12.sql',
      evidenceTable: 'hxos_fake_financial_schema_evidence_v12',
    });
    expect(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.at(-2)).toEqual({
      name: '20261015_universal_v1_work_order_bootstrap_seal_v1',
      fileName: '20261015_universal_v1_work_order_bootstrap_seal_v1.sql',
      evidenceTable: 'hxos_work_order_bootstrap_seal_evidence_v1',
    });
    const hardenedTail = CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.at(-1)!;
    expect(hardenedTail).toEqual({
      name: '20261016_universal_v1_fake_financial_command_outbox_authority_v13',
      fileName: '20261016_universal_v1_fake_financial_command_outbox_authority_v13.sql',
      evidenceTable: 'hxos_fake_financial_schema_evidence_v13',
    });
    expect(plan().at(-1)?.sha256).toBe(
      canonicalFakeFinancialMigrationSha256(hardenedTail.name),
    );
  });

  it('rejects arbitrary self-hashed SQL and every canonical binding substitution before DB access', async () => {
    for (const substitute of [
      (entries: FakeFinancialMigrationPlanEntry[]) => {
        entries[0] = { ...entries[0]!, sql: 'SELECT arbitrary_fake_finance;', sha256: digest('SELECT arbitrary_fake_finance;') };
      },
      (entries: FakeFinancialMigrationPlanEntry[]) => {
        entries[0] = { ...entries[0]!, evidenceTable: 'attacker_evidence' };
      },
      (entries: FakeFinancialMigrationPlanEntry[]) => {
        entries[0] = { ...entries[0]!, sourcePath: '/tmp/canonical-name.sql' };
      },
      (entries: FakeFinancialMigrationPlanEntry[]) => {
        entries.reverse();
      },
      (entries: FakeFinancialMigrationPlanEntry[]) => {
        entries.pop();
      },
    ]) {
      const entries = plan();
      substitute(entries);
      const migrationClient = client();
      const issuedAuthority = authority();
      await expect(authorizeFakeFinancialExecutionSession({
        authority: issuedAuthority,
        databaseUrl: DATABASE_URL,
        client: migrationClient,
        entries,
      })).rejects.toThrow('EXACT_CANONICAL_MIGRATION_PLAN_REQUIRED');
      expect(migrationClient.query).not.toHaveBeenCalled();
      expect(() => assertIssuedMigrationExecutionAuthority(issuedAuthority)).not.toThrow();
    }
  });

  it('consumes its opaque migration-authority bearer exactly once', async () => {
    const { authority: consumed } = await execution();
    expect(() => assertIssuedMigrationExecutionAuthority(consumed)).toThrow(
      'MIGRATION_EXECUTION_REFUSED:OPAQUE_AUTHORITY_TOKEN_REQUIRED',
    );
  });

  it('uses the authority-owned hidden target and refuses a live identity substitution', async () => {
    const migrationClient = client({ identityRole: 'substituted_role' });
    await expect(authorizeFakeFinancialExecutionSession({
      authority: authority(),
      databaseUrl: DATABASE_URL,
      client: migrationClient,
      entries: plan(),
    })).rejects.toThrow('NONPRODUCTION_DATABASE_TARGET_REFUSED:LIVE_DATABASE_ROLE_MISMATCH');
  });

  it('enforces order, exact client and URL, retry-current, replay refusal, and one-time completion', async () => {
    const { migrationClient, authorized } = await execution();
    const [first, second] = authorized.entries;

    await expect(beginFakeFinancialMigrationOperation(
      authorized.session,
      second!,
      migrationClient,
      DATABASE_URL,
    )).rejects.toThrow('MIGRATION_OPERATION_OUT_OF_ORDER');
    await expect(beginFakeFinancialMigrationOperation(
      authorized.session,
      first!,
      client(),
      DATABASE_URL,
    )).rejects.toThrow('CONNECTED_CLIENT_MISMATCH');
    await expect(beginFakeFinancialMigrationOperation(
      authorized.session,
      first!,
      migrationClient,
      `${DATABASE_URL}_substituted`,
    )).rejects.toThrow('EXACT_DATABASE_URL_MISMATCH');

    const failedAttempt = await beginFakeFinancialMigrationOperation(
      authorized.session,
      first!,
      migrationClient,
      DATABASE_URL,
    );
    abortFakeFinancialMigrationOperation(
      authorized.session,
      failedAttempt,
      migrationClient,
      DATABASE_URL,
    );
    const retry = await beginFakeFinancialMigrationOperation(
      authorized.session,
      first!,
      migrationClient,
      DATABASE_URL,
    );
    completeFakeFinancialMigrationOperation(
      authorized.session,
      retry,
      migrationClient,
      DATABASE_URL,
    );
    await expect(beginFakeFinancialMigrationOperation(
      authorized.session,
      first!,
      migrationClient,
      DATABASE_URL,
    )).rejects.toThrow('MIGRATION_OPERATION_OUT_OF_ORDER');

    for (const entry of authorized.entries.slice(1)) {
      const permit = await beginFakeFinancialMigrationOperation(
        authorized.session,
        entry,
        migrationClient,
        DATABASE_URL,
      );
      completeFakeFinancialMigrationOperation(
        authorized.session,
        permit,
        migrationClient,
        DATABASE_URL,
      );
    }
    const receipt = completeFakeFinancialExecutionSession(
      authorized.session,
      migrationClient,
      DATABASE_URL,
    );
    expect(() => assertFakeFinancialExecutionReceipt(receipt)).not.toThrow();
    expect(() => completeFakeFinancialExecutionSession(
      authorized.session,
      migrationClient,
      DATABASE_URL,
    )).toThrow('OPAQUE_EXECUTION_SESSION_REQUIRED');
  });

  it('pins the backend PID and private connection marker across every operation', async () => {
    const { migrationClient, authorized } = await execution();
    migrationClient.state.backendPid += 1;
    await expect(beginFakeFinancialMigrationOperation(
      authorized.session,
      authorized.entries[0]!,
      migrationClient,
      DATABASE_URL,
    )).rejects.toThrow('MIGRATION_EXECUTION_REFUSED:CONNECTED_MIGRATION_SESSION_CHANGED');
    migrationClient.state.backendPid -= 1;
    migrationClient.state.sessionMarker = 'substituted-marker';
    await expect(beginFakeFinancialMigrationOperation(
      authorized.session,
      authorized.entries[0]!,
      migrationClient,
      DATABASE_URL,
    )).rejects.toThrow('MIGRATION_EXECUTION_REFUSED:LIVE_CONNECTION_MARKER_MISMATCH');
  });

  it('reserves begin synchronously so concurrent calls cannot issue duplicate permits', async () => {
    let releaseReadback!: () => void;
    const readbackGate = new Promise<void>((resolve) => { releaseReadback = resolve; });
    let readbackStarted!: () => void;
    const started = new Promise<void>((resolve) => { readbackStarted = resolve; });
    const migrationClient = client({
      beforeMarkerRead: async () => {
        readbackStarted();
        await readbackGate;
      },
    });
    const { authorized } = await execution(migrationClient);
    const firstBegin = beginFakeFinancialMigrationOperation(
      authorized.session,
      authorized.entries[0]!,
      migrationClient,
      DATABASE_URL,
    );
    await started;
    await expect(beginFakeFinancialMigrationOperation(
      authorized.session,
      authorized.entries[0]!,
      migrationClient,
      DATABASE_URL,
    )).rejects.toThrow('MIGRATION_OPERATION_ALREADY_ACTIVE');
    releaseReadback();
    const permit = await firstBegin;
    abortFakeFinancialMigrationOperation(
      authorized.session,
      permit,
      migrationClient,
      DATABASE_URL,
    );
  });

  it('rejects subset completion, forged sessions, permits, and receipts', async () => {
    const { migrationClient, authorized } = await execution();
    expect(() => completeFakeFinancialExecutionSession(
      authorized.session,
      migrationClient,
      DATABASE_URL,
    )).toThrow('MIGRATION_PLAN_INCOMPLETE');

    const permit = await beginFakeFinancialMigrationOperation(
      authorized.session,
      authorized.entries[0]!,
      migrationClient,
      DATABASE_URL,
    );
    expect(() => completeFakeFinancialMigrationOperation(
      authorized.session,
      { ...permit } as FakeFinancialOperationPermit,
      migrationClient,
      DATABASE_URL,
    )).toThrow('OPAQUE_OPERATION_PERMIT_REQUIRED');
    abortFakeFinancialMigrationOperation(
      authorized.session,
      permit,
      migrationClient,
      DATABASE_URL,
    );

    await expect(beginFakeFinancialMigrationOperation(
      { ...authorized.session } as FakeFinancialExecutionSession,
      authorized.entries[0]!,
      migrationClient,
      DATABASE_URL,
    )).rejects.toThrow('OPAQUE_EXECUTION_SESSION_REQUIRED');
    expect(() => assertFakeFinancialExecutionReceipt({
      membershipDigest: authorized.session.membershipDigest,
      operationCount: authorized.session.operationCount,
      receiptDigest: `sha256:${'0'.repeat(64)}`,
    } as FakeFinancialExecutionReceipt)).toThrow('OPAQUE_EXECUTION_RECEIPT_REQUIRED');
  });
});
