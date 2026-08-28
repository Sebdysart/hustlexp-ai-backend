import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  FakeFinancialProvider,
  InMemoryFakeFinancialOperationRepository,
  fakeFinancialProviderEnabled,
  type FakeFinancialScenario,
} from '../../src/services/payment/FakeFinancialProvider.js';

const operationIds = {
  paymentMethod: '00000000-0000-4000-8000-000000000001',
  authorize: '00000000-0000-4000-8000-000000000002',
  capture: '00000000-0000-4000-8000-000000000003',
  refund: '00000000-0000-4000-8000-000000000004',
  settlement: '00000000-0000-4000-8000-000000000005',
  payout: '00000000-0000-4000-8000-000000000006',
  webhook: '00000000-0000-4000-8000-000000000007',
  reconciliation: '00000000-0000-4000-8000-000000000008',
  merchant: '00000000-0000-4000-8000-000000000009',
  merchantState: '00000000-0000-4000-8000-000000000010',
  funding: '00000000-0000-4000-8000-000000000011',
  providerRelease: '00000000-0000-4000-8000-000000000012',
  bankSettlement: '00000000-0000-4000-8000-000000000013',
} as const;

function command(
  operationId: string,
  idempotencyKey: string,
  scenario: FakeFinancialScenario = 'SUCCESS'
) {
  return {
    operationId,
    idempotencyKey,
    expectedVersion: 0,
    scenario,
    amountCents: 12_500,
    currency: 'usd',
  } as const;
}

