import { createHash, createPublicKey, verify as verifyCryptographicSignature } from 'node:crypto';
import path from 'node:path';

export const LEGACY_CHECKSUM_RECONCILIATION_SCHEMA =
  'hustlexp.legacy-migration-checksum-reconciliation/v1';
export const LEGACY_CHECKSUM_SIGNATURE_SCHEMA = 'hustlexp.legacy-migration-checksum-signature/v1';
export const LEGACY_CHECKSUM_APPLY_FLAG = 'APPLY_EXACT_REVIEWED_MANIFEST';

const RECONCILIATION_LOCK = 'hustlexp:legacy-migration-checksum-reconciliation:v1';
const MIGRATION_ROOT = 'backend/database/migrations/';
const SIGNATURE_ROOT = 'backend/database/migration-checksum-signatures/';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MIGRATION_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export type ReconciliationMode = 'plan' | 'apply';
export type ExpectedLedgerState = 'NULL_CHECKSUM' | 'VERIFIED_CHECKSUM';

export interface ReconciliationTargetIdentity {
  databaseName: string;
  roleName: string;
  serverAddress: string;
  serverPort: number;
  serverVersionNum: string;
  clusterName: string;
}

export interface ReconciliationTarget extends ReconciliationTargetIdentity {
  environmentId: string;
  fingerprint: string;
}

export interface ReconciliationMigration {
  name: string;
  sourcePath: string;
  sha256: string;
  expectedLedgerState: ExpectedLedgerState;
}

export interface ReconciliationPayload {
  sourceCommitSha: string;
  preparedBy: string;
  reviewedBy: string;
  preparedAt: string;
  reviewedAt: string;
  target: ReconciliationTarget;
  migrations: ReconciliationMigration[];
}

export interface ReconciliationAuthorization {
  payloadSha256: string;
  signatureEvidencePath: string;
  signatureEvidenceSha256: string;
  signerPublicKeySha256: string;
}

export interface ReconciliationManifest {
  schemaVersion: typeof LEGACY_CHECKSUM_RECONCILIATION_SCHEMA;
  status: 'HOLD' | 'AUTHORIZED';
  payload: ReconciliationPayload;
  authorization: ReconciliationAuthorization | null;
}

export interface ReconciliationSignatureEvidence {
  schemaVersion: typeof LEGACY_CHECKSUM_SIGNATURE_SCHEMA;
  algorithm: 'ed25519';
  payloadSha256: string;
  signerIdentity: string;
  reviewedCommitSha: string;
  publicKeyPem: string;
  publicKeySha256: string;
  signatureBase64: string;
}

export interface ReconciliationQueryResult<Row extends Record<string, unknown>> {
  rows: Row[];
}

export interface ReconciliationClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<ReconciliationQueryResult<Row>>;
}

export interface ReconciliationRuntime {
  repositoryRoot: string;
  databaseUrl: string;
  manifestPath: string;
  environment: Readonly<Record<string, string | undefined>>;
  readText(filePath: string): Promise<string>;
  createClient(databaseUrl: string): ReconciliationClient;
}

export interface ReconciliationResult {
  mode: ReconciliationMode;
  manifestStatus: 'HOLD' | 'AUTHORIZED';
  manifestSha256: string;
  payloadSha256: string;
  targetFingerprint: string;
  ledgerEntryCount: number;
  checksumUpdateCount: number;
  migrations: Array<{
    name: string;
    sha256: string;
    action: 'SET_NULL_CHECKSUM' | 'VERIFY_EXISTING_CHECKSUM';
  }>;
}

type LedgerRow = {
  name: string;
  sha256: string | null;
};

type TargetRow = {
  database_name: unknown;
  role_name: unknown;
  server_address: unknown;
  server_port: unknown;
  server_version_num: unknown;
  cluster_name: unknown;
};

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail('MANIFEST_SCHEMA_INVALID', `${label} must be an object`);
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(
      'MANIFEST_SCHEMA_INVALID',
      `${label} keys must be exactly ${wanted.join(',')}; received ${actual.join(',')}`
    );
  }
}

