import { createHash } from 'node:crypto';

import { buildIdentity, type BuildIdentity } from '../../buildIdentity.js';
import { db, type Database } from '../../db.js';
import { readReleaseManifest, type ReleaseManifestEvidence } from '../../releaseManifest.js';
import type {
  AdjustmentAuthorizationCommand,
  AuthorizeFinancialSecurityCommand,
  FinancialOperationCommand,
  FinancialOperationKind,
  FinancialOperationResult,
  FinancialOperationState,
  FinancialProviderPorts,
  PayoutCommand,
  ProviderAccountStateCommand,
  ProviderAccountStateResult,
  PreparePaymentMethodCommand,
  ProviderOnboardingCommand,
  RefundCommand,
  SecureFinancialSecurityCommand,
  WebhookIngestionCommand,
} from './FinancialProviderPorts.js';
import {
  assertFakeFinancialScenarioSupportsOperation,
  isFakeFinancialScenario,
  type FakeFinancialScenario,
} from './FakeFinancialScenarioPolicy.js';
import { canonicalFinancialProviderRequestSha256 } from './FinancialProviderCommandJournal.js';
import {
  assertNonproductionFakeFinanceAuthorized,
  nonproductionFakeFinanceEnabled,
} from './NonproductionFinancialAuthorization.js';

export type { FakeFinancialScenario } from './FakeFinancialScenarioPolicy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type FakeScenarioInput = { readonly scenario?: FakeFinancialScenario };
type FakeInput<T extends FinancialOperationCommand> = T & FakeScenarioInput;

