import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  newPaymentCreationFailure,
  newPaymentCreationHealth,
  newPaymentCreationMode,
  permanentlyContainedPositiveMoneyFailure,
} from '../../src/services/NewPaymentCreationGuard.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('new-payment incident guard', () => {
  it('cannot be enabled outside the exact controlled Stripe test cohort', () => {
    expect(newPaymentCreationMode({ NODE_ENV: 'production' })).toBe('frozen');
    expect(
      newPaymentCreationMode({
        NODE_ENV: 'production',
        HX_PAYMENT_CREATION_MODE: 'invalid',
      })
    ).toBe('frozen');
    expect(
      newPaymentCreationMode({
        NODE_ENV: 'production',
        HX_PAYMENT_CREATION_MODE: 'enabled',
        STRIPE_MODE: 'live',
        STRIPE_SECRET_KEY: 'sk_live_forbidden',
      })
    ).toBe('frozen');
    expect(
      newPaymentCreationMode({
        NODE_ENV: 'development',
        HX_PAYMENT_CREATION_MODE: 'enabled',
        STRIPE_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_test_not_a_certification_runtime',
      })
    ).toBe('frozen');
    expect(
      newPaymentCreationMode({
        NODE_ENV: 'test',
        ENGINE_API_MODE: 'test',
        HX_PAYMENT_CREATION_MODE: 'enabled',
        STRIPE_MODE: 'live',
        STRIPE_SECRET_KEY: 'sk_live_forbidden',
      })
    ).toBe('frozen');
  });

  it('permits only an explicit controlled Stripe test cohort', () => {
    expect(newPaymentCreationMode({ NODE_ENV: 'test' })).toBe('frozen');
    expect(
      newPaymentCreationMode({
        NODE_ENV: 'test',
        ENGINE_API_MODE: 'test',
        STRIPE_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_test_controlled',
        HX_PAYMENT_CREATION_MODE: 'frozen',
      })
    ).toBe('frozen');
    expect(
      newPaymentCreationMode({
        NODE_ENV: 'test',
        ENGINE_API_MODE: 'test',
        STRIPE_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_test_controlled',
        HX_PAYMENT_CREATION_MODE: 'enabled',
      })
    ).toBe('enabled');
  });

  it('cannot be enabled by environment configuration in a normal deployed process', () => {
    expect(
      newPaymentCreationMode(
        {
          NODE_ENV: 'test',
          ENGINE_API_MODE: 'test',
          STRIPE_MODE: 'test',
          STRIPE_SECRET_KEY: 'sk_test_misconfigured_deployment',
          HX_PAYMENT_CREATION_MODE: 'enabled',
        },
        { isolatedTestRunner: false }
      )
    ).toBe('frozen');
  });

  it('keeps the Universal V1 primary boundary processor-neutral and mounted separately from legacy Stripe', () => {
    const financeRouter = read('backend/src/routers/syntheticFinance.ts');
    const routerIndex = read('backend/src/routers/index.ts');

    expect(financeRouter).toContain('export const universalFinanceRouter = router({');
    expect(financeRouter).toContain('createUniversalV1FakeFinancialApplicationService()');
    expect(financeRouter).toContain('executeFinancialEvent');
    expect(financeRouter).toContain('refreshProviderAccountState');
    expect(financeRouter).toContain('reconcile');
    expect(financeRouter).not.toMatch(/Stripe(?:Service|Connect|Quote|Payment|\.)/u);
    expect(routerIndex).toContain('finance: universalFinanceRouter');
    expect(routerIndex).toContain('syntheticFinance: syntheticFinanceRouter');
  });

  it('returns a truthful lane-specific failure contract for every positive-money lane', () => {
    for (const lane of [
      'escrow_funding',
      'xp_tax',
      'tip',
      'subscription',
      'quote_payment',
      'quote_materialization',
      'escrow_transfer',
      'provider_payout',
      'connect_account',
      'connect_onboarding',
      'connect_login_link',
      'connect_payout_settings',
    ] as const) {
      const positiveEffectMessage = new Set([
        'escrow_transfer',
        'provider_payout',
        'connect_account',
        'connect_onboarding',
        'connect_login_link',
        'connect_payout_settings',
      ]).has(lane);
      const tombstonedQuoteLane = new Set(['quote_payment', 'quote_materialization']).has(lane);
      const result = newPaymentCreationFailure(lane, {
        NODE_ENV: 'production',
      });
      expect(result).toEqual({
        success: false,
        error: {
          code: tombstonedQuoteLane ? 'LEGACY_QUOTE_PAYMENT_TOMBSTONED' : 'PAYMENT_CREATION_FROZEN',
          message: tombstonedQuoteLane
            ? 'Legacy quote payment creation and pay-first materialization are retired. Use the Universal V1 TaskDraft, eligibility, scope, financial-security, and Work Order lifecycle. No payment was created.'
            : positiveEffectMessage
              ? 'Real payment creation, settlement, payout, and Connect capability changes are disabled until the processor-neutral lifecycle and written underwriting decisions are certified. No positive money effect was created.'
              : 'New customer-money creation is disabled until the processor-neutral lifecycle and written underwriting decisions are certified. No new charge was created.',
          details: {
            lane,
            authority: 'UNDERWRITING_DECISIONS_UNRESOLVED',
            ...(tombstonedQuoteLane ? { disposition: 'TOMBSTONED' } : {}),
          },
        },
      });
    }
  });

  it('never revives legacy quote positive-money lanes inside the isolated Stripe cohort', () => {
    const controlled = {
      NODE_ENV: 'test',
      ENGINE_API_MODE: 'test',
      STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_controlled',
      HX_PAYMENT_CREATION_MODE: 'enabled',
    };
    expect(newPaymentCreationMode(controlled)).toBe('enabled');
    expect(newPaymentCreationFailure('quote_payment', controlled)?.error.code).toBe(
      'LEGACY_QUOTE_PAYMENT_TOMBSTONED'
    );
    expect(newPaymentCreationFailure('quote_materialization', controlled)?.error.code).toBe(
      'LEGACY_QUOTE_PAYMENT_TOMBSTONED'
    );
  });

  it('keeps permanently contained payout routes frozen even inside adapter certification tests', () => {
    expect(
      permanentlyContainedPositiveMoneyFailure(
        'provider_payout',
        'CONTAINED_PENDING_PROVIDER_NEUTRAL_INSURANCE_PAYOUT_SAGA'
      )
    ).toMatchObject({
      success: false,
      error: {
        code: 'PAYMENT_CREATION_FROZEN',
        details: {
          lane: 'provider_payout',
          disposition: 'CONTAINED_PENDING_PROVIDER_NEUTRAL_INSURANCE_PAYOUT_SAGA',
        },
      },
    });
  });

  it('publishes a non-sensitive runtime status that proves whether new money is accepted', () => {
    expect(newPaymentCreationHealth({ NODE_ENV: 'production' })).toEqual({
      mode: 'frozen',
      acceptsNewCustomerMoney: false,
      permitsRealSettlement: false,
      permitsProviderPayouts: false,
      permitsConnectProvisioning: false,
      authority: 'UNDERWRITING_DECISIONS_UNRESOLVED',
    });
    expect(
      newPaymentCreationHealth({
        NODE_ENV: 'production',
        HX_PAYMENT_CREATION_MODE: 'enabled',
      })
    ).toEqual({
      mode: 'frozen',
      acceptsNewCustomerMoney: false,
      permitsRealSettlement: false,
      permitsProviderPayouts: false,
      permitsConnectProvisioning: false,
      authority: 'UNDERWRITING_DECISIONS_UNRESOLVED',
    });
  });

  it('guards every executable processor creation or test-confirmation call in the repository', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(resolve(process.cwd(), 'backend/src'))) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const expression = node.expression.getText(source);
          const primitive = expression.match(
            /(?:^|\.)(paymentIntents\.(?:create|confirm)|subscriptions\.create|customers\.create|products\.create|payouts\.create|transfers\.create|accounts\.(?:create|update|createLoginLink)|accountLinks\.create)$/
          )?.[1];
          if (primitive) {
            let guarded = false;
            const findGuard = (candidate: ts.Node): void => {
              if (
                ts.isCallExpression(candidate) &&
                candidate.expression.getText(source) === 'newPaymentCreationFailure' &&
                candidate.getStart(source) < node.getStart(source)
              )
                guarded = true;
              ts.forEachChild(candidate, findGuard);
            };
            let scope: ts.Node | undefined = node.parent;
            while (scope && !guarded) {
              if (ts.isFunctionLike(scope)) findGuard(scope);
              scope = scope.parent;
            }
            expect(
              guarded,
              `${file}:${primitive} lacks an earlier guard in the same function`
            ).toBe(true);
            const repositoryPath = relative(process.cwd(), file).replaceAll('\\', '/');
            hits.push(`${repositoryPath}:${primitive}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(hits.sort()).toEqual([
      'backend/src/routers/subscription.ts:customers.create',
      'backend/src/routers/subscription.ts:products.create',
      'backend/src/routers/subscription.ts:subscriptions.create',
      'backend/src/services/HustlerWalletProvider.ts:payouts.create',
      'backend/src/services/StripeConnectService.ts:accountLinks.create',
      'backend/src/services/StripeConnectService.ts:accounts.create',
      'backend/src/services/StripeConnectService.ts:accounts.createLoginLink',
      'backend/src/services/StripeConnectService.ts:accounts.update',
      'backend/src/services/StripeService.ts:paymentIntents.create',
      'backend/src/services/StripeService.ts:paymentIntents.create',
      'backend/src/services/StripeService.ts:transfers.create',
      'backend/src/services/TippingService.ts:paymentIntents.create',
    ]);

    const finalization = read('backend/src/services/QuotePaymentFinalizationService.ts');
    expect(finalization).toContain("newPaymentCreationFailure('quote_materialization')");
    expect(finalization).toContain('quote_payment_recovery_operations');
    expect(finalization).not.toContain('StripeQuotePaymentProvider');
    expect(finalization).not.toContain('TaskCreateService');
    expect(finalization).not.toContain('EscrowService');
    expect(finalization).not.toContain('db.transaction');

    const quoteRouter = read('backend/src/routers/quotePayment.ts');
    expect(quoteRouter).toContain('throwLegacyQuotePaymentTombstone');
    expect(quoteRouter).not.toContain('StripeQuotePaymentProvider');
    expect(quoteRouter).not.toContain('StripeService');
    expect(quoteRouter).not.toContain("from '../db.js'");

    const recoveryResolver = read(
      'backend/src/services/payment/QuotePaymentRecoveryProviderResolver.ts'
    );
    expect(recoveryResolver).toContain("persistedProvider === 'stripe'");
    expect(recoveryResolver).not.toContain('process.env');
    const recovery = read('backend/src/services/QuotePaymentRecoveryService.ts');
    expect(recovery).toContain('resolveQuotePaymentRecoveryProvider(claim.payment.provider)');

    const legacyScript = read('backend/scripts/posttask-paymenttest.sh');
    expect(legacyScript.indexOf('exit 78')).toBeLessThan(legacyScript.indexOf('curl -X POST'));
  });

  it('keeps Connect reads available while provisioning and login-link creation stay frozen', () => {
    const connect = read('backend/src/services/StripeConnectService.ts');
    const readOnlyMethods = [
      ['getOnboardingStatus', 'createOnboardingLink'],
      ['getPayoutSettings', 'updatePayoutSettings'],
      ['getTaxInfo', 'submitTaxInfo'],
      ['getEarningsSummary', 'getAccountDetails'],
      ['getAccountDetails', 'refreshOnboarding'],
    ] as const;

    for (const [method, nextMethod] of readOnlyMethods) {
      const methodStart = connect.indexOf(`${method}: async`);
      const nextMethodStart = connect.indexOf(`${nextMethod}: async`, methodStart);
      expect(methodStart, `${method} must remain present`).toBeGreaterThan(-1);
      expect(
        connect.slice(methodStart, nextMethodStart).includes('newPaymentCreationFailure'),
        `${method} must not be classified as a positive-money mutation`
      ).toBe(false);
    }

    expect(connect).toContain("newPaymentCreationFailure('connect_account')");
    expect(connect).toContain("newPaymentCreationFailure('connect_onboarding')");
    expect(connect).toContain("newPaymentCreationFailure('connect_login_link')");
    expect(connect).toContain("newPaymentCreationFailure('connect_payout_settings')");
    const dashboardStart = connect.indexOf('getDashboardLink: async');
    const loginGuard = connect.indexOf(
      "newPaymentCreationFailure('connect_login_link')",
      dashboardStart
    );
    expect(loginGuard).toBeGreaterThan(dashboardStart);
    expect(loginGuard).toBeLessThan(connect.indexOf('accounts.createLoginLink', dashboardStart));
  });

  it('guards asynchronous success materialization and old-payment replay boundaries', () => {
    const stripeWorker = read('backend/src/jobs/stripe-event-worker.ts');
    expect(stripeWorker).toContain('containFrozenPositiveEvent');
    expect(stripeWorker.indexOf('await containFrozenPositiveEvent')).toBeLessThan(
      stripeWorker.indexOf('await processEntitlementPurchase')
    );
    expect(stripeWorker.indexOf('await containFrozenPositiveEvent')).toBeLessThan(
      stripeWorker.indexOf('await fundEscrowForPaymentIntent')
    );

    const paymentWorker = read('backend/src/jobs/payment-worker.ts');
    expect(paymentWorker).toContain("eventType === 'payment_intent.succeeded'");
    expect(paymentWorker.indexOf("eventType === 'payment_intent.succeeded'")).toBeLessThan(
      paymentWorker.indexOf('await handlePaymentIntentSucceeded')
    );

    const xpTax = read('backend/src/services/XPTaxService.ts');
    const mutationGuard = xpTax.indexOf(
      "newPaymentCreationFailure('xp_tax')",
      xpTax.indexOf('payTax: async')
    );
    expect(mutationGuard).toBeGreaterThan(0);
    expect(mutationGuard).toBeLessThan(xpTax.indexOf('StripeService.verifyPaymentIntent'));
    expect(mutationGuard).toBeLessThan(
      xpTax.indexOf('db.serializableTransaction', xpTax.indexOf('payTax: async'))
    );

    const localProvider = read('backend/src/services/LocalCertificationPaymentProvider.ts');
    expect(localProvider).toContain('assertDisposableStorage');
    expect(localProvider).toContain("['127.0.0.1', 'localhost', '::1']");
    expect(localProvider).toContain('current_database() AS database_name');
  });

  it('guards payout orchestration before it can record or call a provider', () => {
    const requestService = read('backend/src/services/HustlerCashOutRequestService.ts');
    const requestStart = requestService.indexOf('export async function requestHustlerCashOut');
    const guard = requestService.indexOf(
      "newPaymentCreationFailure('provider_payout')",
      requestStart
    );
    expect(guard).toBeGreaterThan(requestStart);
    expect(guard).toBeLessThan(requestService.indexOf('buildCashOutReviewContext', requestStart));
    expect(guard).toBeLessThan(
      requestService.indexOf('resolveRequest({ ...input, context })', requestStart)
    );

    const transferService = read('backend/src/services/StripeService.ts');
    const transferStart = transferService.indexOf('createTransfer: async');
    const transferGuard = transferService.indexOf(
      "newPaymentCreationFailure('escrow_transfer')",
      transferStart
    );
    expect(transferGuard).toBeGreaterThan(transferStart);
    expect(transferGuard).toBeLessThan(
      transferService.indexOf("process.env.HX_STRIPE_STUB === '1'", transferStart)
    );

    const insuranceService = read('backend/src/services/SelfInsurancePoolService.ts');
    const insurancePayoutStart = insuranceService.indexOf('payClaim: async');
    const insurancePayoutEnd = insuranceService.indexOf('getPoolStatus: async', insurancePayoutStart);
    const insurancePayout = insuranceService.slice(insurancePayoutStart, insurancePayoutEnd);
    expect(insurancePayout).toContain('permanentlyContainedPositiveMoneyFailure');
    expect(insurancePayout).toContain('CLAIM_PAYOUT_RECONCILIATION_REQUIRED');
    expect(insurancePayout).not.toContain('StripeService');
    expect(insurancePayout).not.toContain('createTransfer');
    expect(insurancePayout).not.toContain('stripe_connect_id');
    expect(insurancePayout).not.toContain('db.transaction');
    expect(insurancePayout).not.toMatch(/UPDATE\s+insurance_claims/iu);
  });
});
