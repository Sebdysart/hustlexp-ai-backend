import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_CHECKSUM_APPLY_FLAG,
  LEGACY_CHECKSUM_RECONCILIATION_SCHEMA,
  LEGACY_CHECKSUM_SIGNATURE_SCHEMA,
  calculatePayloadSha256,
  calculateTargetFingerprint,
  parseReconciliationManifest,
  runLegacyMigrationChecksumReconciliation,
  signatureStatement,
  type ReconciliationClient,
  type ReconciliationMigration,
  type ReconciliationPayload,
  type ReconciliationQueryResult,
  type ReconciliationRuntime,
  type ReconciliationSignatureEvidence,
  type ReconciliationTargetIdentity,
} from '../../src/jobs/legacy-migration-checksum-reconciliation.js';

const REPOSITORY_ROOT = path.resolve('C:/hustlexp-checksum-reconciliation-test');
const MANIFEST_PATH = path.resolve(
  REPOSITORY_ROOT,
  'backend/database/migration-checksum-manifests/reviewed.json'
);
const SQL_A = 'SELECT 1;\n';
const SQL_B = 'SELECT 2;\n';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const TARGET_IDENTITY: ReconciliationTargetIdentity = {
  databaseName: 'hx_ci_system_test',
  roleName: 'hx_ci_runner',
  serverAddress: '127.0.0.1',
  serverPort: 5432,
  serverVersionNum: '160015',
  clusterName: 'hustlexp-disposable-ci',
};

type LedgerFixture = { name: string; sha256: string | null };

class FakeReconciliationClient implements ReconciliationClient {
  readonly commands: Array<{ sql: string; values?: unknown[] }> = [];
  connectCount = 0;
  endCount = 0;
  ledger: LedgerFixture[];
  failUpdateName?: string;
  private transactionSnapshot?: LedgerFixture[];

  constructor(
    readonly identity: ReconciliationTargetIdentity,
    ledger: LedgerFixture[]
  ) {
    this.ledger = ledger.map((row) => ({ ...row }));
  }

  async connect(): Promise<void> {
    this.connectCount += 1;
  }

