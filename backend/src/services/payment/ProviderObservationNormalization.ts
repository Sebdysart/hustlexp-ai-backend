import { db, type Database } from '../../db.js';
import type {
  ProviderFinancialObservationState,
  SyntheticFinancialObservation,
} from './SyntheticFinancialCommandSchemas.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ProviderObservationMaterializationState =
  | 'RESERVED'
  | 'TERMINAL_CORROBORATED';

export type ProviderObservationNormalizationErrorReason =
  | 'OBSERVATION_INVALID'
  | 'AUTHORITY_REFUSED'
  | 'PERSISTENCE_INCOMPLETE';

export class ProviderObservationNormalizationError extends Error {
  constructor(readonly reason: ProviderObservationNormalizationErrorReason) {
    super(`PROVIDER_OBSERVATION_NORMALIZATION_${reason}`);
    this.name = 'ProviderObservationNormalizationError';
  }
}

export interface ProviderObservationNormalizationResult {
  readonly normalizationId: string;
  readonly observationId: string;
  readonly commandId: string;
  readonly dispatchAttemptId: string;
  readonly outcomeFactId: string | null;
  readonly operationId: string;
  readonly operationKind: SyntheticFinancialObservation['operationKind'];
  readonly providerKind: 'FAKE';
  readonly predecessorProviderVersion: number;
  readonly version: number;
  readonly state: ProviderFinancialObservationState;
  readonly amountCents: number | null;
  readonly currency: string | null;
  readonly materializationState: ProviderObservationMaterializationState;
  readonly providerOccurredAt: string;
  readonly normalizedAt: string;
  readonly followupDueAt: string | null;
  readonly expiresAt: string | null;
  readonly idempotencyReplayed: boolean;
}

export interface ProviderObservationNormalizationRepository {
  normalizeAuthenticatedObservation(
    observationId: string,
  ): Promise<ProviderObservationNormalizationResult>;
}

interface FunctionReceiptRow {
  receipt: {
    normalizationId?: unknown;
    idempotencyReplayed?: unknown;
  };
}

interface NormalizationRow {
  normalization_id: string;
  observation_id: string;
  command_id: string;
  dispatch_attempt_id: string;
  outcome_fact_id: string | null;
  operation_id: string;
  operation_kind: SyntheticFinancialObservation['operationKind'];
  provider_kind: 'FAKE';
  predecessor_provider_version: string | number;
  observed_provider_version: string | number;
  observed_state: ProviderFinancialObservationState;
  amount_cents: string | number | null;
  currency: string | null;
  materialization_state: ProviderObservationMaterializationState;
  provider_occurred_at: Date | string;
  normalized_at: Date | string;
  followup_due_at: Date | string | null;
  expires_at: Date | string | null;
}

function safeInteger(value: string | number): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new ProviderObservationNormalizationError('PERSISTENCE_INCOMPLETE');
  }
  return numeric;
}

function iso(value: Date | string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ProviderObservationNormalizationError('PERSISTENCE_INCOMPLETE');
  }
  return date.toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function databaseRefused(error: unknown): boolean {
  return error instanceof Error && error.message.includes('HXFON1:');
}

/**
 * Resolves authenticated bytes entirely inside PostgreSQL. The database
 * function derives every observation field from the immutable raw inbox and
 * will only bind it to an already committed command and dispatch attempt. It
 * never calls a provider adapter and never inserts a lifecycle success.
 */
export class PostgresProviderObservationNormalizationRepository
implements ProviderObservationNormalizationRepository {
  constructor(private readonly database: Database = db) {}

  async normalizeAuthenticatedObservation(
    observationId: string,
  ): Promise<ProviderObservationNormalizationResult> {
    if (!UUID.test(observationId)) {
      throw new ProviderObservationNormalizationError('OBSERVATION_INVALID');
    }
    try {
      return await this.database.transaction(async (query) => {
        const receiptResult = await query<FunctionReceiptRow>(
          `SELECT public.normalize_financial_provider_observation_v1($1::uuid) AS receipt`,
          [observationId.toLowerCase()],
        );
        const receipt = receiptResult.rows[0]?.receipt;
        const normalizationId = receipt?.normalizationId;
        if (typeof normalizationId !== 'string' || !UUID.test(normalizationId)) {
          throw new ProviderObservationNormalizationError('PERSISTENCE_INCOMPLETE');
        }
        const result = await query<NormalizationRow>(
          `SELECT normalization_id, observation_id, command_id,
                  dispatch_attempt_id, outcome_fact_id, operation_id,
                  operation_kind, provider_kind, predecessor_provider_version,
                  observed_provider_version, observed_state, amount_cents,
                  currency, materialization_state, provider_occurred_at,
                  normalized_at, followup_due_at, expires_at
             FROM public.provider_financial_observation_normalizations
            WHERE normalization_id=$1`,
          [normalizationId],
        );
        const row = result.rows[0];
        if (!row || result.rows.length !== 1) {
          throw new ProviderObservationNormalizationError('PERSISTENCE_INCOMPLETE');
        }
        return {
          normalizationId: row.normalization_id,
          observationId: row.observation_id,
          commandId: row.command_id,
          dispatchAttemptId: row.dispatch_attempt_id,
          outcomeFactId: row.outcome_fact_id,
          operationId: row.operation_id,
          operationKind: row.operation_kind,
          providerKind: row.provider_kind,
          predecessorProviderVersion: safeInteger(row.predecessor_provider_version),
          version: safeInteger(row.observed_provider_version),
          state: row.observed_state,
          amountCents: row.amount_cents === null ? null : safeInteger(row.amount_cents),
          currency: row.currency,
          materializationState: row.materialization_state,
          providerOccurredAt: iso(row.provider_occurred_at),
          normalizedAt: iso(row.normalized_at),
          followupDueAt: nullableIso(row.followup_due_at),
          expiresAt: nullableIso(row.expires_at),
          idempotencyReplayed: receipt.idempotencyReplayed === true,
        };
      });
    } catch (error) {
      if (error instanceof ProviderObservationNormalizationError) throw error;
      if (databaseRefused(error)) {
        throw new ProviderObservationNormalizationError('AUTHORITY_REFUSED');
      }
      throw new ProviderObservationNormalizationError('PERSISTENCE_INCOMPLETE');
    }
  }
}
