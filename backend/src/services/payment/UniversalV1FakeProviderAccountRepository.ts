import { createHash } from 'node:crypto';

import { db, type Database, type QueryFn } from '../../db.js';
import type { ProviderAccountState } from './FinancialProviderPorts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const PROVIDER_ACCOUNT_STATES = new Set<ProviderAccountState>([
  'PENDING',
  'ENABLED',
  'RESTRICTED',
  'FAILED',
]);

export interface DurableFakeProviderAccountCommandEvidence {
  readonly commandId: string;
  readonly dispatchAttemptId: string;
  readonly outcomeFactId: string;
  readonly fakeOperationEventId: string;
}

export type UniversalV1FakeProviderAccountSubject =
  | {
      readonly kind: 'USER';
      readonly userId: string;
    }
  | {
      readonly kind: 'ORGANIZATION';
      readonly organizationId: string;
    };

export interface MaterializeUniversalV1FakeProviderAccountFactInput {
  readonly providerSubject: UniversalV1FakeProviderAccountSubject;
  /**
   * The acting participant who caused both provider-scoped commands.
   * PostgreSQL independently proves USER self-authority or active
   * ORGANIZATION owner/admin authority without making the actor the subject.
   */
  readonly recordedBy: string;
  readonly onboard: DurableFakeProviderAccountCommandEvidence;
  readonly refresh: DurableFakeProviderAccountCommandEvidence;
}

export interface UniversalV1FakeProviderAccountFact {
  readonly providerAccountFactId: string;
  readonly providerSubject: UniversalV1FakeProviderAccountSubject;
  readonly accountVersion: number;
  readonly supersedesFactId: string | null;
  readonly accountState: ProviderAccountState;
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean;
  readonly requirementsDueSha256: string;
  readonly providerAccountReferenceSha256: string;
  /**
   * Recovered from the exact ONBOARD_PROVIDER fake event. It is never stored
   * in the provider-account fact or accepted as materialization input.
   */
  readonly providerAccountReference: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly materializedAt: string;
  readonly onboard: DurableFakeProviderAccountCommandEvidence;
  readonly refresh: DurableFakeProviderAccountCommandEvidence;
  readonly idempotencyReplayed: boolean;
}

export type UniversalV1FakeProviderAccountRepositoryErrorReason =
  | 'SUBJECT_INVALID'
  | 'ACTOR_INVALID'
  | 'ACTOR_SUBJECT_MISMATCH'
  | 'EVIDENCE_INVALID'
  | 'EVIDENCE_CONFLICT'
  | 'PERSISTENCE_INCOMPLETE'
  | 'PERSISTENCE_IDENTITY_MISMATCH';

export class UniversalV1FakeProviderAccountRepositoryError extends Error {
  constructor(readonly reason: UniversalV1FakeProviderAccountRepositoryErrorReason) {
    super(`UNIVERSAL_V1_FAKE_PROVIDER_ACCOUNT_${reason}`);
    this.name = 'UniversalV1FakeProviderAccountRepositoryError';
  }
}

export interface UniversalV1FakeProviderAccountRepository {
  materializeFromDurableEvidence(
    input: MaterializeUniversalV1FakeProviderAccountFactInput
  ): Promise<UniversalV1FakeProviderAccountFact>;

  /**
   * Returns the latest subject fact only when that exact latest fact is
   * ENABLED and payout-ready. It never falls back to an older enabled fact.
   */
  findLatestPayoutReady(input: {
    readonly providerSubject: UniversalV1FakeProviderAccountSubject;
  }): Promise<UniversalV1FakeProviderAccountFact | null>;

  /**
   * Same authoritative latest-fact read, with share locks suitable for binding
   * the fact inside a caller-owned terminal-intent transaction.
   */
  findLatestPayoutReadyInTransaction(
    query: QueryFn,
    input: {
      readonly providerSubject: UniversalV1FakeProviderAccountSubject;
    }
  ): Promise<UniversalV1FakeProviderAccountFact | null>;