  async end(): Promise<void> {
    this.endCount += 1;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<ReconciliationQueryResult<Row>> {
    this.commands.push({ sql, values });
    if (sql.includes('current_database()')) {
      return this.rows<Row>([
        {
          database_name: this.identity.databaseName,
          role_name: this.identity.roleName,
          server_address: this.identity.serverAddress,
          server_port: this.identity.serverPort,
          server_version_num: this.identity.serverVersionNum,
          cluster_name: this.identity.clusterName,
        },
      ]);
    }
    if (sql.startsWith('BEGIN ')) {
      this.transactionSnapshot = this.ledger.map((row) => ({ ...row }));
      return this.rows<Row>([]);
    }
    if (sql.includes('pg_advisory_xact_lock')) return this.rows<Row>([]);
    if (sql === 'SELECT name, sha256 FROM applied_migrations ORDER BY name') {
      return this.rows<Row>(
        [...this.ledger]
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((row) => ({ ...row }))
      );
    }
    if (sql.includes('UPDATE applied_migrations')) {
      const [name, checksum] = values as [string, string];
      if (name === this.failUpdateName) throw new Error(`injected update failure for ${name}`);
      const row = this.ledger.find((candidate) => candidate.name === name);
      if (!row || row.sha256 !== null) return this.rows<Row>([]);
      row.sha256 = checksum;
      return this.rows<Row>([{ name, sha256: checksum }]);
    }
    if (sql === 'COMMIT') {
      this.transactionSnapshot = undefined;
      return this.rows<Row>([]);
    }
    if (sql === 'ROLLBACK') {
      if (this.transactionSnapshot) {
        this.ledger = this.transactionSnapshot.map((row) => ({ ...row }));
      }
      this.transactionSnapshot = undefined;
      return this.rows<Row>([]);
    }
    throw new Error(`Unexpected SQL in fake reconciliation client: ${sql}`);
  }

  private rows<Row extends Record<string, unknown>>(
    rows: Array<Record<string, unknown>>
  ): ReconciliationQueryResult<Row> {
    return { rows: rows as Row[] };
  }
}

type FixtureOptions = {
  states?: [
    ReconciliationMigration['expectedLedgerState'],
    ReconciliationMigration['expectedLedgerState'],
  ];
  preparedBy?: string;
  reviewedBy?: string;
  target?: ReconciliationTargetIdentity;
  tamperSignature?: boolean;
  databaseUrl?: string;
};

function buildFixture(options: FixtureOptions = {}): {
  runtime: ReconciliationRuntime;
  client: FakeReconciliationClient;
  manifestText: string;
  evidenceText: string;
  files: Map<string, string>;
  environment: Record<string, string>;
  migrations: ReconciliationMigration[];
} {
  const targetIdentity = options.target ?? TARGET_IDENTITY;
  const states = options.states ?? ['NULL_CHECKSUM', 'NULL_CHECKSUM'];
  const migrations: ReconciliationMigration[] = [
    {
      name: 'migration_a',
      sourcePath: 'backend/database/migrations/migration_a.sql',
      sha256: hash(SQL_A),
      expectedLedgerState: states[0],
    },
    {
      name: 'migration_b',
      sourcePath: 'backend/database/migrations/migration_b.sql',
      sha256: hash(SQL_B),
      expectedLedgerState: states[1],
    },
  ];
  const payload: ReconciliationPayload = {
    sourceCommitSha: '1234567890abcdef1234567890abcdef12345678',
    preparedBy: options.preparedBy ?? 'operator:preparer@example.test',
    reviewedBy: options.reviewedBy ?? 'operator:reviewer@example.test',
    preparedAt: '2026-08-26T10:00:00.000Z',
    reviewedAt: '2026-08-26T11:00:00.000Z',
    target: {
      environmentId: 'disposable-ci',
      ...targetIdentity,
      fingerprint: calculateTargetFingerprint(targetIdentity),
    },
    migrations,
  };
  const payloadSha256 = calculatePayloadSha256(payload);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const publicKeySha256 = hash(publicKeyPem);
  const unsignedEvidence: Omit<ReconciliationSignatureEvidence, 'signatureBase64'> = {
    schemaVersion: LEGACY_CHECKSUM_SIGNATURE_SCHEMA,
    algorithm: 'ed25519',
    payloadSha256,
    signerIdentity: payload.reviewedBy,
    reviewedCommitSha: payload.sourceCommitSha,
    publicKeyPem,
    publicKeySha256,
  };
  const exactSignature = sign(
    null,
    Buffer.from(signatureStatement(unsignedEvidence), 'utf8'),
    privateKey
  );
  if (options.tamperSignature) exactSignature[0] = exactSignature[0] ^ 1;
  const evidence: ReconciliationSignatureEvidence = {
    ...unsignedEvidence,
    signatureBase64: exactSignature.toString('base64'),
  };
  const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidencePath = 'backend/database/migration-checksum-signatures/reviewed-signature.json';
  const manifest = {
    schemaVersion: LEGACY_CHECKSUM_RECONCILIATION_SCHEMA,
    status: 'AUTHORIZED' as const,
    payload,
    authorization: {
      payloadSha256,
      signatureEvidencePath: evidencePath,
      signatureEvidenceSha256: hash(evidenceText),
      signerPublicKeySha256: publicKeySha256,
    },
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const environment: Record<string, string> = {
    NODE_ENV: 'maintenance',
    HX_ALLOW_LEGACY_MIGRATION_CHECKSUM_RECONCILIATION: LEGACY_CHECKSUM_APPLY_FLAG,
    HX_LEGACY_MIGRATION_CHECKSUM_MANIFEST_SHA256: hash(manifestText),
    HX_LEGACY_MIGRATION_CHECKSUM_SIGNATURE_SHA256: hash(evidenceText),
    HX_LEGACY_MIGRATION_CHECKSUM_SIGNER_KEY_SHA256: publicKeySha256,
  };
  const files = new Map<string, string>([
    [MANIFEST_PATH, manifestText],
    [path.resolve(REPOSITORY_ROOT, migrations[0].sourcePath), SQL_A],
    [path.resolve(REPOSITORY_ROOT, migrations[1].sourcePath), SQL_B],
    [path.resolve(REPOSITORY_ROOT, evidencePath), evidenceText],
  ]);
  const initialLedger = migrations.map((migration) => ({
    name: migration.name,
    sha256: migration.expectedLedgerState === 'NULL_CHECKSUM' ? null : migration.sha256,
  }));
  const client = new FakeReconciliationClient(targetIdentity, initialLedger);
  const runtime: ReconciliationRuntime = {
    repositoryRoot: REPOSITORY_ROOT,
    databaseUrl:
      options.databaseUrl ?? 'postgresql://hx_ci_runner:synthetic@127.0.0.1:5432/hx_ci_system_test',
    manifestPath: MANIFEST_PATH,
    environment,
    readText: async (filePath) => {
      const content = files.get(path.resolve(filePath));
      if (content === undefined) throw new Error(`fixture file missing: ${filePath}`);
      return content;
    },
    createClient: () => client,
  };
  return { runtime, client, manifestText, evidenceText, files, environment, migrations };
}

function commandCount(client: FakeReconciliationClient, pattern: string): number {
  return client.commands.filter(({ sql }) => sql.includes(pattern)).length;
}

describe('legacy applied_migrations checksum reconciliation', () => {
  it('ships a structurally valid HOLD manifest with no authorization', async () => {
    const holdText = await readFile(
      path.resolve('backend/database/legacy-migration-checksum-reconciliation.HOLD.json'),
      'utf8'
    );
    const hold = parseReconciliationManifest(holdText);

    expect(hold.status).toBe('HOLD');
    expect(hold.authorization).toBeNull();
    expect(hold.payload.migrations).toEqual([]);
  });

  it('keeps plan mode read-only while proving the exact proposed NULL updates', async () => {
    const fixture = buildFixture();
    fixture.runtime.environment = {};
    const result = await runLegacyMigrationChecksumReconciliation('plan', fixture.runtime);

    expect(result.checksumUpdateCount).toBe(2);
    expect(result.mode).toBe('plan');
    expect(commandCount(fixture.client, 'current_database()')).toBe(1);
    expect(commandCount(fixture.client, 'SELECT name, sha256')).toBe(1);
    expect(commandCount(fixture.client, 'BEGIN')).toBe(0);
    expect(commandCount(fixture.client, 'pg_advisory_xact_lock')).toBe(0);
    expect(commandCount(fixture.client, 'UPDATE applied_migrations')).toBe(0);
    expect(commandCount(fixture.client, 'COMMIT')).toBe(0);
    expect(fixture.client.endCount).toBe(1);
  });

  it.each([
    ['NODE_ENV', 'production', 'APPLY_ENVIRONMENT_DENIED'],
    ['HX_ALLOW_LEGACY_MIGRATION_CHECKSUM_RECONCILIATION', 'true', 'APPLY_AUTHORITY_DENIED'],
  ])('requires the exact apply gate for %s', async (name, value, expectedError) => {
    const fixture = buildFixture();
    fixture.environment[name] = value;

    await expect(
      runLegacyMigrationChecksumReconciliation('apply', fixture.runtime)
    ).rejects.toThrow(expectedError);
    expect(fixture.client.connectCount).toBe(0);
  });

  it('applies an exact independently reviewed signature under one lock and transaction', async () => {
    const fixture = buildFixture({ states: ['VERIFIED_CHECKSUM', 'NULL_CHECKSUM'] });
    const result = await runLegacyMigrationChecksumReconciliation('apply', fixture.runtime);

    expect(result.checksumUpdateCount).toBe(1);
    expect(commandCount(fixture.client, 'BEGIN ISOLATION LEVEL SERIALIZABLE')).toBe(1);
    expect(commandCount(fixture.client, 'pg_advisory_xact_lock')).toBe(1);
    expect(commandCount(fixture.client, 'UPDATE applied_migrations')).toBe(1);
    expect(commandCount(fixture.client, 'sha256 IS NULL')).toBe(1);
    expect(commandCount(fixture.client, 'COMMIT')).toBe(1);
    expect(commandCount(fixture.client, 'ROLLBACK')).toBe(0);
    expect(fixture.client.ledger).toEqual([
      { name: 'migration_a', sha256: fixture.migrations[0].sha256 },
      { name: 'migration_b', sha256: fixture.migrations[1].sha256 },
    ]);
  });

  it('refuses the checked-in HOLD state before opening a connection', async () => {
    const fixture = buildFixture();
    const holdText = `${JSON.stringify(
      {
        ...JSON.parse(fixture.manifestText),
        status: 'HOLD',
        authorization: null,
      },
      null,
      2
    )}\n`;
    fixture.files.set(MANIFEST_PATH, holdText);

    await expect(
      runLegacyMigrationChecksumReconciliation('apply', fixture.runtime)
    ).rejects.toThrow('MANIFEST_HOLD');
    expect(fixture.client.connectCount).toBe(0);
  });

  it('requires distinct preparer and reviewer identities', () => {
    const fixture = buildFixture({
      preparedBy: 'operator:same@example.test',
      reviewedBy: 'operator:same@example.test',
    });

    expect(() => parseReconciliationManifest(fixture.manifestText)).toThrow(
      'REVIEW_INDEPENDENCE_REQUIRED'
    );
  });

  it('refuses a local SQL hash mismatch before opening a connection', async () => {
    const fixture = buildFixture();
    fixture.files.set(
      path.resolve(REPOSITORY_ROOT, fixture.migrations[0].sourcePath),
      'SELECT 9;\n'
    );

    await expect(runLegacyMigrationChecksumReconciliation('plan', fixture.runtime)).rejects.toThrow(
      'LOCAL_MIGRATION_HASH_MISMATCH'
    );
    expect(fixture.client.connectCount).toBe(0);
  });

  it('refuses target identity drift before opening a write transaction', async () => {
    const fixture = buildFixture();
    const driftedClient = new FakeReconciliationClient(
      { ...TARGET_IDENTITY, databaseName: 'different_database' },
      fixture.client.ledger
    );
    fixture.runtime.createClient = () => driftedClient;

    await expect(
      runLegacyMigrationChecksumReconciliation('apply', fixture.runtime)
    ).rejects.toThrow('TARGET_IDENTITY_MISMATCH');
    expect(commandCount(driftedClient, 'BEGIN')).toBe(0);
    expect(driftedClient.endCount).toBe(1);
  });

  it('requires an out-of-band exact target fingerprint for a non-loopback URL', async () => {
    const fixture = buildFixture({
      databaseUrl: 'postgresql://hx_ci_runner:synthetic@db.example.test:5432/hx_ci_system_test',
    });

    await expect(
      runLegacyMigrationChecksumReconciliation('apply', fixture.runtime)
    ).rejects.toThrow('REMOTE_TARGET_AUTHORITY_MISMATCH');
    expect(commandCount(fixture.client, 'BEGIN')).toBe(0);
  });

  it('refuses a manifest whose exact raw digest was not authorized', async () => {
    const fixture = buildFixture();
    fixture.environment.HX_LEGACY_MIGRATION_CHECKSUM_MANIFEST_SHA256 = 'f'.repeat(64);

    await expect(
      runLegacyMigrationChecksumReconciliation('apply', fixture.runtime)
    ).rejects.toThrow('MANIFEST_DIGEST_AUTHORITY_MISMATCH');
    expect(fixture.client.connectCount).toBe(0);
  });

  it('cryptographically rejects tampered signature evidence', async () => {
    const fixture = buildFixture({ tamperSignature: true });

    await expect(
      runLegacyMigrationChecksumReconciliation('apply', fixture.runtime)
    ).rejects.toThrow('SIGNATURE_VERIFICATION_FAILED');
    expect(fixture.client.connectCount).toBe(0);
  });

  it('fails closed when reconciliation would be a no-op', async () => {
    const fixture = buildFixture({ states: ['VERIFIED_CHECKSUM', 'VERIFIED_CHECKSUM'] });

    await expect(
      runLegacyMigrationChecksumReconciliation('apply', fixture.runtime)
    ).rejects.toThrow('RECONCILIATION_NOOP');
    expect(commandCount(fixture.client, 'ROLLBACK')).toBe(1);
    expect(commandCount(fixture.client, 'COMMIT')).toBe(0);
  });

  it('fails closed on a drifted non-NULL checksum', async () => {
    const fixture = buildFixture({ states: ['VERIFIED_CHECKSUM', 'NULL_CHECKSUM'] });
    fixture.client.ledger[0].sha256 = 'a'.repeat(64);

    await expect(
      runLegacyMigrationChecksumReconciliation('apply', fixture.runtime)
    ).rejects.toThrow('MIGRATION_CHECKSUM_DRIFT');
    expect(commandCount(fixture.client, 'ROLLBACK')).toBe(1);
  });

  it('fails closed when the target ledger is missing a reviewed entry', async () => {
    const fixture = buildFixture();
    fixture.client.ledger.pop();

    await expect(
      runLegacyMigrationChecksumReconciliation('apply', fixture.runtime)
    ).rejects.toThrow('LEDGER_SET_MISMATCH');
    expect(commandCount(fixture.client, 'ROLLBACK')).toBe(1);
  });

  it('fails closed when the target ledger has an unreviewed extra entry', async () => {
    const fixture = buildFixture();
    fixture.client.ledger.push({ name: 'migration_c', sha256: null });

    await expect(
      runLegacyMigrationChecksumReconciliation('apply', fixture.runtime)
    ).rejects.toThrow('LEDGER_SET_MISMATCH');
    expect(commandCount(fixture.client, 'ROLLBACK')).toBe(1);
  });

  it('fails closed when a reviewed NULL row was already partially reconciled', async () => {
    const fixture = buildFixture();
    fixture.client.ledger[0].sha256 = fixture.migrations[0].sha256;

    await expect(
      runLegacyMigrationChecksumReconciliation('apply', fixture.runtime)
    ).rejects.toThrow('LEDGER_PARTIAL_RECONCILIATION');
    expect(commandCount(fixture.client, 'ROLLBACK')).toBe(1);
  });

  it('rolls back every earlier update when a later update fails', async () => {
    const fixture = buildFixture();
    fixture.client.failUpdateName = 'migration_b';

    await expect(
      runLegacyMigrationChecksumReconciliation('apply', fixture.runtime)
    ).rejects.toThrow('injected update failure for migration_b');
    expect(commandCount(fixture.client, 'UPDATE applied_migrations')).toBe(2);
    expect(commandCount(fixture.client, 'ROLLBACK')).toBe(1);
    expect(commandCount(fixture.client, 'COMMIT')).toBe(0);
    expect(fixture.client.ledger).toEqual([
      { name: 'migration_a', sha256: null },
      { name: 'migration_b', sha256: null },
    ]);
  });
});