function requireString(value: unknown, label: string, minimumLength = 1): string {
  if (
    typeof value !== 'string' ||
    value.length < minimumLength ||
    value.trim() !== value ||
    value.includes('\0')
  ) {
    fail('MANIFEST_SCHEMA_INVALID', `${label} must be a non-empty, trimmed string`);
  }
  return value;
}

function requireMultilineText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    fail('MANIFEST_SCHEMA_INVALID', `${label} must be non-empty text`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  const parsed = requireString(value, label);
  if (!SHA256_PATTERN.test(parsed)) {
    fail('MANIFEST_SCHEMA_INVALID', `${label} must be a lowercase SHA-256 digest`);
  }
  return parsed;
}

function requireCommitSha(value: unknown, label: string): string {
  const parsed = requireString(value, label);
  if (!COMMIT_PATTERN.test(parsed)) {
    fail('MANIFEST_SCHEMA_INVALID', `${label} must be a lowercase Git object ID`);
  }
  return parsed;
}

function requireIsoTimestamp(value: unknown, label: string): string {
  const parsed = requireString(value, label);
  const date = new Date(parsed);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== parsed) {
    fail('MANIFEST_SCHEMA_INVALID', `${label} must be an exact UTC ISO-8601 timestamp`);
  }
  return parsed;
}

function requirePort(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 65535) {
    fail('MANIFEST_SCHEMA_INVALID', `${label} must be an integer from 0 through 65535`);
  }
  return Number(value);
}

function assertConfinedRelativePath(
  candidate: string,
  requiredRoot: string,
  requiredSuffix: string,
  label: string
): void {
  if (
    path.isAbsolute(candidate) ||
    candidate.includes('\\') ||
    !candidate.startsWith(requiredRoot) ||
    !candidate.endsWith(requiredSuffix) ||
    path.posix.normalize(candidate) !== candidate
  ) {
    fail(
      'MANIFEST_SCHEMA_INVALID',
      `${label} must be a normalized repository-relative path under ${requiredRoot}`
    );
  }
}

function parseTarget(value: unknown): ReconciliationTarget {
  const target = requireRecord(value, 'payload.target');
  requireExactKeys(
    target,
    [
      'environmentId',
      'databaseName',
      'roleName',
      'serverAddress',
      'serverPort',
      'serverVersionNum',
      'clusterName',
      'fingerprint',
    ],
    'payload.target'
  );
  return {
    environmentId: requireString(target.environmentId, 'payload.target.environmentId'),
    databaseName: requireString(target.databaseName, 'payload.target.databaseName'),
    roleName: requireString(target.roleName, 'payload.target.roleName'),
    serverAddress: requireString(target.serverAddress, 'payload.target.serverAddress'),
    serverPort: requirePort(target.serverPort, 'payload.target.serverPort'),
    serverVersionNum: requireString(target.serverVersionNum, 'payload.target.serverVersionNum'),
    clusterName: requireString(target.clusterName, 'payload.target.clusterName'),
    fingerprint: requireSha256(target.fingerprint, 'payload.target.fingerprint'),
  };
}

