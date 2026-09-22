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

  it('publishes a non-sensitive runtime status that proves whether new money is accepted', () => {
    expect(newPaymentCreationHealth({ NODE_ENV: 'production' })).toEqual({
      mode: 'frozen',
      acceptsNewCustomerMoney: false,
    });
    expect(newPaymentCreationHealth({
      NODE_ENV: 'production',
      HX_PAYMENT_CREATION_MODE: 'enabled',
    })).toEqual({
      mode: 'enabled',
      acceptsNewCustomerMoney: true,
    });
  });

  it('guards supported live checkout and controlled payment creation', () => {
    const live = read('backend/src/services/payment/TilledQuoteCheckoutService.ts');
    const controlled = read('backend/src/services/LocalCertificationPaymentProvider.ts');
    expect(live).toContain("newPaymentCreationFailure('escrow_funding')");
    expect(controlled).toContain("newPaymentCreationFailure('escrow_funding')");
    expect(live.indexOf("newPaymentCreationFailure('escrow_funding')")).toBeLessThan(live.indexOf('TilledQuotePaymentProvider.createPaymentIntent(binding)'));
  });
});
