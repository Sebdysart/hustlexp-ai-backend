import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  newPaymentCreationFailure,
  newPaymentCreationHealth,
  newPaymentCreationMode,
} from '../../src/services/NewPaymentCreationGuard.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('new-payment incident guard', () => {
  it('cannot be enabled outside the exact controlled Stripe test cohort', () => {
    expect(newPaymentCreationMode({ NODE_ENV: 'production' })).toBe('frozen');
    expect(newPaymentCreationMode({
      NODE_ENV: 'production',
      HX_PAYMENT_CREATION_MODE: 'invalid',
    })).toBe('frozen');
    expect(newPaymentCreationMode({
      NODE_ENV: 'production',
      HX_PAYMENT_CREATION_MODE: 'enabled',
      STRIPE_MODE: 'live',
      STRIPE_SECRET_KEY: 'sk_live_forbidden',
    })).toBe('frozen');
    expect(newPaymentCreationMode({
      NODE_ENV: 'development',
      HX_PAYMENT_CREATION_MODE: 'enabled',
      STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_not_a_certification_runtime',
    })).toBe('frozen');
    expect(newPaymentCreationMode({
      NODE_ENV: 'test',
      ENGINE_API_MODE: 'test',
      HX_PAYMENT_CREATION_MODE: 'enabled',
      STRIPE_MODE: 'live',
      STRIPE_SECRET_KEY: 'sk_live_forbidden',
    })).toBe('frozen');
  });

  it('permits only an explicit controlled Stripe test cohort', () => {
    expect(newPaymentCreationMode({ NODE_ENV: 'test' })).toBe('frozen');
    expect(newPaymentCreationMode({
      NODE_ENV: 'test',
      ENGINE_API_MODE: 'test',
      STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_controlled',
      HX_PAYMENT_CREATION_MODE: 'frozen',
    })).toBe('frozen');
    expect(newPaymentCreationMode({
      NODE_ENV: 'test',
      ENGINE_API_MODE: 'test',
      STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_controlled',
      HX_PAYMENT_CREATION_MODE: 'enabled',
    })).toBe('enabled');
  });

  it('returns one truthful, recovery-oriented failure contract for every new-money lane', () => {
    for (const lane of [
      'escrow_funding',
      'xp_tax',
      'tip',
      'subscription',
      'quote_payment',
      'quote_materialization',
    ] as const) {
      const result = newPaymentCreationFailure(lane, {
        NODE_ENV: 'production',
      });
      expect(result).toEqual({
        success: false,
        error: {
          code: 'PAYMENT_CREATION_FROZEN',
          message: 'New customer-money creation is disabled until the processor-neutral lifecycle and written underwriting decisions are certified. No new charge was created.',
          details: {
            lane,
            authority: 'UNDERWRITING_DECISIONS_UNRESOLVED',
          },
        },
      });
    }
  });

  it('publishes a non-sensitive runtime status that proves whether new money is accepted', () => {
    expect(newPaymentCreationHealth({ NODE_ENV: 'production' })).toEqual({
      mode: 'frozen',
      acceptsNewCustomerMoney: false,
      authority: 'UNDERWRITING_DECISIONS_UNRESOLVED',
    });
    expect(newPaymentCreationHealth({
      NODE_ENV: 'production',
      HX_PAYMENT_CREATION_MODE: 'enabled',
    })).toEqual({
      mode: 'frozen',
      acceptsNewCustomerMoney: false,
      authority: 'UNDERWRITING_DECISIONS_UNRESOLVED',
    });
  });

  it('guards every checked-in Stripe surface that can create new customer money', () => {
    const stripeService = read('backend/src/services/StripeService.ts');
    const tippingService = read('backend/src/services/TippingService.ts');
    const subscriptionRouter = read('backend/src/routers/subscription.ts');

    expect(stripeService).toContain("newPaymentCreationFailure('escrow_funding')");
    expect(stripeService).toContain("newPaymentCreationFailure('xp_tax')");
    expect(tippingService).toContain("newPaymentCreationFailure('tip')");
    expect(subscriptionRouter).toContain("newPaymentCreationFailure('subscription')");

    const escrowGuard = stripeService.indexOf("newPaymentCreationFailure('escrow_funding')");
    const firstIntentCreate = stripeService.indexOf('paymentIntents.create(');
    const taxGuard = stripeService.indexOf("newPaymentCreationFailure('xp_tax')");
    const secondIntentCreate = stripeService.indexOf('paymentIntents.create(', firstIntentCreate + 1);
    const quoteGuard = stripeService.indexOf("newPaymentCreationFailure('quote_payment')");
    const thirdIntentCreate = stripeService.indexOf('paymentIntents.create(', secondIntentCreate + 1);
    expect(escrowGuard).toBeLessThan(firstIntentCreate);
    expect(taxGuard).toBeLessThan(secondIntentCreate);
    expect(quoteGuard).toBeGreaterThan(secondIntentCreate);
    expect(quoteGuard).toBeLessThan(thirdIntentCreate);
    expect(tippingService.indexOf("newPaymentCreationFailure('tip')"))
      .toBeLessThan(tippingService.indexOf('paymentIntents.create('));
    expect(subscriptionRouter.indexOf("newPaymentCreationFailure('subscription')"))
      .toBeLessThan(subscriptionRouter.indexOf('subscriptions.create('));

    const creatingCalls = [stripeService, tippingService, subscriptionRouter]
      .flatMap((source) => source.match(/(?:paymentIntents|subscriptions)\.create\(/g) ?? []);
    expect(creatingCalls).toHaveLength(5);

    const finalization = read('backend/src/services/QuotePaymentFinalizationService.ts');
    expect(finalization).toContain("newPaymentCreationFailure('quote_materialization')");
    expect(finalization.indexOf("newPaymentCreationFailure('quote_materialization')"))
      .toBeLessThan(finalization.indexOf('await db.query'));
  });
});