function parseMigrations(value: unknown): ReconciliationMigration[] {
  if (!Array.isArray(value)) {
    fail('MANIFEST_SCHEMA_INVALID', 'payload.migrations must be an array');
  }
  const parsed = value.map((item, index): ReconciliationMigration => {
    const migration = requireRecord(item, `payload.migrations[${index}]`);
    requireExactKeys(
      migration,
      ['name', 'sourcePath', 'sha256', 'expectedLedgerState'],
      `payload.migrations[${index}]`
    );
    const name = requireString(migration.name, `payload.migrations[${index}].name`);
    if (!MIGRATION_NAME_PATTERN.test(name)) {
      fail('MANIFEST_SCHEMA_INVALID', `invalid migration name at index ${index}`);
    }
    const sourcePath = requireString(
      migration.sourcePath,
      `payload.migrations[${index}].sourcePath`
    );
    assertConfinedRelativePath(sourcePath, MIGRATION_ROOT, '.sql', 'migration sourcePath');
    const expectedLedgerState = migration.expectedLedgerState;
    if (expectedLedgerState !== 'NULL_CHECKSUM' && expectedLedgerState !== 'VERIFIED_CHECKSUM') {
      fail(
        'MANIFEST_SCHEMA_INVALID',
        `payload.migrations[${index}].expectedLedgerState is invalid`
      );
    }
    return {
      name,
      sourcePath,
      sha256: requireSha256(migration.sha256, `payload.migrations[${index}].sha256`),
      expectedLedgerState,
    };
  });

  const names = parsed.map(({ name }) => name);
  const paths = parsed.map(({ sourcePath }) => sourcePath);
  if (new Set(names).size !== names.length || new Set(paths).size !== paths.length) {
    fail('MANIFEST_SCHEMA_INVALID', 'migration names and source paths must each be unique');
  }
  const sortedNames = [...names].sort((left, right) => left.localeCompare(right));
  if (names.some((name, index) => name !== sortedNames[index])) {
    fail('MANIFEST_SCHEMA_INVALID', 'payload.migrations must be sorted by migration name');
  }
  return parsed;
}

function parsePayload(value: unknown): ReconciliationPayload {
  const payload = requireRecord(value, 'payload');
  requireExactKeys(
    payload,
    [
      'sourceCommitSha',
      'preparedBy',
      'reviewedBy',
      'preparedAt',
      'reviewedAt',
      'target',
      'migrations',
    ],
    'payload'
  );
  const preparedAt = requireIsoTimestamp(payload.preparedAt, 'payload.preparedAt');
  const reviewedAt = requireIsoTimestamp(payload.reviewedAt, 'payload.reviewedAt');
  if (reviewedAt < preparedAt) {
    fail('MANIFEST_SCHEMA_INVALID', 'payload.reviewedAt cannot precede payload.preparedAt');
  }
  return {
    sourceCommitSha: requireCommitSha(payload.sourceCommitSha, 'payload.sourceCommitSha'),
    preparedBy: requireString(payload.preparedBy, 'payload.preparedBy'),
    reviewedBy: requireString(payload.reviewedBy, 'payload.reviewedBy'),
    preparedAt,
    reviewedAt,
    target: parseTarget(payload.target),
    migrations: parseMigrations(payload.migrations),
  };
}

function parseAuthorization(value: unknown): ReconciliationAuthorization {
  const authorization = requireRecord(value, 'authorization');
  requireExactKeys(
    authorization,
    ['payloadSha256', 'signatureEvidencePath', 'signatureEvidenceSha256', 'signerPublicKeySha256'],
    'authorization'
  );
  const signatureEvidencePath = requireString(
    authorization.signatureEvidencePath,
    'authorization.signatureEvidencePath'
  );
  assertConfinedRelativePath(
    signatureEvidencePath,
    SIGNATURE_ROOT,
    '.json',
    'signatureEvidencePath'
  );
  return {
    payloadSha256: requireSha256(authorization.payloadSha256, 'authorization.payloadSha256'),
    signatureEvidencePath,
    signatureEvidenceSha256: requireSha256(
      authorization.signatureEvidenceSha256,
      'authorization.signatureEvidenceSha256'
    ),
    signerPublicKeySha256: requireSha256(
      authorization.signerPublicKeySha256,
      'authorization.signerPublicKeySha256'
    ),
  };
}

