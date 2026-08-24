import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  newPaymentCreationFailure,
  newPaymentCreationHealth,
  newPaymentCreationMode,
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

  it('cannot be enabled by environment configuration in a normal deployed process', () => {
    expect(newPaymentCreationMode({
      NODE_ENV: 'test',
      ENGINE_API_MODE: 'test',
      STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_misconfigured_deployment',
      HX_PAYMENT_CREATION_MODE: 'enabled',
    }, { isolatedTestRunner: false })).toBe('frozen');
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

  it('guards every executable processor creation or test-confirmation call in the repository', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(resolve(process.cwd(), 'backend/src'))) {
      const source = ts.createSourceFile(
        file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const expression = node.expression.getText(source);
          const primitive = expression.match(/(?:^|\.)(paymentIntents\.(?:create|confirm)|subscriptions\.create)$/)?.[1];
          if (primitive) {
            let guarded = false;
            const findGuard = (candidate: ts.Node): void => {
              if (
                ts.isCallExpression(candidate)
                && candidate.expression.getText(source) === 'newPaymentCreationFailure'
                && candidate.getStart(source) < node.getStart(source)
              ) guarded = true;
              ts.forEachChild(candidate, findGuard);
            };
            let scope: ts.Node | undefined = node.parent;
            while (scope && !guarded) {
              if (ts.isFunctionLike(scope)) findGuard(scope);
              scope = scope.parent;
            }
            expect(guarded, `${file}:${primitive} lacks an earlier guard in the same function`).toBe(true);
            hits.push(`${relative(process.cwd(), file)}:${primitive}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(hits.sort()).toEqual([
      'backend/src/routers/subscription.ts:subscriptions.create',
      'backend/src/services/StripeService.ts:paymentIntents.confirm',
      'backend/src/services/StripeService.ts:paymentIntents.create',
      'backend/src/services/StripeService.ts:paymentIntents.create',
      'backend/src/services/StripeService.ts:paymentIntents.create',
      'backend/src/services/TippingService.ts:paymentIntents.create',
    ]);

    const finalization = read('backend/src/services/QuotePaymentFinalizationService.ts');
    expect(finalization).toContain("newPaymentCreationFailure('quote_materialization')");
    expect(finalization.indexOf("newPaymentCreationFailure('quote_materialization')"))
      .toBeLessThan(finalization.indexOf('StripeQuotePaymentProvider.verifySucceededPayment'));
    expect(finalization.indexOf("newPaymentCreationFailure('quote_materialization')"))
      .toBeLessThan(finalization.indexOf('await db.transaction'));
  });
});