describe('FakeFinancialProvider', () => {
  it('executes the provider-neutral lifecycle without exposing a processor contract', async () => {
    const provider = new FakeFinancialProvider(new InMemoryFakeFinancialOperationRepository());

    const paymentMethod = await provider.preparePaymentMethod({
      ...command(operationIds.paymentMethod, 'test:payment-method:0001'),
      customerId: 'customer-1',
    });
    const authorization = await provider.authorize({
      ...command(operationIds.authorize, 'test:authorize:0001'),
      paymentMethodReference: paymentMethod.externalReference,
    });
    const capture = await provider.capture({
      ...command(operationIds.capture, 'test:capture:0001'),
      relatedOperationId: authorization.operationId,
    });
    const refund = await provider.refund({
      ...command(operationIds.refund, 'test:refund:0001'),
      relatedOperationId: capture.operationId,
      amountCents: 2_500,
      originalAmountCents: 12_500,
      scenario: 'PARTIAL_REFUND',
    });
    const settlement = await provider.settle({
      ...command(operationIds.settlement, 'test:settlement:0001'),
      relatedOperationId: capture.operationId,
    });
    const funding = await provider.fund({
      ...command(operationIds.funding, 'test:funding:0001'),
      relatedOperationId: settlement.operationId,
    });
    const providerRelease = await provider.releaseProvider({
      ...command(operationIds.providerRelease, 'test:provider-release:0001'),
      relatedOperationId: funding.operationId,
      amountCents: 10_000,
    });
    const payout = await provider.payout({
      ...command(operationIds.payout, 'test:payout:0001'),
      relatedOperationId: providerRelease.operationId,
      amountCents: 10_000,
      providerAccountReference: 'merchant-fake-1',
    });
    const bankSettlement = await provider.observeBankSettlement({
      ...command(operationIds.bankSettlement, 'test:bank-settlement:0001'),
      relatedOperationId: payout.operationId,
      amountCents: 10_000,
    });
    const reconciliation = await provider.reconcile({
      ...command(operationIds.reconciliation, 'test:reconcile:0001'),
      relatedOperationId: bankSettlement.operationId,
    });

    expect(paymentMethod.state).toBe('SUCCEEDED');
    expect(authorization.state).toBe('SUCCEEDED');
    expect(capture.state).toBe('SUCCEEDED');
    expect(refund.state).toBe('PARTIALLY_REFUNDED');
    expect(settlement.state).toBe('SUCCEEDED');
    expect(funding.state).toBe('SUCCEEDED');
    expect(providerRelease).toMatchObject({
      operationKind: 'PROVIDER_RELEASE',
      state: 'SUCCEEDED',
      amountCents: 10_000,
    });
    expect(payout.state).toBe('SUCCEEDED');
    expect(bankSettlement).toMatchObject({
      operationKind: 'OBSERVE_BANK_SETTLEMENT',
      state: 'SUCCEEDED',
      amountCents: 10_000,
    });
    expect(reconciliation.state).toBe('MATCHED');
    expect(reconciliation.providerKind).toBe('FAKE');
    expect(reconciliation.externalReference).toMatch(/^fake_reconcile_[0-9a-f]{24}$/);
  });

  it('replays the exact idempotent command and rejects a changed request', async () => {
    const provider = new FakeFinancialProvider(new InMemoryFakeFinancialOperationRepository());
    const input = command(operationIds.authorize, 'test:authorize:replay');

    const first = await provider.authorize({ ...input, paymentMethodReference: 'pm-fake-1' });
    const replay = await provider.authorize({ ...input, paymentMethodReference: 'pm-fake-1' });

    expect(first.idempotencyReplayed).toBe(false);
    expect(replay).toEqual({ ...first, idempotencyReplayed: true });

    await expect(
      provider.authorize({
        ...input,
        amountCents: 12_501,
        paymentMethodReference: 'pm-fake-1',
      })
    ).rejects.toThrow('FAKE_FINANCIAL_IDEMPOTENCY_CONFLICT');

    await expect(
      provider.authorize({
        ...input,
        idempotencyKey: 'test:authorize:identity-change',
        expectedVersion: 1,
        paymentMethodReference: 'pm-fake-substituted',
      })
    ).rejects.toThrow('FAKE_FINANCIAL_OPERATION_IDENTITY_CONFLICT');
  });

  it('requires expected-version progression for retry and delayed settlement', async () => {
    const provider = new FakeFinancialProvider(new InMemoryFakeFinancialOperationRepository());

    const retryable = await provider.authorize({
      ...command(operationIds.authorize, 'test:authorize:retry:1', 'RETRY'),
      paymentMethodReference: 'pm-fake-1',
    });
    expect(retryable.state).toBe('RETRYABLE_FAILURE');
    expect(retryable.version).toBe(1);

    const retried = await provider.authorize({
      ...command(operationIds.authorize, 'test:authorize:retry:2', 'RETRY'),
      expectedVersion: 1,
      paymentMethodReference: 'pm-fake-1',
    });
    expect(retried.state).toBe('SUCCEEDED');
    expect(retried.version).toBe(2);

    const pending = await provider.settle({
      ...command(operationIds.settlement, 'test:settlement:delay:1', 'DELAYED_SETTLEMENT'),
      relatedOperationId: operationIds.capture,
    });
    expect(pending.state).toBe('PENDING');

    await expect(
      provider.settle({
        ...command(operationIds.settlement, 'test:settlement:delay:wrong', 'DELAYED_SETTLEMENT'),
        expectedVersion: 0,
        relatedOperationId: operationIds.capture,
      })
    ).rejects.toThrow('FAKE_FINANCIAL_VERSION_CONFLICT');

    const completed = await provider.settle({
      ...command(operationIds.settlement, 'test:settlement:delay:2', 'DELAYED_SETTLEMENT'),
      expectedVersion: 1,
      relatedOperationId: operationIds.capture,
    });
    expect(completed.state).toBe('SUCCEEDED');
  });

  it.each([
    ['DECLINE', 'AUTHORIZE', 'DECLINED'],
    ['TIMEOUT', 'AUTHORIZE', 'PENDING'],
    ['REVERSAL', 'REVERSAL', 'REVERSED'],
    ['RECONCILIATION_MISMATCH', 'RECONCILE', 'MISMATCH'],
    ['PROVIDER_ACCOUNT_FAILURE', 'ONBOARD_PROVIDER', 'FAILED'],
  ] as const)('models %s deterministically', async (scenario, kind, expectedState) => {
    const provider = new FakeFinancialProvider(new InMemoryFakeFinancialOperationRepository());
    const operationId =
      kind === 'RECONCILE'
        ? operationIds.reconciliation
        : kind === 'ONBOARD_PROVIDER'
          ? operationIds.merchant
          : operationIds.authorize;
    const base = command(operationId, `test:scenario:${scenario.toLowerCase()}`, scenario);

    const result =
      kind === 'RECONCILE'
        ? await provider.reconcile({ ...base, relatedOperationId: operationIds.settlement })
        : kind === 'ONBOARD_PROVIDER'
          ? await provider.onboardProvider({ ...base, providerId: 'provider-1' })
          : kind === 'REVERSAL'
            ? await provider.reverse({ ...base, relatedOperationId: operationIds.capture })
            : await provider.authorize({ ...base, paymentMethodReference: 'pm-fake-1' });

    expect(result.state).toBe(expectedState);
  });

  it('deduplicates authenticated fake webhook delivery without mutating prior evidence', async () => {
    const repository = new InMemoryFakeFinancialOperationRepository();
    const provider = new FakeFinancialProvider(repository);
    const input = {
      ...command(operationIds.webhook, 'test:webhook:duplicate', 'DUPLICATE_WEBHOOK'),
      providerEventReference: 'evt-fake-1',
      authenticated: true,
    } as const;

    const first = await provider.ingestWebhook(input);
    const duplicate = await provider.ingestWebhook(input);

    expect(first.state).toBe('ACCEPTED');
    expect(duplicate.idempotencyReplayed).toBe(true);
    expect(repository.events()).toHaveLength(1);
  });

  it('keeps onboarding and concurrent account refresh processor-free and idempotent', async () => {
    const repository = new InMemoryFakeFinancialOperationRepository();
    const provider = new FakeFinancialProvider(repository);
    const onboarding = await provider.onboardProvider({
      ...command(operationIds.merchant, 'test:merchant:onboarding'),
      providerId: 'provider-1',
    });
    expect(onboarding).toMatchObject({
      operationKind: 'ONBOARD_PROVIDER',
      providerKind: 'FAKE',
      state: 'SUCCEEDED',
      idempotencyReplayed: false,
    });

    const refresh = {
      ...command(operationIds.merchantState, 'test:merchant-state:enabled'),
      providerId: 'provider-1',
      providerAccountReference: onboarding.externalReference,
    } as const;
    const refreshAttempts = await Promise.all([
      provider.refreshProviderAccountState(refresh),
      provider.refreshProviderAccountState(refresh),
    ]);
    expect(refreshAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationKind: 'REFRESH_PROVIDER_ACCOUNT_STATE',
          idempotencyReplayed: false,
        }),
        expect.objectContaining({
          operationKind: 'REFRESH_PROVIDER_ACCOUNT_STATE',
          idempotencyReplayed: true,
        }),
      ])
    );
    expect(refreshAttempts[0]).toMatchObject({
      operationKind: 'REFRESH_PROVIDER_ACCOUNT_STATE',
      accountState: 'ENABLED',
      chargesEnabled: true,
      payoutsEnabled: true,
      requirementsDue: [],
    });
    await expect(provider.refreshProviderAccountState(refresh)).resolves.toMatchObject({
      accountState: 'ENABLED',
      idempotencyReplayed: true,
    });
    await expect(
      provider.refreshProviderAccountState({
        ...refresh,
        providerId: 'provider-substituted',
      })
    ).rejects.toThrow('FAKE_FINANCIAL_IDEMPOTENCY_CONFLICT');

    const failed = await provider.refreshProviderAccountState({
      ...command(
        '00000000-0000-4000-8000-000000000011',
        'test:merchant-state:failed',
        'PROVIDER_ACCOUNT_FAILURE'
      ),
      providerId: 'provider-2',
      providerAccountReference: 'merchant-fake-2',
    });
    expect(failed).toMatchObject({
      accountState: 'FAILED',
      chargesEnabled: false,
      payoutsEnabled: false,
      requirementsDue: ['identity_verification'],
    });
    expect(repository.events().map(({ operationKind }) => operationKind)).toEqual([
      'ONBOARD_PROVIDER',
      'REFRESH_PROVIDER_ACCOUNT_STATE',
      'REFRESH_PROVIDER_ACCOUNT_STATE',
    ]);
    expect(repository.events()).toHaveLength(3);
    expect(JSON.stringify(repository.events())).not.toMatch(
      /stripe|payment_intent|connect_account/iu
    );
  });

  it('rejects missing webhook authentication and malformed runtime commands', async () => {
    const provider = new FakeFinancialProvider(new InMemoryFakeFinancialOperationRepository());
    const unauthenticated = await provider.ingestWebhook({
      ...command(operationIds.webhook, 'test:webhook:missing-auth'),
      providerEventReference: 'evt-fake-missing-auth',
      authenticated: undefined as unknown as boolean,
    });
    expect(unauthenticated.state).toBe('REJECTED');

    await expect(
      provider.authorize({
        ...command(operationIds.authorize, 'test:authorize:missing-currency'),
        currency: undefined,
        paymentMethodReference: 'pm-fake-1',
      })
    ).rejects.toThrow('FAKE_FINANCIAL_AMOUNT_CURRENCY_PAIR_INVALID');

    await expect(
      provider.authorize({
        ...command(operationIds.authorize, 'test:authorize:bad-scenario'),
        scenario: 'LIVE' as unknown as FakeFinancialScenario,
        paymentMethodReference: 'pm-fake-1',
      })
    ).rejects.toThrow('FAKE_FINANCIAL_SCENARIO_INVALID');
  });

  it('cannot be enabled by an environment feature flag without exact manifest authority', () => {
    expect(
      fakeFinancialProviderEnabled({
        NODE_ENV: 'production',
        HX_ENVIRONMENT: 'production',
        HX_PAYMENT_CREATION_MODE: 'frozen',
        HX_FAKE_FINANCIAL_PROVIDER_ENABLED: 'true',
      })
    ).toBe(false);
    expect(
      fakeFinancialProviderEnabled({
        NODE_ENV: 'development',
        HX_ENVIRONMENT: 'staging',
        HX_PAYMENT_CREATION_MODE: 'frozen',
        HX_FAKE_FINANCIAL_PROVIDER_ENABLED: 'true',
      })
    ).toBe(false);
    expect(
      fakeFinancialProviderEnabled({
        NODE_ENV: 'development',
        HX_ENVIRONMENT: 'staging',
        HX_PAYMENT_CREATION_MODE: 'frozen',
        HX_FAKE_FINANCIAL_PROVIDER_ENABLED: 'false',
      })
    ).toBe(false);
  });

  it('ships an append-only database evidence contract with no processor-specific columns', () => {
    const migration = readFileSync(
      new URL('../../database/migrations/20260827_fake_financial_provider_v1.sql', import.meta.url),
      'utf8'
    );
    expect(migration).toContain('hxos_fake_financial_schema_evidence_v1');
    expect(migration).toContain('migration_sql_sha256');
    expect(migration).toContain('hxos_fake_financial_operations_v1');
    expect(migration).toContain('hxos_fake_financial_operation_events_v1');
    expect(migration).toContain('hxos_nonproduction_bootstrap_completion_v1');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(migration.match(/BEFORE TRUNCATE/g)).toHaveLength(4);
    expect(migration).toContain('release_manifest_digest');
    expect(migration).toContain('migration_artifact_digest');
    expect(migration).toContain("provider_kind = 'FAKE'");
    expect(migration).not.toMatch(/stripe_|payment_intent|connect_account/i);
  });

  it('ships provider-account refresh as an append-only repair without rewriting v1', () => {
    const baseMigration = readFileSync(
      new URL('../../database/migrations/20260827_fake_financial_provider_v1.sql', import.meta.url),
      'utf8'
    );
    const repairMigration = readFileSync(
      new URL(
        '../../database/migrations/20260903_fake_financial_provider_account_refresh_v2.sql',
        import.meta.url
      ),
      'utf8'
    );

    expect(baseMigration).not.toContain('REFRESH_PROVIDER_ACCOUNT_STATE');
    expect(repairMigration).toContain('REFRESH_PROVIDER_ACCOUNT_STATE');
    expect(repairMigration).toContain('hxos_fake_financial_schema_evidence_v2');
    expect(repairMigration).toContain('VALIDATE CONSTRAINT');
    expect(repairMigration).toContain('BEFORE UPDATE OR DELETE');
    expect(repairMigration).toContain('BEFORE TRUNCATE');
    expect(repairMigration).not.toMatch(/stripe_|payment_intent|connect_account/i);
  });

  it('adds release and bank-settlement observation only to the append-only v3 fake vocabulary', () => {
    const refreshMigration = readFileSync(
      new URL(
        '../../database/migrations/20260903_fake_financial_provider_account_refresh_v2.sql',
        import.meta.url
      ),
      'utf8'
    );
    const completionMigration = readFileSync(
      new URL(
        '../../database/migrations/20260910_fake_financial_settlement_completion_v3.sql',
        import.meta.url
      ),
      'utf8'
    );

    expect(refreshMigration).not.toContain('PROVIDER_RELEASE');
    expect(refreshMigration).not.toContain('OBSERVE_BANK_SETTLEMENT');
    expect(completionMigration).toContain('PROVIDER_RELEASE');
    expect(completionMigration).toContain('OBSERVE_BANK_SETTLEMENT');
    expect(completionMigration).toContain('hxos_fake_financial_schema_evidence_v3');
    expect(completionMigration).toContain('VALIDATE CONSTRAINT');
    expect(completionMigration).not.toMatch(/stripe_|payment_intent|connect_account/i);
  });
});