export function parseReconciliationManifest(rawText: string): ReconciliationManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText) as unknown;
  } catch (error) {
    fail(
      'MANIFEST_JSON_INVALID',
      error instanceof Error ? error.message : 'manifest is not valid JSON'
    );
  }
  const manifest = requireRecord(raw, 'manifest');
  requireExactKeys(manifest, ['schemaVersion', 'status', 'payload', 'authorization'], 'manifest');
  if (manifest.schemaVersion !== LEGACY_CHECKSUM_RECONCILIATION_SCHEMA) {
    fail('MANIFEST_SCHEMA_INVALID', 'unsupported schemaVersion');
  }
  if (manifest.status !== 'HOLD' && manifest.status !== 'AUTHORIZED') {
    fail('MANIFEST_SCHEMA_INVALID', 'status must be HOLD or AUTHORIZED');
  }
  const payload = parsePayload(manifest.payload);
  if (payload.preparedBy.toLowerCase() === payload.reviewedBy.toLowerCase()) {
    fail('REVIEW_INDEPENDENCE_REQUIRED', 'preparer and reviewer identities must differ');
  }

  if (manifest.status === 'HOLD') {
    if (manifest.authorization !== null) {
      fail('MANIFEST_SCHEMA_INVALID', 'HOLD manifest authorization must be null');
    }
    return {
      schemaVersion: LEGACY_CHECKSUM_RECONCILIATION_SCHEMA,
      status: 'HOLD',
      payload,
      authorization: null,
    };
  }

  if (payload.migrations.length === 0) {
    fail('MANIFEST_SCHEMA_INVALID', 'AUTHORIZED manifest must enumerate the exact ledger');
  }
  if (/^0+$/.test(payload.sourceCommitSha)) {
    fail('MANIFEST_SCHEMA_INVALID', 'AUTHORIZED manifest requires a non-placeholder commit');
  }
  return {
    schemaVersion: LEGACY_CHECKSUM_RECONCILIATION_SCHEMA,
    status: 'AUTHORIZED',
    payload,
    authorization: parseAuthorization(manifest.authorization),
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CANONICAL_JSON_INVALID', 'non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (!isRecord(value)) fail('CANONICAL_JSON_INVALID', 'unsupported value');
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

export function calculatePayloadSha256(payload: ReconciliationPayload): string {
  return sha256(canonicalJson(payload));
}

export function calculateTargetFingerprint(identity: ReconciliationTargetIdentity): string {
  return sha256(canonicalJson(identity));
}

export function signatureStatement(
  evidence: Omit<ReconciliationSignatureEvidence, 'signatureBase64'>
): string {
  return canonicalJson(evidence);
}

function parseSignatureEvidence(rawText: string): ReconciliationSignatureEvidence {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText) as unknown;
  } catch (error) {
    fail(
      'SIGNATURE_EVIDENCE_JSON_INVALID',
      error instanceof Error ? error.message : 'signature evidence is not valid JSON'
    );
  }
  const evidence = requireRecord(raw, 'signatureEvidence');
  requireExactKeys(
    evidence,
    [
      'schemaVersion',
      'algorithm',
      'payloadSha256',
      'signerIdentity',
      'reviewedCommitSha',
      'publicKeyPem',
      'publicKeySha256',
      'signatureBase64',
    ],
    'signatureEvidence'
  );
  if (evidence.schemaVersion !== LEGACY_CHECKSUM_SIGNATURE_SCHEMA) {
    fail('SIGNATURE_EVIDENCE_INVALID', 'unsupported signature evidence schemaVersion');
  }
  if (evidence.algorithm !== 'ed25519') {
    fail('SIGNATURE_EVIDENCE_INVALID', 'only ed25519 evidence is accepted');
  }
  const signatureBase64 = requireString(
    evidence.signatureBase64,
    'signatureEvidence.signatureBase64'
  );
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureBase64)) {
    fail('SIGNATURE_EVIDENCE_INVALID', 'signature must be canonical base64');
  }
  return {
    schemaVersion: LEGACY_CHECKSUM_SIGNATURE_SCHEMA,
    algorithm: 'ed25519',
    payloadSha256: requireSha256(evidence.payloadSha256, 'signatureEvidence.payloadSha256'),
    signerIdentity: requireString(evidence.signerIdentity, 'signatureEvidence.signerIdentity'),
    reviewedCommitSha: requireCommitSha(
      evidence.reviewedCommitSha,
      'signatureEvidence.reviewedCommitSha'
    ),
    publicKeyPem: requireMultilineText(evidence.publicKeyPem, 'signatureEvidence.publicKeyPem'),
    publicKeySha256: requireSha256(evidence.publicKeySha256, 'signatureEvidence.publicKeySha256'),
    signatureBase64,
  };
}