  /**
   * Reads the exact payout-ready fact already pinned by a terminal intent.
   * Unlike the latest-fact lookup, this deliberately does not drift to a
   * newer account fact while a committed terminal plan is being resumed.
   */
  findPinnedPayoutReadyInTransaction(
    query: QueryFn,
    input: {
      readonly providerAccountFactId: string;
      readonly providerSubject: UniversalV1FakeProviderAccountSubject;
    }
  ): Promise<UniversalV1FakeProviderAccountFact | null>;
}

interface ProviderAccountFactRow {
  provider_account_fact_id: string;
  provider_subject_kind: 'USER' | 'ORGANIZATION';
  provider_user_id: string | null;
  provider_organization_id: string | null;
  account_version: number | string;
  supersedes_fact_id: string | null;
  onboard_command_id: string;
  onboard_dispatch_attempt_id: string;
  onboard_outcome_fact_id: string;
  onboard_fake_event_id: string;
  refresh_command_id: string;
  refresh_dispatch_attempt_id: string;
  refresh_outcome_fact_id: string;
  refresh_fake_event_id: string;
  provider_account_reference_sha256: string;
  account_state: ProviderAccountState;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  requirements_due_sha256: string;
  recorded_by: string;
  recorded_at: Date | string;
  materialized_at: Date | string;
  provider_account_reference: string;
}

const FACT_SELECT = `
  fact.provider_account_fact_id,
  fact.provider_subject_kind,
  fact.provider_user_id,
  fact.provider_organization_id,
  fact.account_version,
  fact.supersedes_fact_id,
  fact.onboard_command_id,
  fact.onboard_dispatch_attempt_id,
  fact.onboard_outcome_fact_id,
  fact.onboard_fake_event_id,
  fact.refresh_command_id,
  fact.refresh_dispatch_attempt_id,
  fact.refresh_outcome_fact_id,
  fact.refresh_fake_event_id,
  fact.provider_account_reference_sha256,
  fact.account_state,
  fact.charges_enabled,
  fact.payouts_enabled,
  fact.requirements_due_sha256,
  fact.recorded_by,
  fact.recorded_at,
  fact.materialized_at,
  onboard_event.external_reference AS provider_account_reference`;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactIso(value: Date | string): string | null {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function assertUuid(
  value: unknown,
  reason: UniversalV1FakeProviderAccountRepositoryErrorReason
): void {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new UniversalV1FakeProviderAccountRepositoryError(reason);
  }
}

interface NormalizedProviderSubject {
  readonly kind: UniversalV1FakeProviderAccountSubject['kind'];
  readonly id: string;
  readonly userId: string | null;
  readonly organizationId: string | null;
  readonly lockKey: string;
}

function normalizeProviderSubject(
  subject: UniversalV1FakeProviderAccountSubject
): NormalizedProviderSubject {
  if (subject.kind === 'USER') {
    assertUuid(subject.userId, 'SUBJECT_INVALID');
    return {
      kind: 'USER',
      id: subject.userId,
      userId: subject.userId,
      organizationId: null,
      lockKey: `USER:${subject.userId}`,
    };
  }
  if (subject.kind === 'ORGANIZATION') {
    assertUuid(subject.organizationId, 'SUBJECT_INVALID');
    return {
      kind: 'ORGANIZATION',
      id: subject.organizationId,
      userId: null,
      organizationId: subject.organizationId,
      lockKey: `ORGANIZATION:${subject.organizationId}`,
    };
  }
  throw new UniversalV1FakeProviderAccountRepositoryError('SUBJECT_INVALID');
}

function providerSubjectFromRow(
  row: ProviderAccountFactRow
): UniversalV1FakeProviderAccountSubject {
  if (
    row.provider_subject_kind === 'USER' &&
    row.provider_user_id !== null &&
    UUID.test(row.provider_user_id) &&
    row.provider_organization_id === null
  ) {
    return { kind: 'USER', userId: row.provider_user_id };
  }
  if (
    row.provider_subject_kind === 'ORGANIZATION' &&
    row.provider_user_id === null &&
    row.provider_organization_id !== null &&
    UUID.test(row.provider_organization_id)
  ) {
    return { kind: 'ORGANIZATION', organizationId: row.provider_organization_id };
  }
  throw new UniversalV1FakeProviderAccountRepositoryError('PERSISTENCE_IDENTITY_MISMATCH');
}

