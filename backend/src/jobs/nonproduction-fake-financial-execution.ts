import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { MigrationClient } from './engine-automation-migration.js';
import {
  assertSupplementalMigrationConnection,
  authorizeSupplementalMigrationConnection,
  completeSupplementalMigrationConnection,
  type MigrationExecutionAuthority,
  type SupplementalMigrationConnection,
} from './migration-execution-authority.js';

export const CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES = Object.freeze([
  {
    name: '20260827_fake_financial_provider_v1',
    fileName: '20260827_fake_financial_provider_v1.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v1',
  },
  {
    name: '20260903_fake_financial_provider_account_refresh_v2',
    fileName: '20260903_fake_financial_provider_account_refresh_v2.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v2',
  },
  {
    name: '20260910_fake_financial_settlement_completion_v3',
    fileName: '20260910_fake_financial_settlement_completion_v3.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v3',
  },
  {
    name: '20260921_universal_v1_fake_financial_lifecycle_bridge_v1',
    fileName: '20260921_universal_v1_fake_financial_lifecycle_bridge_v1.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v4',
  },
  {
    name: '20260922_universal_v1_fake_terminal_lifecycle_intent_v1',
    fileName: '20260922_universal_v1_fake_terminal_lifecycle_intent_v1.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v5',
  },
  {
    name: '20260926_universal_v1_change_order_three_phase_v1',
    fileName: '20260926_universal_v1_change_order_three_phase_v1.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v6',
  },
  {
    name: '20260927_universal_v1_change_order_recovery_v1',
    fileName: '20260927_universal_v1_change_order_recovery_v1.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v7',
  },
  {
    name: '20261002_universal_v1_dispute_fake_release_gate_v8',
    fileName: '20261002_universal_v1_dispute_fake_release_gate_v8.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v8',
  },
  {
    name: '20261010_universal_v1_fake_financial_expiry_v9',
    fileName: '20261010_universal_v1_fake_financial_expiry_v9.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v9',
  },
  {
    name: '20261011_universal_v1_fake_financial_expiry_recovery_v10',
    fileName: '20261011_universal_v1_fake_financial_expiry_recovery_v10.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v10',
  },
  {
    name: '20261013_nonproduction_runtime_insert_authority_v1',
    fileName: '20261013_nonproduction_runtime_insert_authority_v1.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v11',
  },
  {
    name: '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12',
    fileName: '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v12',
  },
  {
    name: '20261015_universal_v1_work_order_bootstrap_seal_v1',
    fileName: '20261015_universal_v1_work_order_bootstrap_seal_v1.sql',
    evidenceTable: 'hxos_work_order_bootstrap_seal_evidence_v1',
  },
  {
    name: '20261016_universal_v1_fake_financial_command_outbox_authority_v13',
    fileName: '20261016_universal_v1_fake_financial_command_outbox_authority_v13.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v13',
  },
] as const);

export interface FakeFinancialMigrationPlanEntry {
  name: string;
  evidenceTable: string;
  sql: string;
  sourcePath: string;
  sha256: string;
}

export interface FakeFinancialExecutionSession {
  membershipDigest: string;
  operationCount: number;
}

export interface FakeFinancialOperationPermit {
  operationIndex: number;
  membershipDigest: string;
}

export interface FakeFinancialExecutionReceipt {
  membershipDigest: string;
  operationCount: number;
  receiptDigest: string;
}

interface CanonicalFakeFinancialPermission {
  name: string;
  evidenceTable: string;
  sql: string;
  sha256: string;
  sourcePaths: readonly string[];
}

const AUTHORIZING_OPERATION = Symbol('authorizing-fake-financial-operation');

interface SessionBinding {
  client: MigrationClient;
  databaseUrl: string;
  connection: SupplementalMigrationConnection;
  entries: readonly Readonly<FakeFinancialMigrationPlanEntry>[];
  cursor: number;
  activePermit: FakeFinancialOperationPermit | typeof AUTHORIZING_OPERATION | null;
  completed: boolean;
}

interface PermitBinding {
  session: FakeFinancialExecutionSession;
  client: MigrationClient;
  databaseUrl: string;
  operationIndex: number;
}

const sessions = new WeakMap<object, SessionBinding>();
const permits = new WeakMap<object, PermitBinding>();
const receipts = new WeakMap<
  object,
  Readonly<{
    client: MigrationClient;
    databaseUrl: string;
  }>
>();
let moduleCanonicalArtifactBinding: readonly CanonicalFakeFinancialPermission[] | null = null;