function resolveRepositoryPath(repositoryRoot: string, relativePath: string): string {
  const root = path.resolve(repositoryRoot);
  const resolved = path.resolve(root, relativePath.split('/').join(path.sep));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('REPOSITORY_PATH_INVALID', 'artifact path must resolve beneath repository root');
  }
  return resolved;
}

async function verifyLocalMigrationFiles(
  runtime: ReconciliationRuntime,
  migrations: readonly ReconciliationMigration[]
): Promise<void> {
  for (const migration of migrations) {
    const exactSql = await runtime.readText(
      resolveRepositoryPath(runtime.repositoryRoot, migration.sourcePath)
    );
    const actual = sha256(exactSql);
    if (actual !== migration.sha256) {
      fail(
        'LOCAL_MIGRATION_HASH_MISMATCH',
        `${migration.name} manifest ${migration.sha256} local ${actual}`
      );
    }
  }
}

function requireApplyEnvironment(runtime: ReconciliationRuntime, manifestSha256: string): void {
  const environment = runtime.environment;
  if (environment.NODE_ENV !== 'maintenance') {
    fail('APPLY_ENVIRONMENT_DENIED', 'NODE_ENV must equal maintenance');
  }
  if (
    environment.HX_ALLOW_LEGACY_MIGRATION_CHECKSUM_RECONCILIATION !== LEGACY_CHECKSUM_APPLY_FLAG
  ) {
    fail(
      'APPLY_AUTHORITY_DENIED',
      `HX_ALLOW_LEGACY_MIGRATION_CHECKSUM_RECONCILIATION must equal ${LEGACY_CHECKSUM_APPLY_FLAG}`
    );
  }
  if (environment.HX_LEGACY_MIGRATION_CHECKSUM_MANIFEST_SHA256 !== manifestSha256) {
    fail('MANIFEST_DIGEST_AUTHORITY_MISMATCH', 'exact manifest digest was not authorized');
  }
}

