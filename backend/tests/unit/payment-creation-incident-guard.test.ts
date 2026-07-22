import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  newPaymentCreationFailure,
  newPaymentCreationMode,
} from '../../src/services/NewPaymentCreationGuard.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('new-payment incident guard', () => {
  it('fails closed in production unless explicitly enabled', () => {
    expect(newPaymentCreationMode({ NODE_ENV: 'production' })).toBe('frozen');
    expect(newPaymentCreationMode({
      NODE_ENV: 'production',
      HX_PAYMENT_CREATION_MODE: 'invalid',
    })).toBe('frozen');
    expect(newPaymentCreationMode({
      NODE_ENV: 'production',
      HX_PAYMENT_CREATION_MODE: 'enabled',
    })).toBe('enabled');
  });

  it('keeps local tests enabled by default while honoring an explicit freeze', () => {
    expect(newPaymentCreationMode({ NODE_ENV: 'test' })).toBe('enabled');
    expect(newPaymentCreationMode({
      NODE_ENV: 'test',
      HX_PAYMENT_CREATION_MODE: 'frozen',
    })).toBe('frozen');
    expect(newPaymentCreationFailure('escrow_funding', {
      NODE_ENV: 'production',
      HX_PAYMENT_CREATION_MODE: 'enabled',
    })).toBeNull();
  });

  it('returns one truthful, recovery-oriented failure contract for every new-money lane', () => {
    for (const lane of ['escrow_funding', 'xp_tax', 'tip', 'subscription'] as const) {
      const result = newPaymentCreationFailure(lane, {
        NODE_ENV: 'production',
      });
      expect(result).toEqual({
        success: false,
        error: {
          code: 'PAYMENT_CREATION_FROZEN',
          message: 'New payments are temporarily paused while existing payment records are reconciled. No new charge was created. Try again after Operations clears the payment incident.',
          details: { lane },
        },
      });
    }
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
    expect(escrowGuard).toBeLessThan(firstIntentCreate);
    expect(taxGuard).toBeLessThan(secondIntentCreate);
    expect(tippingService.indexOf("newPaymentCreationFailure('tip')"))
      .toBeLessThan(tippingService.indexOf('paymentIntents.create('));
    expect(subscriptionRouter.indexOf("newPaymentCreationFailure('subscription')"))
      .toBeLessThan(subscriptionRouter.indexOf('subscriptions.create('));

    const creatingCalls = [stripeService, tippingService, subscriptionRouter]
      .flatMap((source) => source.match(/(?:paymentIntents|subscriptions)\.create\(/g) ?? []);
    expect(creatingCalls).toHaveLength(4);
  });
});
