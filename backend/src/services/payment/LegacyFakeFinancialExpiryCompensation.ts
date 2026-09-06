import { createHash } from 'node:crypto';

import { db, type Database } from '../../db.js';
import {
  FakeFinancialProvider,
  type FakeFinancialOperationRepository,
} from './FakeFinancialProvider.js';
import { canonicalFinancialProviderRequestSha256 } from './FinancialProviderCommandJournal.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface LegacyFakeFinancialExpiryCompensationCandidate {
  readonly sourceEventId: string;
  readonly sourceOperationId: string;
  readonly sourceOperationKind: 'AUTHORIZE' | 'SECURE' | 'ADJUST';
  readonly amountCents: number;
  readonly currency: string;
}

export interface LegacyFakeFinancialExpiryCompensationReceipt {
  readonly sourceEventId: string;
  readonly compensationEventId: string;
  readonly compensationOperationId: string;
  readonly compensationOperationKind: 'VOID' | 'REVERSAL';
  readonly compensationProviderState: 'VOIDED' | 'REVERSED';
  readonly commandId: string;
  readonly dispatchAttemptId: string;
  readonly outcomeFactId: string;
  readonly idempotencyReplayed: boolean;
}

export interface LegacyFakeFinancialExpiryCompensationCommand {
  readonly commandId: string;
  readonly sourceEventId: string;
  readonly compensationOperationId: string;
  readonly compensationOperationKind: 'VOID' | 'REVERSAL';
  readonly compensationIdempotencyKey: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly providerRequestSha256: string;
  readonly idempotencyReplayed: boolean;
}

export interface LegacyFakeFinancialExpiryCompensationAttempt {
  readonly dispatchAttemptId: string;
  readonly commandId: string;
  readonly idempotencyReplayed: boolean;
}

export interface LegacyFakeFinancialExpiryCompensationRepository {
  findRequired(limit: number): Promise<readonly LegacyFakeFinancialExpiryCompensationCandidate[]>;
  prepareCommand(
    sourceEventId: string,
    providerRequestSha256: string
  ): Promise<LegacyFakeFinancialExpiryCompensationCommand>;
  recordDispatchAttempt(commandId: string): Promise<LegacyFakeFinancialExpiryCompensationAttempt>;
  recordCompensation(
    sourceEventId: string,
    compensationEventId: string,
    commandId: string,
    dispatchAttemptId: string
  ): Promise<LegacyFakeFinancialExpiryCompensationReceipt>;
}

interface CandidateRow {
  source_event_id: string;
  source_operation_id: string;
  source_operation_kind: 'AUTHORIZE' | 'SECURE' | 'ADJUST';
  amount_cents: string | number | null;
  currency: string | null;
}

interface ReceiptRow {
  source_fake_operation_event_id: string;
  compensation_fake_operation_event_id: string;
  compensation_operation_id: string;
  compensation_operation_kind: 'VOID' | 'REVERSAL';
  compensation_provider_state: 'VOIDED' | 'REVERSED';
  compensation_command_id: string;
  dispatch_attempt_id: string;
  outcome_fact_id: string;
}

interface CommandRow {
  command_id: string;
  source_fake_operation_event_id: string;
  compensation_operation_id: string;
  compensation_operation_kind: 'VOID' | 'REVERSAL';
  compensation_idempotency_key: string;
  amount_cents: string | number;
  currency: string;
  provider_request_sha256: string;
  idempotency_replayed: boolean;
}

interface AttemptRow {
  dispatch_attempt_id: string;
  command_id: string;
  idempotency_replayed: boolean;
}

interface ReceiptFunctionRow extends ReceiptRow {
  idempotency_replayed: boolean;
}

const RECEIPT_SELECT = `
  source_fake_operation_event_id,
  compensation_fake_operation_event_id,
  compensation_operation_id,
  compensation_operation_kind,
  compensation_provider_state,
  compensation_command_id,
  dispatch_attempt_id,
  outcome_fact_id
`;