function sameProviderSubject(
  left: UniversalV1FakeProviderAccountSubject,
  right: UniversalV1FakeProviderAccountSubject
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'USER'
      ? right.kind === 'USER' && left.userId === right.userId
      : right.kind === 'ORGANIZATION' && left.organizationId === right.organizationId)
  );
}

function assertEvidence(evidence: DurableFakeProviderAccountCommandEvidence): void {
  assertUuid(evidence.commandId, 'EVIDENCE_INVALID');
  assertUuid(evidence.dispatchAttemptId, 'EVIDENCE_INVALID');
  assertUuid(evidence.outcomeFactId, 'EVIDENCE_INVALID');
  assertUuid(evidence.fakeOperationEventId, 'EVIDENCE_INVALID');
}

function assertInput(input: MaterializeUniversalV1FakeProviderAccountFactInput): void {
  const subject = normalizeProviderSubject(input.providerSubject);
  assertUuid(input.recordedBy, 'ACTOR_INVALID');
  if (subject.kind === 'USER' && input.recordedBy !== subject.userId) {
    throw new UniversalV1FakeProviderAccountRepositoryError('ACTOR_SUBJECT_MISMATCH');
  }
  assertEvidence(input.onboard);
  assertEvidence(input.refresh);
  if (
    input.onboard.commandId === input.refresh.commandId ||
    input.onboard.dispatchAttemptId === input.refresh.dispatchAttemptId ||
    input.onboard.outcomeFactId === input.refresh.outcomeFactId ||
    input.onboard.fakeOperationEventId === input.refresh.fakeOperationEventId
  ) {
    throw new UniversalV1FakeProviderAccountRepositoryError('EVIDENCE_INVALID');
  }
}

function evidenceFromRow(
  row: ProviderAccountFactRow,
  prefix: 'onboard' | 'refresh'
): DurableFakeProviderAccountCommandEvidence {
  return {
    commandId: row[`${prefix}_command_id`],
    dispatchAttemptId: row[`${prefix}_dispatch_attempt_id`],
    outcomeFactId: row[`${prefix}_outcome_fact_id`],
    fakeOperationEventId: row[`${prefix}_fake_event_id`],
  };
}

function sameEvidence(
  left: DurableFakeProviderAccountCommandEvidence,
  right: DurableFakeProviderAccountCommandEvidence
): boolean {
  return (
    left.commandId === right.commandId &&
    left.dispatchAttemptId === right.dispatchAttemptId &&
    left.outcomeFactId === right.outcomeFactId &&
    left.fakeOperationEventId === right.fakeOperationEventId
  );
}

function factFromRow(
  row: ProviderAccountFactRow,
  idempotencyReplayed: boolean
): UniversalV1FakeProviderAccountFact {
  const accountVersion =
    typeof row.account_version === 'number' ? row.account_version : Number(row.account_version);
  const recordedAt = exactIso(row.recorded_at);
  const materializedAt = exactIso(row.materialized_at);
  const providerSubject = providerSubjectFromRow(row);
  if (
    !UUID.test(row.provider_account_fact_id) ||
    !Number.isSafeInteger(accountVersion) ||
    accountVersion < 1 ||
    (row.supersedes_fact_id !== null && !UUID.test(row.supersedes_fact_id)) ||
    !PROVIDER_ACCOUNT_STATES.has(row.account_state) ||
    typeof row.charges_enabled !== 'boolean' ||
    typeof row.payouts_enabled !== 'boolean' ||
    (row.account_state === 'ENABLED') !==
      (row.charges_enabled === true && row.payouts_enabled === true) ||
    !SHA256.test(row.requirements_due_sha256) ||
    !SHA256.test(row.provider_account_reference_sha256) ||
    typeof row.provider_account_reference !== 'string' ||
    row.provider_account_reference.length < 3 ||
    row.provider_account_reference.length > 256 ||
    sha256(row.provider_account_reference) !== row.provider_account_reference_sha256 ||
    !UUID.test(row.recorded_by) ||
    recordedAt === null ||
    materializedAt === null
  ) {
    throw new UniversalV1FakeProviderAccountRepositoryError('PERSISTENCE_IDENTITY_MISMATCH');
  }
  const onboard = evidenceFromRow(row, 'onboard');
  const refresh = evidenceFromRow(row, 'refresh');
  try {
    assertEvidence(onboard);
    assertEvidence(refresh);
  } catch {
    throw new UniversalV1FakeProviderAccountRepositoryError('PERSISTENCE_IDENTITY_MISMATCH');
  }
  return {
    providerAccountFactId: row.provider_account_fact_id,
    providerSubject,
    accountVersion,
    supersedesFactId: row.supersedes_fact_id,
    accountState: row.account_state,
    chargesEnabled: row.charges_enabled,
    payoutsEnabled: row.payouts_enabled,
    requirementsDueSha256: row.requirements_due_sha256,
    providerAccountReferenceSha256: row.provider_account_reference_sha256,
    providerAccountReference: row.provider_account_reference,
    recordedBy: row.recorded_by,
    recordedAt,
    materializedAt,
    onboard,
    refresh,
    idempotencyReplayed,
  };
}