export interface FakeFinancialRepositoryCommand {
  readonly operationId: string;
  readonly operationKind: FinancialOperationKind;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly scenario: FakeFinancialScenario;
  readonly amountCents: number | null;
  readonly currency: string | null;
  readonly relatedOperationId: string | null;
  readonly externalReference: string;
  readonly state: FinancialOperationState;
  readonly retryable: boolean;
  readonly identitySha256: string;
  readonly requestSha256: string;
  readonly providerRequestSha256: string;
  readonly responseSha256: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface StoredFakeFinancialOperation extends FinancialOperationResult {
  readonly eventId: string;
  readonly scenario: FakeFinancialScenario;
  readonly idempotencyKey: string;
  readonly identitySha256: string;
  readonly requestSha256: string;
  readonly providerRequestSha256: string;
  readonly responseSha256: string;
  readonly relatedOperationId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
}

export interface FakeFinancialOperationRepository {
  execute(command: FakeFinancialRepositoryCommand): Promise<StoredFakeFinancialOperation>;
  /** Read-only exact-event lookup used after a committed dispatch attempt. */
  findByIdempotencyKey(idempotencyKey: string): Promise<StoredFakeFinancialOperation | null>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function deterministicEventId(operationId: string, version: number): string {
  const digest = sha256({ type: 'fake-financial-operation-event', operationId, version });
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function assertCommand(input: FinancialOperationCommand): void {
  if (typeof input.operationId !== 'string' || !UUID.test(input.operationId)) {
    throw new Error('FAKE_FINANCIAL_OPERATION_ID_INVALID');
  }
  if (
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.trim().length < 16 ||
    input.idempotencyKey.length > 160
  ) {
    throw new Error('FAKE_FINANCIAL_IDEMPOTENCY_KEY_INVALID');
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error('FAKE_FINANCIAL_EXPECTED_VERSION_INVALID');
  }
  if (
    input.amountCents !== undefined &&
    (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0)
  ) {
    throw new Error('FAKE_FINANCIAL_AMOUNT_INVALID');
  }
  if (input.currency !== undefined && !/^[a-z]{3}$/.test(input.currency)) {
    throw new Error('FAKE_FINANCIAL_CURRENCY_INVALID');
  }
  if ((input.amountCents === undefined) !== (input.currency === undefined)) {
    throw new Error('FAKE_FINANCIAL_AMOUNT_CURRENCY_PAIR_INVALID');
  }
  if (
    input.relatedOperationId !== undefined &&
    (typeof input.relatedOperationId !== 'string' || !UUID.test(input.relatedOperationId))
  ) {
    throw new Error('FAKE_FINANCIAL_RELATED_OPERATION_ID_INVALID');
  }
}

function assertReference(value: unknown, error: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(error);
}

function externalReference(kind: FinancialOperationKind, operationId: string): string {
  return `fake_${kind.toLowerCase()}_${sha256(operationId).slice(0, 24)}`;
}

function stateFor(
  kind: FinancialOperationKind,
  scenario: FakeFinancialScenario,
  expectedVersion: number,
  authenticated?: boolean
): FinancialOperationState {
  if (kind === 'INGEST_WEBHOOK' && authenticated !== true) return 'REJECTED';
  if (scenario === 'DECLINE') return 'DECLINED';
  if (scenario === 'TIMEOUT') return 'PENDING';
  if (scenario === 'RETRY') return expectedVersion === 0 ? 'RETRYABLE_FAILURE' : 'SUCCEEDED';
  if (
    scenario === 'DELAYED_SETTLEMENT' &&
    ['SETTLE', 'FUND', 'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'].includes(kind)
  ) {
    return expectedVersion === 0 ? 'PENDING' : 'SUCCEEDED';
  }
  if (
    scenario === 'PROVIDER_ACCOUNT_FAILURE' &&
    ['ONBOARD_PROVIDER', 'REFRESH_PROVIDER_ACCOUNT_STATE'].includes(kind)
  )
    return 'FAILED';
  if (scenario === 'RECONCILIATION_MISMATCH' && kind === 'RECONCILE') return 'MISMATCH';
  if (scenario === 'PARTIAL_REFUND' && kind === 'REFUND') return 'PARTIALLY_REFUNDED';
  if (kind === 'REVERSAL') return 'REVERSED';
  if (kind === 'VOID') return 'VOIDED';
  if (kind === 'REFUND') return 'REFUNDED';
  if (kind === 'INGEST_WEBHOOK') return 'ACCEPTED';
  if (kind === 'RECONCILE') return 'MATCHED';
  return 'SUCCEEDED';
}

function retryableFor(state: FinancialOperationState, scenario: FakeFinancialScenario): boolean {
  return state === 'RETRYABLE_FAILURE' || (state === 'PENDING' && scenario === 'TIMEOUT');
}

export class InMemoryFakeFinancialOperationRepository implements FakeFinancialOperationRepository {
  private readonly byIdempotency = new Map<string, StoredFakeFinancialOperation>();
  private readonly latestByOperation = new Map<string, StoredFakeFinancialOperation>();
  private readonly storedEvents: StoredFakeFinancialOperation[] = [];

  async execute(command: FakeFinancialRepositoryCommand): Promise<StoredFakeFinancialOperation> {
    const replay = this.byIdempotency.get(command.idempotencyKey);
    if (replay) {
      if (
        replay.requestSha256 !== command.requestSha256 ||
        replay.providerRequestSha256 !== command.providerRequestSha256
      ) {
        throw new Error('FAKE_FINANCIAL_IDEMPOTENCY_CONFLICT');
      }
      return { ...replay, idempotencyReplayed: true };
    }

    const latest = this.latestByOperation.get(command.operationId);
    const currentVersion = latest?.version ?? 0;
    if (currentVersion !== command.expectedVersion) {
      throw new Error('FAKE_FINANCIAL_VERSION_CONFLICT');
    }
    if (latest && latest.identitySha256 !== command.identitySha256) {
      throw new Error('FAKE_FINANCIAL_OPERATION_IDENTITY_CONFLICT');
    }

    const record: StoredFakeFinancialOperation = {
      eventId: deterministicEventId(command.operationId, currentVersion + 1),
      operationId: command.operationId,
      operationKind: command.operationKind,
      providerKind: 'FAKE',
      state: command.state,
      version: currentVersion + 1,
      amountCents: command.amountCents,
      currency: command.currency,
      externalReference: command.externalReference,
      idempotencyReplayed: false,
      retryable: command.retryable,
      scenario: command.scenario,
      idempotencyKey: command.idempotencyKey,
      identitySha256: command.identitySha256,
      requestSha256: command.requestSha256,
      providerRequestSha256: command.providerRequestSha256,
      responseSha256: command.responseSha256,
      relatedOperationId: command.relatedOperationId,
      metadata: command.metadata,
      recordedAt: new Date().toISOString(),
    };
    this.byIdempotency.set(command.idempotencyKey, record);
    this.latestByOperation.set(command.operationId, record);
    this.storedEvents.push(record);
    return record;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<StoredFakeFinancialOperation | null> {
    const event = this.byIdempotency.get(idempotencyKey);
    return event ? { ...event, metadata: { ...event.metadata } } : null;
  }

  events(): readonly StoredFakeFinancialOperation[] {
    return [...this.storedEvents];
  }
}

interface EventRow {
  event_id: string;
  operation_id: string;
  operation_kind: FinancialOperationKind;
  event_version: number;
  state: FinancialOperationState;
  scenario: FakeFinancialScenario;
  amount_cents: string | number | null;
  currency: string | null;
  related_operation_id: string | null;
  external_reference: string;
  idempotency_key: string;
  identity_sha256: string;
  request_sha256: string;
  provider_request_sha256: string | null;
  response_sha256: string;
  retryable: boolean;
  metadata: Record<string, unknown>;
  recorded_at: Date | string;
}

function mapEventRow(row: EventRow, replayed: boolean): StoredFakeFinancialOperation {
  return {
    eventId: row.event_id,
    operationId: row.operation_id,
    operationKind: row.operation_kind,
    providerKind: 'FAKE',
    state: row.state,
    version: row.event_version,
    amountCents: row.amount_cents == null ? null : Number(row.amount_cents),
    currency: row.currency,
    externalReference: row.external_reference,
    idempotencyReplayed: replayed,
    retryable: row.retryable,
    scenario: row.scenario,
    idempotencyKey: row.idempotency_key,
    identitySha256: row.identity_sha256,
    requestSha256: row.request_sha256,
    providerRequestSha256: row.provider_request_sha256 ?? '',
    responseSha256: row.response_sha256,
    relatedOperationId: row.related_operation_id,
    metadata: row.metadata,
    recordedAt: new Date(row.recorded_at).toISOString(),
  };
}

export class PostgresFakeFinancialOperationRepository implements FakeFinancialOperationRepository {
  constructor(private readonly database: Database = db) {}

  async execute(command: FakeFinancialRepositoryCommand): Promise<StoredFakeFinancialOperation> {
    return this.database.transaction(async (query) => {
      await query(
        `SELECT pg_advisory_xact_lock(hashtext('fake-financial-operation'), hashtext($1))`,
        [command.operationId]
      );
      const replay = await query<EventRow>(
        `SELECT event_id, operation_id, operation_kind, event_version, state, scenario,
                amount_cents, currency, related_operation_id, external_reference,
                idempotency_key, identity_sha256, request_sha256,
                provider_request_sha256, response_sha256,
                retryable, metadata, recorded_at
         FROM hxos_fake_financial_operation_events_v1
         WHERE idempotency_key = $1`,
        [command.idempotencyKey]
      );
      if (replay.rows[0]) {
        if (
          replay.rows[0].request_sha256 !== command.requestSha256 ||
          replay.rows[0].provider_request_sha256 !== command.providerRequestSha256
        ) {
          throw new Error('FAKE_FINANCIAL_IDEMPOTENCY_CONFLICT');
        }
        return mapEventRow(replay.rows[0], true);
      }

      const identity = await query<{ identity_sha256: string }>(
        `SELECT identity_sha256
         FROM hxos_fake_financial_operations_v1
         WHERE operation_id = $1
         FOR UPDATE`,
        [command.operationId]
      );
      const version = await query<{ version: number }>(
        `SELECT COALESCE(MAX(event_version), 0)::INTEGER AS version
         FROM hxos_fake_financial_operation_events_v1
         WHERE operation_id = $1`,
        [command.operationId]
      );
      const currentVersion = version.rows[0]?.version ?? 0;
      if (currentVersion !== command.expectedVersion) {
        throw new Error('FAKE_FINANCIAL_VERSION_CONFLICT');
      }
      if (identity.rows[0] && identity.rows[0].identity_sha256 !== command.identitySha256) {
        throw new Error('FAKE_FINANCIAL_OPERATION_IDENTITY_CONFLICT');
      }
      if (!identity.rows[0]) {
        await query(
          `INSERT INTO hxos_fake_financial_operations_v1
             (operation_id, operation_kind, identity_sha256, external_reference,
              amount_cents, currency, related_operation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            command.operationId,
            command.operationKind,
            command.identitySha256,
            command.externalReference,
            command.amountCents,
            command.currency,
            command.relatedOperationId,
          ]
        );
      }

      const inserted = await query<EventRow>(
        `INSERT INTO hxos_fake_financial_operation_events_v1
           (operation_id, operation_kind, event_version, state, scenario,
            amount_cents, currency, related_operation_id, external_reference,
             idempotency_key, identity_sha256, request_sha256,
             provider_request_sha256, response_sha256, retryable, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
         RETURNING event_id, operation_id, operation_kind, event_version, state, scenario,
                   amount_cents, currency, related_operation_id, external_reference,
                   idempotency_key, identity_sha256, request_sha256,
                   provider_request_sha256, response_sha256,
                   retryable, metadata, recorded_at`,
        [
          command.operationId,
          command.operationKind,
          currentVersion + 1,
          command.state,
          command.scenario,
          command.amountCents,
          command.currency,
          command.relatedOperationId,
          command.externalReference,
          command.idempotencyKey,
          command.identitySha256,
          command.requestSha256,
          command.providerRequestSha256,
          command.responseSha256,
          command.retryable,
          JSON.stringify(command.metadata),
        ]
      );
      return mapEventRow(inserted.rows[0], false);
    });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<StoredFakeFinancialOperation | null> {
    const result = await this.database.query<EventRow>(
      `SELECT event_id, operation_id, operation_kind, event_version, state, scenario,
              amount_cents, currency, related_operation_id, external_reference,
              idempotency_key, identity_sha256, request_sha256,
              provider_request_sha256, response_sha256,
              retryable, metadata, recorded_at
         FROM hxos_fake_financial_operation_events_v1
        WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    const row = result.rows[0];
    return row ? mapEventRow(row, false) : null;
  }
}

function exactRequestObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('FAKE_FINANCIAL_EXACT_EVENT_REQUEST_INVALID');
  }
  return value as Record<string, unknown>;
}

function exactMetadataFor(
  operationKind: FinancialOperationKind,
  exactRequest: Record<string, unknown>
): Readonly<Record<string, unknown>> {
  switch (operationKind) {
    case 'PREPARE_PAYMENT_METHOD':
      return { customerId: exactRequest.customerId };
    case 'AUTHORIZE':
      return { paymentMethodReference: exactRequest.paymentMethodReference };
    case 'SECURE':
      return { authorizationOperationId: exactRequest.authorizationOperationId };
    case 'ADJUST':
      return {
        scopeVersionId: exactRequest.scopeVersionId,
        changeOrderId: exactRequest.changeOrderId,
      };
    case 'REFUND':
      return { originalAmountCents: exactRequest.originalAmountCents };
    case 'ONBOARD_PROVIDER':
      return { providerId: exactRequest.providerId };
    case 'REFRESH_PROVIDER_ACCOUNT_STATE':
      return {
        providerId: exactRequest.providerId,
        providerAccountReference: exactRequest.providerAccountReference,
      };
    case 'PAYOUT':
      return { providerAccountReference: exactRequest.providerAccountReference };
    case 'INGEST_WEBHOOK':
      return {
        providerEventReference: exactRequest.providerEventReference,
        authenticated: exactRequest.authenticated === true,
      };
    default:
      return {};
  }
}

function projectStoredFakeFinancialOperation(
  event: StoredFakeFinancialOperation,
  idempotencyReplayed: boolean
): FinancialOperationResult | ProviderAccountStateResult {
  const base: FinancialOperationResult = {
    operationId: event.operationId,
    operationKind: event.operationKind,
    providerKind: 'FAKE',
    state: event.state,
    version: event.version,
    amountCents: event.amountCents,
    currency: event.currency?.toUpperCase() ?? null,
    externalReference: event.externalReference,
    idempotencyReplayed,
    retryable: event.retryable,
  };
  if (event.operationKind !== 'REFRESH_PROVIDER_ACCOUNT_STATE') return base;
  const providerId = event.metadata.providerId;
  if (typeof providerId !== 'string' || providerId.trim().length === 0) {
    throw new Error('FAKE_FINANCIAL_EXACT_EVENT_METADATA_INVALID');
  }
  const succeeded = event.state === 'SUCCEEDED';
  const failed = event.state === 'FAILED';
  const pending = event.state === 'PENDING' || event.state === 'RETRYABLE_FAILURE';
  return {
    ...base,
    providerId,
    accountState: succeeded ? 'ENABLED' : failed ? 'FAILED' : pending ? 'PENDING' : 'RESTRICTED',
    chargesEnabled: succeeded,
    payoutsEnabled: succeeded,
    requirementsDue: succeeded
      ? []
      : failed
        ? ['identity_verification']
        : pending
          ? ['provider_review']
          : ['provider_account_restricted'],
  };
}

/**
 * Proves that a raw fake-provider event is the exact result of the committed
 * request. This is a read/reconstruction boundary; it never enters an adapter.
 */
export function resultFromExactStoredFakeFinancialOperation(
  event: StoredFakeFinancialOperation,
  operationKind: FinancialOperationKind,
  exactRequestValue: unknown,
  expectedProviderRequestSha256: string,
  idempotencyReplayed = true
): FinancialOperationResult | ProviderAccountStateResult {
  const exactRequest = exactRequestObject(exactRequestValue);
  const scenario = exactRequest.scenario ?? 'SUCCESS';
  if (!isFakeFinancialScenario(scenario)) {
    throw new Error('FAKE_FINANCIAL_EXACT_EVENT_SCENARIO_INVALID');
  }
  assertFakeFinancialScenarioSupportsOperation(scenario, operationKind);
  const operationId = exactRequest.operationId;
  const idempotencyKey = exactRequest.idempotencyKey;
  const expectedVersion = exactRequest.expectedVersion;
  const amountCents = exactRequest.amountCents ?? null;
  const currency = exactRequest.currency ?? null;
  const relatedOperationId = exactRequest.relatedOperationId ?? null;
  if (
    typeof operationId !== 'string' ||
    typeof idempotencyKey !== 'string' ||
    !Number.isSafeInteger(expectedVersion) ||
    (amountCents !== null && !Number.isSafeInteger(amountCents)) ||
    (currency !== null && (typeof currency !== 'string' || !/^[a-z]{3}$/u.test(currency))) ||
    (relatedOperationId !== null && typeof relatedOperationId !== 'string')
  ) {
    throw new Error('FAKE_FINANCIAL_EXACT_EVENT_REQUEST_INVALID');
  }
  const exactExpectedVersion = expectedVersion as number;
  const exactAmountCents = amountCents as number | null;
  const exactCurrency = currency as string | null;
  const exactRelatedOperationId = relatedOperationId as string | null;
  const metadata = exactMetadataFor(operationKind, exactRequest);
  const identity = {
    operationId,
    operationKind,
    providerKind: 'FAKE',
    amountCents: exactAmountCents,
    currency: exactCurrency,
    relatedOperationId: exactRelatedOperationId,
    scenario,
    metadata,
  } as const;
  const request = {
    ...identity,
    idempotencyKey,
    expectedVersion: exactExpectedVersion,
    metadata,
  } as const;
  const expectedState = stateFor(
    operationKind,
    scenario,
    exactExpectedVersion,
    typeof metadata.authenticated === 'boolean' ? metadata.authenticated : undefined
  );
  const response = {
    state: expectedState,
    retryable: retryableFor(expectedState, scenario),
    externalReference: externalReference(operationKind, operationId),
  } as const;
  if (
    event.operationId !== operationId ||
    event.operationKind !== operationKind ||
    event.providerKind !== 'FAKE' ||
    event.idempotencyKey !== idempotencyKey ||
    event.version !== exactExpectedVersion + 1 ||
    event.scenario !== scenario ||
    event.amountCents !== exactAmountCents ||
    event.currency !== exactCurrency ||
    event.relatedOperationId !== exactRelatedOperationId ||
    event.state !== response.state ||
    event.retryable !== response.retryable ||
    event.externalReference !== response.externalReference ||
    event.identitySha256 !== sha256(identity) ||
    event.requestSha256 !== sha256(request) ||
    event.providerRequestSha256 !== expectedProviderRequestSha256 ||
    event.providerRequestSha256 !== canonicalFinancialProviderRequestSha256(exactRequest) ||
    event.responseSha256 !== sha256(response) ||
    sha256(event.metadata) !== sha256(metadata)
  ) {
    throw new Error('FAKE_FINANCIAL_EXACT_EVENT_IDENTITY_MISMATCH');
  }
  return projectStoredFakeFinancialOperation(event, idempotencyReplayed);
}

export class FakeFinancialProvider implements FinancialProviderPorts {
  constructor(private readonly repository: FakeFinancialOperationRepository) {}

  private async execute(
    kind: FinancialOperationKind,
    input: FakeInput<FinancialOperationCommand>,
    metadata: Readonly<Record<string, unknown>> = {}
  ): Promise<FinancialOperationResult> {
    assertCommand(input);
    const scenario = input.scenario ?? 'SUCCESS';
    if (!isFakeFinancialScenario(scenario)) {
      throw new Error('FAKE_FINANCIAL_SCENARIO_INVALID');
    }
    assertFakeFinancialScenarioSupportsOperation(scenario, kind);
    const state = stateFor(
      kind,
      scenario,
      input.expectedVersion,
      typeof metadata.authenticated === 'boolean' ? metadata.authenticated : undefined
    );
    const identity = {
      operationId: input.operationId,
      operationKind: kind,
      providerKind: 'FAKE',
      amountCents: input.amountCents ?? null,
      currency: input.currency ?? null,
      relatedOperationId: input.relatedOperationId ?? null,
      scenario,
      metadata,
    } as const;
    const request = {
      ...identity,
      idempotencyKey: input.idempotencyKey,
      expectedVersion: input.expectedVersion,
      metadata,
    } as const;
    const response = {
      state,
      retryable: retryableFor(state, scenario),
      externalReference: externalReference(kind, input.operationId),
    } as const;
    const stored = await this.repository.execute({
      operationId: input.operationId,
      operationKind: kind,
      idempotencyKey: input.idempotencyKey,
      expectedVersion: input.expectedVersion,
      scenario,
      amountCents: input.amountCents ?? null,
      currency: input.currency ?? null,
      relatedOperationId: input.relatedOperationId ?? null,
      externalReference: response.externalReference,
      state,
      retryable: response.retryable,
      identitySha256: sha256(identity),
      requestSha256: sha256(request),
      providerRequestSha256: canonicalFinancialProviderRequestSha256(input),
      responseSha256: sha256(response),
      metadata,
    });
    return projectStoredFakeFinancialOperation(stored, stored.idempotencyReplayed);
  }

  preparePaymentMethod(
    input: FakeInput<PreparePaymentMethodCommand>
  ): Promise<FinancialOperationResult> {
    assertReference(input.customerId, 'FAKE_FINANCIAL_CUSTOMER_ID_INVALID');
    return this.execute('PREPARE_PAYMENT_METHOD', input, { customerId: input.customerId });
  }

  authorize(
    input: FakeInput<AuthorizeFinancialSecurityCommand>
  ): Promise<FinancialOperationResult> {
    assertReference(
      input.paymentMethodReference,
      'FAKE_FINANCIAL_PAYMENT_METHOD_REFERENCE_INVALID'
    );
    return this.execute('AUTHORIZE', input, {
      paymentMethodReference: input.paymentMethodReference,
    });
  }

  secure(input: FakeInput<SecureFinancialSecurityCommand>): Promise<FinancialOperationResult> {
    assertReference(
      input.authorizationOperationId,
      'FAKE_FINANCIAL_AUTHORIZATION_OPERATION_ID_INVALID'
    );
    return this.execute('SECURE', input, {
      authorizationOperationId: input.authorizationOperationId,
    });
  }

  void(input: FakeInput<FinancialOperationCommand>): Promise<FinancialOperationResult> {
    return this.execute('VOID', input);
  }

  adjust(input: FakeInput<AdjustmentAuthorizationCommand>): Promise<FinancialOperationResult> {
    assertReference(input.scopeVersionId, 'FAKE_FINANCIAL_SCOPE_VERSION_ID_INVALID');
    assertReference(input.changeOrderId, 'FAKE_FINANCIAL_CHANGE_ORDER_ID_INVALID');
    return this.execute('ADJUST', input, {
      scopeVersionId: input.scopeVersionId,
      changeOrderId: input.changeOrderId,
    });
  }

  capture(input: FakeInput<FinancialOperationCommand>): Promise<FinancialOperationResult> {
    return this.execute('CAPTURE', input);
  }

  refund(input: FakeInput<RefundCommand>): Promise<FinancialOperationResult> {
    if (
      !Number.isSafeInteger(input.originalAmountCents) ||
      input.originalAmountCents <= 0 ||
      input.amountCents === undefined ||
      input.amountCents > input.originalAmountCents
    ) {
      throw new Error('FAKE_FINANCIAL_REFUND_AMOUNT_INVALID');
    }
    return this.execute('REFUND', input, { originalAmountCents: input.originalAmountCents });
  }

  reverse(input: FakeInput<FinancialOperationCommand>): Promise<FinancialOperationResult> {
    return this.execute('REVERSAL', input);
  }

  onboardProvider(input: FakeInput<ProviderOnboardingCommand>): Promise<FinancialOperationResult> {
    assertReference(input.providerId, 'FAKE_FINANCIAL_PROVIDER_ID_INVALID');
    return this.execute('ONBOARD_PROVIDER', input, { providerId: input.providerId });
  }

  async refreshProviderAccountState(
    input: FakeInput<ProviderAccountStateCommand>
  ): Promise<ProviderAccountStateResult> {
    assertReference(input.providerId, 'FAKE_FINANCIAL_PROVIDER_ID_INVALID');
    assertReference(
      input.providerAccountReference,
      'FAKE_FINANCIAL_PROVIDER_ACCOUNT_REFERENCE_INVALID'
    );
    const result = await this.execute('REFRESH_PROVIDER_ACCOUNT_STATE', input, {
      providerId: input.providerId,
      providerAccountReference: input.providerAccountReference,
    });
    return result as ProviderAccountStateResult;
  }

  settle(input: FakeInput<FinancialOperationCommand>): Promise<FinancialOperationResult> {
    return this.execute('SETTLE', input);
  }

  fund(input: FakeInput<FinancialOperationCommand>): Promise<FinancialOperationResult> {
    return this.execute('FUND', input);
  }

  releaseProvider(input: FakeInput<FinancialOperationCommand>): Promise<FinancialOperationResult> {
    return this.execute('PROVIDER_RELEASE', input);
  }

  payout(input: FakeInput<PayoutCommand>): Promise<FinancialOperationResult> {
    assertReference(
      input.providerAccountReference,
      'FAKE_FINANCIAL_PROVIDER_ACCOUNT_REFERENCE_INVALID'
    );
    return this.execute('PAYOUT', input, {
      providerAccountReference: input.providerAccountReference,
    });
  }

  observeBankSettlement(
    input: FakeInput<FinancialOperationCommand>
  ): Promise<FinancialOperationResult> {
    return this.execute('OBSERVE_BANK_SETTLEMENT', input);
  }

  ingestWebhook(input: FakeInput<WebhookIngestionCommand>): Promise<FinancialOperationResult> {
    assertReference(
      input.providerEventReference,
      'FAKE_FINANCIAL_PROVIDER_EVENT_REFERENCE_INVALID'
    );
    return this.execute('INGEST_WEBHOOK', input, {
      providerEventReference: input.providerEventReference,
      authenticated: input.authenticated === true,
    });
  }

  reconcile(input: FakeInput<FinancialOperationCommand>): Promise<FinancialOperationResult> {
    return this.execute('RECONCILE', input);
  }
}

export function createDatabaseBackedFakeFinancialProvider(
  database: Database = db,
  environment: NodeJS.ProcessEnv = process.env,
  release: ReleaseManifestEvidence = readReleaseManifest(),
  identity: BuildIdentity = buildIdentity
): FakeFinancialProvider {
  const component =
    environment.SERVICE_ROLE?.trim().toLowerCase() === 'worker' ? 'worker' : 'backend';
  assertNonproductionFakeFinanceAuthorized({
    env: environment,
    release,
    identity,
    component,
  });
  return new FakeFinancialProvider(new PostgresFakeFinancialOperationRepository(database));
}

export function fakeFinancialProviderEnabled(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  release: ReleaseManifestEvidence = readReleaseManifest(),
  identity: BuildIdentity = buildIdentity
): boolean {
  const component =
    environment.SERVICE_ROLE?.trim().toLowerCase() === 'worker' ? 'worker' : 'backend';
  return nonproductionFakeFinanceEnabled({
    env: environment,
    release,
    identity,
    component,
  });
}