async function verifyAuthorization(
  runtime: ReconciliationRuntime,
  manifest: ReconciliationManifest,
  manifestSha256: string,
  payloadSha256: string
): Promise<void> {
  if (manifest.status !== 'AUTHORIZED' || !manifest.authorization) {
    fail('MANIFEST_HOLD', 'apply requires an AUTHORIZED manifest');
  }
  requireApplyEnvironment(runtime, manifestSha256);
  const authorization = manifest.authorization;
  if (authorization.payloadSha256 !== payloadSha256) {
    fail('PAYLOAD_DIGEST_MISMATCH', 'authorization does not bind the canonical payload');
  }

  const evidenceText = await runtime.readText(
    resolveRepositoryPath(runtime.repositoryRoot, authorization.signatureEvidencePath)
  );
  const evidenceSha256 = sha256(evidenceText);
  if (
    evidenceSha256 !== authorization.signatureEvidenceSha256 ||
    runtime.environment.HX_LEGACY_MIGRATION_CHECKSUM_SIGNATURE_SHA256 !== evidenceSha256
  ) {
    fail('SIGNATURE_EVIDENCE_DIGEST_MISMATCH', 'exact signature evidence was not authorized');
  }
  const evidence = parseSignatureEvidence(evidenceText);
  if (
    evidence.payloadSha256 !== payloadSha256 ||
    evidence.reviewedCommitSha !== manifest.payload.sourceCommitSha ||
    evidence.signerIdentity !== manifest.payload.reviewedBy
  ) {
    fail('SIGNATURE_EVIDENCE_BINDING_MISMATCH', 'signature evidence does not bind the review');
  }
  const publicKeySha256 = sha256(evidence.publicKeyPem);
  if (
    publicKeySha256 !== evidence.publicKeySha256 ||
    publicKeySha256 !== authorization.signerPublicKeySha256 ||
    runtime.environment.HX_LEGACY_MIGRATION_CHECKSUM_SIGNER_KEY_SHA256 !== publicKeySha256
  ) {
    fail('SIGNER_KEY_AUTHORITY_MISMATCH', 'exact reviewer public key was not authorized');
  }
  let publicKey;
  try {
    publicKey = createPublicKey(evidence.publicKeyPem);
  } catch {
    fail('SIGNATURE_EVIDENCE_INVALID', 'reviewer public key is invalid');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    fail('SIGNATURE_EVIDENCE_INVALID', 'reviewer key must be Ed25519');
  }
  const { signatureBase64: _signature, ...unsignedEvidence } = evidence;
  const verified = verifyCryptographicSignature(
    null,
    Buffer.from(signatureStatement(unsignedEvidence), 'utf8'),
    publicKey,
    Buffer.from(evidence.signatureBase64, 'base64')
  );
  if (!verified) fail('SIGNATURE_VERIFICATION_FAILED', 'review signature is invalid');
}

function parseTargetIdentity(rows: TargetRow[]): ReconciliationTargetIdentity {
  if (rows.length !== 1)
    fail('TARGET_IDENTITY_INVALID', 'identity query must return exactly one row');
  const row = rows[0];
  const serverPort = Number(row.server_port);
  if (!Number.isInteger(serverPort) || serverPort < 0 || serverPort > 65535) {
    fail('TARGET_IDENTITY_INVALID', 'database returned an invalid server port');
  }
  return {
    databaseName: requireString(row.database_name, 'target.databaseName'),
    roleName: requireString(row.role_name, 'target.roleName'),
    serverAddress: requireString(row.server_address, 'target.serverAddress'),
    serverPort,
    serverVersionNum: requireString(row.server_version_num, 'target.serverVersionNum'),
    clusterName: requireString(row.cluster_name, 'target.clusterName'),
  };
}

async function readTargetIdentity(
  client: ReconciliationClient
): Promise<ReconciliationTargetIdentity> {
  const result = await client.query<TargetRow>(
    `SELECT current_database()::text AS database_name,
            current_user::text AS role_name,
            COALESCE(inet_server_addr()::text, 'local_socket') AS server_address,
            COALESCE(inet_server_port(), 0)::integer AS server_port,
            current_setting('server_version_num')::text AS server_version_num,
            COALESCE(NULLIF(current_setting('cluster_name', true), ''), 'unset')::text AS cluster_name`
  );
  return parseTargetIdentity(result.rows);
}

function assertExactTarget(
  expected: ReconciliationTarget,
  actual: ReconciliationTargetIdentity
): string {
  const fingerprint = calculateTargetFingerprint(actual);
  const expectedIdentity: ReconciliationTargetIdentity = {
    databaseName: expected.databaseName,
    roleName: expected.roleName,
    serverAddress: expected.serverAddress,
    serverPort: expected.serverPort,
    serverVersionNum: expected.serverVersionNum,
    clusterName: expected.clusterName,
  };
  if (
    canonicalJson(actual) !== canonicalJson(expectedIdentity) ||
    fingerprint !== expected.fingerprint
  ) {
    fail('TARGET_IDENTITY_MISMATCH', `observed fingerprint ${fingerprint}`);
  }
  return fingerprint;
}