function sameMaterialization(
  fact: UniversalV1FakeProviderAccountFact,
  input: MaterializeUniversalV1FakeProviderAccountFactInput
): boolean {
  return (
    sameProviderSubject(fact.providerSubject, input.providerSubject) &&
    fact.recordedBy === input.recordedBy &&
    sameEvidence(fact.onboard, input.onboard) &&
    sameEvidence(fact.refresh, input.refresh)
  );
}

async function selectFactById(
  query: QueryFn,
  providerAccountFactId: string
): Promise<ProviderAccountFactRow | undefined> {
  const result = await query<ProviderAccountFactRow>(
    `SELECT ${FACT_SELECT}
       FROM public.universal_v1_fake_provider_account_facts fact
       JOIN public.hxos_fake_financial_operation_events_v1 onboard_event
         ON onboard_event.event_id = fact.onboard_fake_event_id
      WHERE fact.provider_account_fact_id = $1`,
    [providerAccountFactId]
  );
  return result.rows[0];
}

async function selectLatestPayoutReady(
  query: QueryFn,
  input: {
    readonly providerSubject: UniversalV1FakeProviderAccountSubject;
  },
  lockInTransaction: boolean
): Promise<UniversalV1FakeProviderAccountFact | null> {
  const subject = normalizeProviderSubject(input.providerSubject);
  if (lockInTransaction) {
    await query(
      `SELECT pg_advisory_xact_lock(
         hashtext('universal-v1-fake-provider-account-v1'), hashtext($1)
       )`,
      [subject.lockKey]
    );
  }
  const result = await query<ProviderAccountFactRow>(
    `SELECT ${FACT_SELECT}
       FROM public.universal_v1_fake_provider_account_facts fact
       JOIN public.hxos_fake_financial_operation_events_v1 onboard_event
         ON onboard_event.event_id = fact.onboard_fake_event_id
      WHERE fact.provider_subject_kind = $1
        AND fact.provider_user_id IS NOT DISTINCT FROM $2::UUID
        AND fact.provider_organization_id IS NOT DISTINCT FROM $3::UUID
      ORDER BY fact.account_version DESC
      LIMIT 1${lockInTransaction ? '\n      FOR SHARE OF fact, onboard_event' : ''}`,
    [subject.kind, subject.userId, subject.organizationId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const latest = factFromRow(row, true);
  return latest.accountState === 'ENABLED' && latest.payoutsEnabled ? latest : null;
}

async function selectPinnedPayoutReady(
  query: QueryFn,
  input: {
    readonly providerAccountFactId: string;
    readonly providerSubject: UniversalV1FakeProviderAccountSubject;
  }
): Promise<UniversalV1FakeProviderAccountFact | null> {
  assertUuid(input.providerAccountFactId, 'SUBJECT_INVALID');
  const subject = normalizeProviderSubject(input.providerSubject);
  const result = await query<ProviderAccountFactRow>(
    `SELECT ${FACT_SELECT}
       FROM public.universal_v1_fake_provider_account_facts fact
       JOIN public.hxos_fake_financial_operation_events_v1 onboard_event
         ON onboard_event.event_id = fact.onboard_fake_event_id
      WHERE fact.provider_account_fact_id = $1
        AND fact.provider_subject_kind = $2
        AND fact.provider_user_id IS NOT DISTINCT FROM $3::UUID
        AND fact.provider_organization_id IS NOT DISTINCT FROM $4::UUID
      FOR SHARE OF fact, onboard_event`,
    [input.providerAccountFactId, subject.kind, subject.userId, subject.organizationId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const pinned = factFromRow(row, true);
  return pinned.accountState === 'ENABLED' && pinned.payoutsEnabled ? pinned : null;
}

function normalizeMaterializationPersistenceError(error: unknown): never {
  if (error instanceof UniversalV1FakeProviderAccountRepositoryError) throw error;
  const persistence = error as {
    readonly code?: unknown;
    readonly constraint?: unknown;
    readonly message?: unknown;
  };
  const message = typeof persistence.message === 'string' ? persistence.message : '';
  if (persistence.code === 'P0001' && message.startsWith('HXUV1-FTL-10:')) {
    throw new UniversalV1FakeProviderAccountRepositoryError('SUBJECT_INVALID');
  }
  if (persistence.code === 'P0001' && /^HXUV1-FTL-(?:1[1-4]|1[679]):/u.test(message)) {
    throw new UniversalV1FakeProviderAccountRepositoryError('EVIDENCE_INVALID');
  }
  if (persistence.code === 'P0001' && message.startsWith('HXUV1-FTL-15:')) {
    throw new UniversalV1FakeProviderAccountRepositoryError('ACTOR_SUBJECT_MISMATCH');
  }
  if (persistence.code === 'P0001' && message.startsWith('HXUV1-FTL-18:')) {
    throw new UniversalV1FakeProviderAccountRepositoryError('PERSISTENCE_IDENTITY_MISMATCH');
  }
  if (
    persistence.code === '23505' &&
    typeof persistence.constraint === 'string' &&
    persistence.constraint.startsWith('universal_v1_fake_provider_account')
  ) {
    throw new UniversalV1FakeProviderAccountRepositoryError('EVIDENCE_CONFLICT');
  }
  throw error;
}

export class PostgresUniversalV1FakeProviderAccountRepository implements UniversalV1FakeProviderAccountRepository {
  constructor(private readonly database: Database = db) {}

  async materializeFromDurableEvidence(
    input: MaterializeUniversalV1FakeProviderAccountFactInput
  ): Promise<UniversalV1FakeProviderAccountFact> {
    assertInput(input);
    const subject = normalizeProviderSubject(input.providerSubject);
    try {
      return await this.database.serializableTransaction(async (query) => {
        await query(
          `SELECT pg_advisory_xact_lock(
             hashtext('universal-v1-fake-provider-account-v1'), hashtext($1)
           )`,
          [subject.lockKey]
        );

        const occupiedEvidence = await query<ProviderAccountFactRow>(
          `SELECT ${FACT_SELECT}
           FROM public.universal_v1_fake_provider_account_facts fact
           JOIN public.hxos_fake_financial_operation_events_v1 onboard_event
             ON onboard_event.event_id = fact.onboard_fake_event_id
          WHERE fact.refresh_command_id = $1
             OR fact.refresh_dispatch_attempt_id = $2
             OR fact.refresh_outcome_fact_id = $3
             OR fact.refresh_fake_event_id = $4
          ORDER BY fact.provider_account_fact_id
          FOR UPDATE OF fact`,
          [
            input.refresh.commandId,
            input.refresh.dispatchAttemptId,
            input.refresh.outcomeFactId,
            input.refresh.fakeOperationEventId,
          ]
        );
        if (occupiedEvidence.rows.length > 0) {
          if (occupiedEvidence.rows.length !== 1) {
            throw new UniversalV1FakeProviderAccountRepositoryError('EVIDENCE_CONFLICT');
          }
          const replay = factFromRow(occupiedEvidence.rows[0]!, true);
          if (!sameMaterialization(replay, input)) {
            throw new UniversalV1FakeProviderAccountRepositoryError('EVIDENCE_CONFLICT');
          }
          return replay;
        }

        const latestResult = await query<{
          provider_account_fact_id: string;
          account_version: number | string;
        }>(
          `SELECT fact.provider_account_fact_id, fact.account_version
           FROM public.universal_v1_fake_provider_account_facts fact
          WHERE fact.provider_subject_kind = $1
            AND fact.provider_user_id IS NOT DISTINCT FROM $2::UUID
            AND fact.provider_organization_id IS NOT DISTINCT FROM $3::UUID
          ORDER BY fact.account_version DESC
          LIMIT 1
          FOR UPDATE OF fact`,
          [subject.kind, subject.userId, subject.organizationId]
        );
        const latest = latestResult.rows[0];
        const latestVersion = latest ? Number(latest.account_version) : 0;
        if (!Number.isSafeInteger(latestVersion) || latestVersion < 0) {
          throw new UniversalV1FakeProviderAccountRepositoryError('PERSISTENCE_IDENTITY_MISMATCH');
        }

        const inserted = await query<{ provider_account_fact_id: string }>(
          `INSERT INTO public.universal_v1_fake_provider_account_facts (
           provider_subject_kind,
           provider_user_id,
           provider_organization_id,
           onboard_command_id,
           onboard_dispatch_attempt_id,
           onboard_outcome_fact_id,
           onboard_fake_event_id,
           refresh_command_id,
           refresh_dispatch_attempt_id,
           refresh_outcome_fact_id,
           refresh_fake_event_id,
           recorded_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING provider_account_fact_id`,
          [
            subject.kind,
            subject.userId,
            subject.organizationId,
            input.onboard.commandId,
            input.onboard.dispatchAttemptId,
            input.onboard.outcomeFactId,
            input.onboard.fakeOperationEventId,
            input.refresh.commandId,
            input.refresh.dispatchAttemptId,
            input.refresh.outcomeFactId,
            input.refresh.fakeOperationEventId,
            input.recordedBy,
          ]
        );
        const insertedId = inserted.rows[0]?.provider_account_fact_id;
        if (!insertedId || !UUID.test(insertedId)) {
          throw new UniversalV1FakeProviderAccountRepositoryError('PERSISTENCE_INCOMPLETE');
        }
        const row = await selectFactById(query, insertedId);
        if (!row) {
          throw new UniversalV1FakeProviderAccountRepositoryError('PERSISTENCE_INCOMPLETE');
        }
        const fact = factFromRow(row, false);
        if (
          !sameMaterialization(fact, input) ||
          fact.accountVersion !== latestVersion + 1 ||
          fact.supersedesFactId !== (latest?.provider_account_fact_id ?? null)
        ) {
          throw new UniversalV1FakeProviderAccountRepositoryError('PERSISTENCE_IDENTITY_MISMATCH');
        }
        return fact;
      });
    } catch (error) {
      normalizeMaterializationPersistenceError(error);
    }
  }

  async findLatestPayoutReady(input: {
    readonly providerSubject: UniversalV1FakeProviderAccountSubject;
  }): Promise<UniversalV1FakeProviderAccountFact | null> {
    return selectLatestPayoutReady(this.database.query, input, false);
  }

  findLatestPayoutReadyInTransaction(
    query: QueryFn,
    input: {
      readonly providerSubject: UniversalV1FakeProviderAccountSubject;
    }
  ): Promise<UniversalV1FakeProviderAccountFact | null> {
    return selectLatestPayoutReady(query, input, true);
  }

  findPinnedPayoutReadyInTransaction(
    query: QueryFn,
    input: {
      readonly providerAccountFactId: string;
      readonly providerSubject: UniversalV1FakeProviderAccountSubject;
    }
  ): Promise<UniversalV1FakeProviderAccountFact | null> {
    return selectPinnedPayoutReady(query, input);
  }
}