function refuse(reason: string): never {
  throw new Error(`NONPRODUCTION_FAKE_FINANCIAL_EXECUTION_REFUSED:${reason}`);
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactSourcePath(value: string): string {
  const normalized = path.resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function canonicalSourcePaths(fileName: string): readonly string[] {
  return Object.freeze([
    ...new Set(
      [
        path.join(process.cwd(), 'backend/database/migrations', fileName),
        path.join('/app/backend/database/migrations', fileName),
      ].map(exactSourcePath)
    ),
  ]);
}

function moduleOwnedCanonicalArtifactBinding(): readonly CanonicalFakeFinancialPermission[] {
  if (moduleCanonicalArtifactBinding) return moduleCanonicalArtifactBinding;
  moduleCanonicalArtifactBinding = Object.freeze(
    CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.map((registration) => {
      const sourcePaths = canonicalSourcePaths(registration.fileName);
      let sql: string | null = null;
      for (const sourcePath of sourcePaths) {
        try {
          const candidate = readFileSync(sourcePath, 'utf8');
          if (candidate.trim()) {
            sql = candidate;
            break;
          }
        } catch {
          // Continue to the immutable image path.
        }
      }
      if (!sql) return refuse('CANONICAL_FAKE_FINANCIAL_ARTIFACT_UNAVAILABLE');
      return Object.freeze<CanonicalFakeFinancialPermission>({
        name: registration.name,
        evidenceTable: registration.evidenceTable,
        sql,
        sha256: digest(sql),
        sourcePaths,
      });
    })
  );
  return moduleCanonicalArtifactBinding;
}

export function canonicalFakeFinancialMigrationSha256(migrationName: string): string {
  const migration = moduleOwnedCanonicalArtifactBinding().find(
    (entry) => entry.name === migrationName
  );
  if (!migration) return refuse('CANONICAL_FAKE_FINANCIAL_MIGRATION_UNKNOWN');
  return migration.sha256;
}

function exactCanonicalEntries(
  entries: readonly FakeFinancialMigrationPlanEntry[]
): readonly Readonly<FakeFinancialMigrationPlanEntry>[] {
  const canonical = moduleOwnedCanonicalArtifactBinding();
  if (entries.length !== canonical.length) return refuse('EXACT_CANONICAL_MIGRATION_PLAN_REQUIRED');
  return Object.freeze(
    entries.map((entry, index) => {
      const expected = canonical[index];
      if (
        !expected ||
        entry.name !== expected.name ||
        entry.evidenceTable !== expected.evidenceTable ||
        entry.sql !== expected.sql ||
        entry.sha256 !== expected.sha256 ||
        !expected.sourcePaths.includes(exactSourcePath(entry.sourcePath))
      ) {
        return refuse('EXACT_CANONICAL_MIGRATION_PLAN_REQUIRED');
      }
      return Object.freeze({ ...entry });
    })
  );
}

export async function authorizeFakeFinancialExecutionSession(input: {
  authority: MigrationExecutionAuthority;
  databaseUrl: string;
  client: MigrationClient;
  entries: readonly FakeFinancialMigrationPlanEntry[];
}): Promise<{
  session: FakeFinancialExecutionSession;
  entries: readonly Readonly<FakeFinancialMigrationPlanEntry>[];
}> {
  if (!input.client || typeof input.client !== 'object') return refuse('CONNECTED_CLIENT_REQUIRED');
  const entries = exactCanonicalEntries(input.entries);
  const connection = await authorizeSupplementalMigrationConnection(input.authority, {
    scope: 'fake-financial-v1',
    databaseUrl: input.databaseUrl,
    client: input.client,
  });
  const membershipDigest = `sha256:${digest(
    JSON.stringify({
      connectionMembership: connection.membershipDigest,
      entries: entries.map(({ name, evidenceTable, sourcePath, sha256 }) => ({
        name,
        evidenceTable,
        sourcePath: exactSourcePath(sourcePath),
        sha256,
      })),
    })
  )}`;
  const session = Object.freeze<FakeFinancialExecutionSession>({
    membershipDigest,
    operationCount: entries.length,
  });
  sessions.set(session, {
    client: input.client,
    databaseUrl: input.databaseUrl,
    connection,
    entries,
    cursor: 0,
    activePermit: null,
    completed: false,
  });
  return { session, entries };
}

export async function beginFakeFinancialMigrationOperation(
  session: FakeFinancialExecutionSession,
  entry: Readonly<FakeFinancialMigrationPlanEntry>,
  client: MigrationClient,
  databaseUrl: string
): Promise<FakeFinancialOperationPermit> {
  const binding = sessions.get(session);
  if (!binding || binding.completed) return refuse('OPAQUE_EXECUTION_SESSION_REQUIRED');
  if (binding.client !== client) return refuse('CONNECTED_CLIENT_MISMATCH');
  if (binding.databaseUrl !== databaseUrl) return refuse('EXACT_DATABASE_URL_MISMATCH');
  if (binding.activePermit !== null) return refuse('MIGRATION_OPERATION_ALREADY_ACTIVE');
  if (!binding.entries[binding.cursor]) return refuse('MIGRATION_PLAN_ALREADY_COMPLETE');
  if (binding.entries[binding.cursor] !== entry) return refuse('MIGRATION_OPERATION_OUT_OF_ORDER');

  binding.activePermit = AUTHORIZING_OPERATION;
  try {
    await assertSupplementalMigrationConnection(binding.connection, client, databaseUrl);
    const permit = Object.freeze<FakeFinancialOperationPermit>({
      operationIndex: binding.cursor,
      membershipDigest: session.membershipDigest,
    });
    binding.activePermit = permit;
    permits.set(permit, {
      session,
      client,
      databaseUrl,
      operationIndex: binding.cursor,
    });
    return permit;
  } catch (error) {
    if (binding.activePermit === AUTHORIZING_OPERATION) binding.activePermit = null;
    throw error;
  }
}

function exactPermit(
  session: FakeFinancialExecutionSession,
  permit: FakeFinancialOperationPermit,
  client: MigrationClient,
  databaseUrl: string
): SessionBinding {
  const binding = sessions.get(session);
  const permitBinding = permits.get(permit);
  if (!binding || binding.completed || !permitBinding) {
    return refuse('OPAQUE_OPERATION_PERMIT_REQUIRED');
  }
  if (binding.client !== client || permitBinding.client !== client) {
    return refuse('CONNECTED_CLIENT_MISMATCH');
  }
  if (binding.databaseUrl !== databaseUrl || permitBinding.databaseUrl !== databaseUrl) {
    return refuse('EXACT_DATABASE_URL_MISMATCH');
  }
  if (
    permitBinding.session !== session ||
    permitBinding.operationIndex !== binding.cursor ||
    binding.activePermit !== permit
  ) {
    return refuse('MIGRATION_OPERATION_PERMIT_MISMATCH');
  }
  return binding;
}

export function completeFakeFinancialMigrationOperation(
  session: FakeFinancialExecutionSession,
  permit: FakeFinancialOperationPermit,
  client: MigrationClient,
  databaseUrl: string
): void {
  const binding = exactPermit(session, permit, client, databaseUrl);
  permits.delete(permit);
  binding.activePermit = null;
  binding.cursor += 1;
}

export function abortFakeFinancialMigrationOperation(
  session: FakeFinancialExecutionSession,
  permit: FakeFinancialOperationPermit,
  client: MigrationClient,
  databaseUrl: string
): void {
  const binding = exactPermit(session, permit, client, databaseUrl);
  permits.delete(permit);
  binding.activePermit = null;
}

export function completeFakeFinancialExecutionSession(
  session: FakeFinancialExecutionSession,
  client: MigrationClient,
  databaseUrl: string
): FakeFinancialExecutionReceipt {
  const binding = sessions.get(session);
  if (!binding || binding.completed) return refuse('OPAQUE_EXECUTION_SESSION_REQUIRED');
  if (binding.client !== client) return refuse('CONNECTED_CLIENT_MISMATCH');
  if (binding.databaseUrl !== databaseUrl) return refuse('EXACT_DATABASE_URL_MISMATCH');
  if (binding.activePermit !== null) return refuse('MIGRATION_OPERATION_ALREADY_ACTIVE');
  if (binding.cursor !== binding.entries.length) return refuse('MIGRATION_PLAN_INCOMPLETE');

  completeSupplementalMigrationConnection(binding.connection, client, databaseUrl);
  binding.completed = true;
  sessions.delete(session);
  const receiptDigest = `sha256:${digest(
    JSON.stringify({
      membershipDigest: session.membershipDigest,
      operationCount: binding.entries.length,
      databaseUrl: binding.databaseUrl,
    })
  )}`;
  const receipt = Object.freeze<FakeFinancialExecutionReceipt>({
    membershipDigest: session.membershipDigest,
    operationCount: binding.entries.length,
    receiptDigest,
  });
  receipts.set(
    receipt,
    Object.freeze({
      client: binding.client,
      databaseUrl: binding.databaseUrl,
    })
  );
  return receipt;
}

export function assertFakeFinancialExecutionReceipt(receipt: FakeFinancialExecutionReceipt): void {
  if (!receipts.has(receipt)) return refuse('OPAQUE_EXECUTION_RECEIPT_REQUIRED');
}