function databaseHostname(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    fail('DATABASE_URL_INVALID', 'DATABASE_URL must be an absolute PostgreSQL URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    fail('DATABASE_URL_INVALID', 'DATABASE_URL must use postgres or postgresql');
  }
  return url.hostname.toLowerCase();
}

function isExactLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

function assertRemoteTargetAuthority(runtime: ReconciliationRuntime, fingerprint: string): void {
  const hostname = databaseHostname(runtime.databaseUrl);
  if (
    !isExactLoopback(hostname) &&
    runtime.environment.HX_LEGACY_MIGRATION_CHECKSUM_TARGET_FINGERPRINT !== fingerprint
  ) {
    fail(
      'REMOTE_TARGET_AUTHORITY_MISMATCH',
      'non-loopback apply requires the exact observed target fingerprint'
    );
  }
}

async function readLedger(client: ReconciliationClient): Promise<LedgerRow[]> {
  const result = await client.query<{ name: unknown; sha256: unknown }>(
    'SELECT name, sha256 FROM applied_migrations ORDER BY name'
  );
  return result.rows.map((row, index) => {
    const name = requireString(row.name, `ledger[${index}].name`);
    if (row.sha256 !== null && typeof row.sha256 !== 'string') {
      fail('LEDGER_ROW_INVALID', `${name} checksum must be text or NULL`);
    }
    return { name, sha256: typeof row.sha256 === 'string' ? row.sha256.trim() : null };
  });
}

function assertExactLedgerBeforeApply(
  migrations: readonly ReconciliationMigration[],
  ledger: readonly LedgerRow[]
): ReconciliationMigration[] {
  const manifestNames = migrations.map(({ name }) => name);
  const ledgerNames = ledger.map(({ name }) => name);
  if (new Set(ledgerNames).size !== ledgerNames.length) {
    fail('LEDGER_DUPLICATE_ENTRY', 'ledger returned duplicate migration names');
  }
  const manifestSet = new Set(manifestNames);
  const ledgerSet = new Set(ledgerNames);
  const missing = manifestNames.filter((name) => !ledgerSet.has(name));
  const extra = ledgerNames.filter((name) => !manifestSet.has(name));
  if (missing.length || extra.length) {
    fail(
      'LEDGER_SET_MISMATCH',
      `missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`
    );
  }

  const rowsByName = new Map(ledger.map((row) => [row.name, row]));
  const updates: ReconciliationMigration[] = [];
  for (const migration of migrations) {
    const recorded = rowsByName.get(migration.name)?.sha256 ?? null;
    if (migration.expectedLedgerState === 'NULL_CHECKSUM') {
      if (recorded !== null) {
        fail(
          'LEDGER_PARTIAL_RECONCILIATION',
          `${migration.name} was reviewed as NULL but is ${recorded}`
        );
      }
      updates.push(migration);
      continue;
    }
    if (recorded === null) {
      fail(
        'LEDGER_PARTIAL_RECONCILIATION',
        `${migration.name} was reviewed as verified but is NULL`
      );
    }
    if (recorded !== migration.sha256) {
      fail(
        'MIGRATION_CHECKSUM_DRIFT',
        `${migration.name} recorded ${recorded} expected ${migration.sha256}`
      );
    }
  }
  if (updates.length === 0) {
    fail('RECONCILIATION_NOOP', 'manifest contains no NULL checksum rows to reconcile');
  }
  return updates;
}