function mapReceipt(
  row: ReceiptRow,
  idempotencyReplayed: boolean
): LegacyFakeFinancialExpiryCompensationReceipt {
  return {
    sourceEventId: row.source_fake_operation_event_id,
    compensationEventId: row.compensation_fake_operation_event_id,
    compensationOperationId: row.compensation_operation_id,
    compensationOperationKind: row.compensation_operation_kind,
    compensationProviderState: row.compensation_provider_state,
    commandId: row.compensation_command_id,
    dispatchAttemptId: row.dispatch_attempt_id,
    outcomeFactId: row.outcome_fact_id,
    idempotencyReplayed,
  };
}

export class PostgresLegacyFakeFinancialExpiryCompensationRepository implements LegacyFakeFinancialExpiryCompensationRepository {
  constructor(private readonly database: Database = db) {}

  async findRequired(
    limit: number
  ): Promise<readonly LegacyFakeFinancialExpiryCompensationCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_LIMIT_INVALID');
    }
    const result = await this.database.query<CandidateRow>(
      `SELECT disposition.fake_operation_event_id AS source_event_id,
              raw.operation_id AS source_operation_id,
              raw.operation_kind AS source_operation_kind,
              raw.amount_cents,
              raw.currency
         FROM public.hxos_fake_financial_legacy_expiry_dispositions_v9 disposition
         JOIN public.hxos_fake_financial_operation_events_v1 raw
           ON raw.event_id = disposition.fake_operation_event_id
         LEFT JOIN public.hxos_fake_financial_legacy_expiry_compensations_v9 compensation
           ON compensation.source_fake_operation_event_id = disposition.fake_operation_event_id
         LEFT JOIN public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10 terminal
           ON terminal.source_fake_operation_event_id = disposition.fake_operation_event_id
        WHERE disposition.disposition = 'LEGACY_EXPIRY_UNPROVEN'
          AND disposition.recovery_state = 'COMPENSATION_REQUIRED'
          AND disposition.recovery_terminal = FALSE
          AND disposition.recovery_retryable = TRUE
          AND compensation.source_fake_operation_event_id IS NULL
          AND terminal.source_fake_operation_event_id IS NULL
          AND raw.state = 'SUCCEEDED'
          AND raw.operation_kind IN ('AUTHORIZE', 'SECURE', 'ADJUST')
          AND raw.expires_at IS NULL
          AND raw.amount_cents IS NOT NULL
          AND raw.amount_cents > 0
          AND raw.amount_cents <= 9007199254740991
          AND raw.currency IS NOT NULL
          AND raw.currency ~ '^[a-z]{3}$'
        ORDER BY disposition.classified_at, disposition.fake_operation_event_id
        LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => {
      if (row.amount_cents === null || row.currency === null) {
        throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_CANDIDATE_INVALID');
      }
      const amountCents = Number(row.amount_cents);
      if (
        !UUID.test(row.source_event_id) ||
        !UUID.test(row.source_operation_id) ||
        !['AUTHORIZE', 'SECURE', 'ADJUST'].includes(row.source_operation_kind) ||
        !Number.isSafeInteger(amountCents) ||
        amountCents <= 0 ||
        !/^[a-z]{3}$/u.test(row.currency)
      ) {
        throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_CANDIDATE_INVALID');
      }
      return {
        sourceEventId: row.source_event_id,
        sourceOperationId: row.source_operation_id,
        sourceOperationKind: row.source_operation_kind,
        amountCents,
        currency: row.currency,
      };
    });
  }

  async prepareCommand(
    sourceEventId: string,
    providerRequestSha256: string
  ): Promise<LegacyFakeFinancialExpiryCompensationCommand> {
    if (!UUID.test(sourceEventId) || !/^[0-9a-f]{64}$/u.test(providerRequestSha256)) {
      throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_COMMAND_INVALID');
    }
    const result = await this.database.query<CommandRow>(
      `SELECT command_id, source_fake_operation_event_id,
              compensation_operation_id, compensation_operation_kind,
              compensation_idempotency_key, amount_cents, currency,
              provider_request_sha256, idempotency_replayed
         FROM public.hxos_prepare_legacy_expiry_compensation_v10($1::uuid, $2::text)`,
      [sourceEventId, providerRequestSha256]
    );
    const row = result.rows[0];
    if (!row || row.provider_request_sha256 !== providerRequestSha256) {
      throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_COMMAND_CONFLICT');
    }
    const amountCents = Number(row.amount_cents);
    if (
      !UUID.test(row.command_id) ||
      !UUID.test(row.source_fake_operation_event_id) ||
      !UUID.test(row.compensation_operation_id) ||
      !Number.isSafeInteger(amountCents) ||
      amountCents <= 0 ||
      !/^[a-z]{3}$/u.test(row.currency)
    ) {
      throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_COMMAND_INVALID');
    }
    return {
      commandId: row.command_id,
      sourceEventId: row.source_fake_operation_event_id,
      compensationOperationId: row.compensation_operation_id,
      compensationOperationKind: row.compensation_operation_kind,
      compensationIdempotencyKey: row.compensation_idempotency_key,
      amountCents,
      currency: row.currency,
      providerRequestSha256: row.provider_request_sha256,
      idempotencyReplayed: row.idempotency_replayed,
    };
  }

  async recordDispatchAttempt(
    commandId: string
  ): Promise<LegacyFakeFinancialExpiryCompensationAttempt> {
    if (!UUID.test(commandId)) {
      throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_ATTEMPT_INVALID');
    }
    const result = await this.database.query<AttemptRow>(
      `SELECT dispatch_attempt_id, command_id, idempotency_replayed
         FROM public.hxos_record_legacy_expiry_compensation_attempt_v10($1::uuid)`,
      [commandId]
    );
    if (!result.rows[0]) {
      throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_ATTEMPT_MISSING');
    }
    return {
      dispatchAttemptId: result.rows[0].dispatch_attempt_id,
      commandId: result.rows[0].command_id,
      idempotencyReplayed: result.rows[0].idempotency_replayed,
    };
  }

  async recordCompensation(
    sourceEventId: string,
    compensationEventId: string,
    commandId: string,
    dispatchAttemptId: string
  ): Promise<LegacyFakeFinancialExpiryCompensationReceipt> {
    if (
      !UUID.test(sourceEventId) ||
      !UUID.test(compensationEventId) ||
      !UUID.test(commandId) ||
      !UUID.test(dispatchAttemptId)
    ) {
      throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_IDENTITY_INVALID');
    }
    const result = await this.database.query<ReceiptFunctionRow>(
      `SELECT ${RECEIPT_SELECT}, idempotency_replayed
         FROM public.hxos_finalize_legacy_expiry_compensation_v10(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid
         )`,
      [sourceEventId, compensationEventId, commandId, dispatchAttemptId]
    );
    if (!result.rows[0]) {
      throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_INSERT_MISSING');
    }
    return mapReceipt(result.rows[0], result.rows[0].idempotency_replayed);
  }
}

function deterministicCompensationOperationId(sourceEventId: string): string {
  const digest = createHash('sha256')
    .update(`hustlexp:legacy-fake-expiry-compensation:v9:${sourceEventId.toLowerCase()}`, 'utf8')
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function compensationIdempotencyKey(sourceEventId: string): string {
  return `legacy-expiry-compensation:v9:${sourceEventId.toLowerCase()}`;
}

export interface LegacyFakeFinancialExpiryCompensationRunResult {
  readonly attempted: number;
  readonly compensated: number;
  readonly replayed: number;
}

/**
 * Fake-only, nonproduction containment for a pre-v9 raw success that cannot be
 * converted into positive lifecycle authority. The append-only v9 bridge is
 * the terminal fact; no canonical positive security event is ever created.
 */
export class LegacyFakeFinancialExpiryCompensationWorker {
  constructor(
    private readonly repository: LegacyFakeFinancialExpiryCompensationRepository,
    private readonly provider: FakeFinancialProvider,
    private readonly fakeEvents: Pick<FakeFinancialOperationRepository, 'findByIdempotencyKey'>,
    private readonly assertAuthorized: () => void
  ) {}

  async runOnce(limit = 20): Promise<LegacyFakeFinancialExpiryCompensationRunResult> {
    this.assertAuthorized();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_LIMIT_INVALID');
    }
    // One deterministic breaker slot lets a failed first candidate yield to
    // later eligible work without making the scan unbounded. A clean batch
    // still executes no more than `limit` candidates.
    const scanLimit = Math.min(limit + 1, 50);
    const candidates = await this.repository.findRequired(scanLimit);
    if (candidates.length > scanLimit) {
      throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_BATCH_INVALID');
    }
    let attempted = 0;
    let compensated = 0;
    let replayed = 0;
    const failures: unknown[] = [];
    for (const candidate of candidates) {
      if (compensated + replayed >= limit) break;
      this.assertAuthorized();
      attempted += 1;
      try {
        const operationId = deterministicCompensationOperationId(candidate.sourceEventId);
        const idempotencyKey = compensationIdempotencyKey(candidate.sourceEventId);
        const command = {
          operationId,
          idempotencyKey,
          expectedVersion: 0,
          amountCents: candidate.amountCents,
          currency: candidate.currency,
          relatedOperationId: candidate.sourceOperationId,
        } as const;
        const providerRequestSha256 = canonicalFinancialProviderRequestSha256(command);
        const prepared = await this.repository.prepareCommand(
          candidate.sourceEventId,
          providerRequestSha256
        );
        const expectedKind = candidate.sourceOperationKind === 'ADJUST' ? 'REVERSAL' : 'VOID';
        const expectedState = expectedKind === 'REVERSAL' ? 'REVERSED' : 'VOIDED';
        if (
          prepared.sourceEventId !== candidate.sourceEventId ||
          prepared.compensationOperationId !== operationId ||
          prepared.compensationOperationKind !== expectedKind ||
          prepared.compensationIdempotencyKey !== idempotencyKey ||
          prepared.amountCents !== candidate.amountCents ||
          prepared.currency !== candidate.currency ||
          prepared.providerRequestSha256 !== providerRequestSha256
        ) {
          throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_COMMAND_INVALID');
        }
        const attempt = await this.repository.recordDispatchAttempt(prepared.commandId);
        if (attempt.commandId !== prepared.commandId) {
          throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_ATTEMPT_INVALID');
        }
        const result =
          candidate.sourceOperationKind === 'ADJUST'
            ? await this.provider.reverse(command)
            : await this.provider.void(command);
        if (
          result.operationId !== operationId ||
          result.operationKind !== expectedKind ||
          result.state !== expectedState ||
          result.expiresAt !== null ||
          result.expiryDisposition !== undefined
        ) {
          throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_PROVIDER_RESULT_INVALID');
        }
        const exactEvent = await this.fakeEvents.findByIdempotencyKey(idempotencyKey);
        if (
          !exactEvent ||
          exactEvent.operationId !== operationId ||
          exactEvent.operationKind !== expectedKind ||
          exactEvent.state !== expectedState ||
          exactEvent.relatedOperationId !== candidate.sourceOperationId
        ) {
          throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_EVENT_MISSING');
        }
        const receipt = await this.repository.recordCompensation(
          candidate.sourceEventId,
          exactEvent.eventId,
          prepared.commandId,
          attempt.dispatchAttemptId
        );
        if (
          receipt.compensationOperationId !== operationId ||
          receipt.compensationOperationKind !== expectedKind ||
          receipt.compensationProviderState !== expectedState ||
          receipt.commandId !== prepared.commandId ||
          receipt.dispatchAttemptId !== attempt.dispatchAttemptId
        ) {
          throw new Error('LEGACY_FAKE_EXPIRY_COMPENSATION_BRIDGE_INVALID');
        }
        if (receipt.idempotencyReplayed) replayed += 1;
        else compensated += 1;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'LEGACY_FAKE_EXPIRY_COMPENSATION_BATCH_INCOMPLETE');
    }
    return { attempted, compensated, replayed };
  }
}