function assertExactLedgerAfterApply(
  migrations: readonly ReconciliationMigration[],
  ledger: readonly LedgerRow[]
): void {
  const manifestNames = migrations.map(({ name }) => name);
  const ledgerNames = ledger.map(({ name }) => name);
  if (
    manifestNames.length !== ledgerNames.length ||
    manifestNames.some((name) => !ledgerNames.includes(name))
  ) {
    fail('POST_APPLY_LEDGER_SET_MISMATCH', 'ledger membership changed during reconciliation');
  }
  const rowsByName = new Map(ledger.map((row) => [row.name, row.sha256]));
  for (const migration of migrations) {
    if (rowsByName.get(migration.name) !== migration.sha256) {
      fail('POST_APPLY_VERIFICATION_FAILED', `${migration.name} checksum did not converge`);
    }
  }
}

function resultFor(
  mode: ReconciliationMode,
  manifest: ReconciliationManifest,
  manifestSha256: string,
  payloadSha256: string,
  targetFingerprint: string,
  updateCount: number
): ReconciliationResult {
  return {
    mode,
    manifestStatus: manifest.status,
    manifestSha256,
    payloadSha256,
    targetFingerprint,
    ledgerEntryCount: manifest.payload.migrations.length,
    checksumUpdateCount: updateCount,
    migrations: manifest.payload.migrations.map((migration) => ({
      name: migration.name,
      sha256: migration.sha256,
      action:
        migration.expectedLedgerState === 'NULL_CHECKSUM'
          ? 'SET_NULL_CHECKSUM'
          : 'VERIFY_EXISTING_CHECKSUM',
    })),
  };
}

export async function runLegacyMigrationChecksumReconciliation(
  mode: ReconciliationMode,
  runtime: ReconciliationRuntime
): Promise<ReconciliationResult> {
  if (!runtime.databaseUrl) fail('DATABASE_URL_REQUIRED', 'DATABASE_URL is required');
  const manifestText = await runtime.readText(runtime.manifestPath);
  const manifest = parseReconciliationManifest(manifestText);
  const manifestSha256 = sha256(manifestText);
  const payloadSha256 = calculatePayloadSha256(manifest.payload);
  await verifyLocalMigrationFiles(runtime, manifest.payload.migrations);
  if (mode === 'apply') {
    await verifyAuthorization(runtime, manifest, manifestSha256, payloadSha256);
  }

  const client = runtime.createClient(runtime.databaseUrl);
  await client.connect();
  try {
    const targetIdentity = await readTargetIdentity(client);
    const targetFingerprint = assertExactTarget(manifest.payload.target, targetIdentity);
    if (mode === 'apply') assertRemoteTargetAuthority(runtime, targetFingerprint);

    if (mode === 'plan') {
      const ledger = await readLedger(client);
      const updates = assertExactLedgerBeforeApply(manifest.payload.migrations, ledger);
      return resultFor(
        mode,
        manifest,
        manifestSha256,
        payloadSha256,
        targetFingerprint,
        updates.length
      );
    }

    let transactionStarted = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE');
      transactionStarted = true;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [RECONCILIATION_LOCK]);
      const ledger = await readLedger(client);
      const updates = assertExactLedgerBeforeApply(manifest.payload.migrations, ledger);
      for (const migration of updates) {
        const updated = await client.query<{ name: string; sha256: string }>(
          `UPDATE applied_migrations
           SET sha256 = $2
           WHERE name = $1 AND sha256 IS NULL
           RETURNING name, sha256`,
          [migration.name, migration.sha256]
        );
        if (updated.rows.length !== 1) {
          fail(
            'CHECKSUM_UPDATE_PRECONDITION_FAILED',
            `${migration.name} was not updated from NULL exactly once`
          );
        }
      }
      const finalLedger = await readLedger(client);
      assertExactLedgerAfterApply(manifest.payload.migrations, finalLedger);
      await client.query('COMMIT');
      return resultFor(
        mode,
        manifest,
        manifestSha256,
        payloadSha256,
        targetFingerprint,
        updates.length
      );
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'RECONCILIATION_ROLLBACK_FAILED: apply failed and rollback was not confirmed'
          );
        }
      }
      throw error;
    }
  } finally {
    await client.end();
  }
}
