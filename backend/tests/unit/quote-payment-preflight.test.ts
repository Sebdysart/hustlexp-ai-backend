import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  controlledTestQuotePaymentEnabled,
  controlledTestQuotePaymentReference,
} from '../../src/services/ControlledTestQuotePaymentService.js';

const routerSource = readFileSync(
  resolve(process.cwd(), 'backend/src/routers/quotePayment.ts'),
  'utf8',
);

const finalizerSource = readFileSync(
  resolve(
    process.cwd(),
    'backend/src/services/QuotePaymentFinalizationService.ts',
  ),
  'utf8',
);

const enabledEnvironment = {
  NODE_ENV: 'development',
  PAYMENT_PROVIDER: 'local_test',
  HXOS_ALLOW_LOCAL_TEST_PAYMENT: 'true',
  ENGINE_API_MODE: 'test',
  HXOS_LOCAL_TEST_PAYMENT_SECRET: 'a'.repeat(32),
};

describe('controlled-test quote payment authority', () => {
  it('requires every explicit server-side controlled-test setting', () => {
    expect(controlledTestQuotePaymentEnabled(enabledEnvironment)).toBe(true);

    for (const key of Object.keys(enabledEnvironment).filter((key) => key !== 'NODE_ENV')) {
      expect(
        controlledTestQuotePaymentEnabled({
          ...enabledEnvironment,
          [key]: undefined,
        }),
      ).toBe(false);
    }
  });

  it('cannot be enabled in production', () => {
    expect(
      controlledTestQuotePaymentEnabled({
        ...enabledEnvironment,
        NODE_ENV: 'production',
      }),
    ).toBe(false);
  });

  it('uses a deterministic quote marker for concurrent retries', () => {
    const first = controlledTestQuotePaymentReference('quote', 'version');
    const second = controlledTestQuotePaymentReference('quote', 'version');
    const different = controlledTestQuotePaymentReference('quote', 'other');

    expect(first).toBe(second);
    expect(first).not.toBe(different);
    expect(first).toMatch(/^quote_local_test_[a-f0-9]{32}$/);
    expect(routerSource).toContain(
      'ON CONFLICT (quote_id, quote_version_id)',
    );
    expect(routerSource).toContain('DO NOTHING');
    expect(finalizerSource).toContain(
      'quote-finalize:${input.quoteId}:v${input.quoteVersionId}',
    );
  });

  it('does not accept a client-controlled mode or payment identity', () => {
    expect(routerSource).toContain('completeControlledTestPayment');
    expect(routerSource).not.toContain('confirmTestPayment:');
    expect(routerSource).not.toContain('paymentMethodId: z.string()');
    expect(routerSource).not.toContain('testMode:');
  });

  it('preserves canonical materialization, local payment, and escrow funding', () => {
    expect(finalizerSource).toContain(
      'TaskCreateService.materializeQuotedTaskInTransaction',
    );
    expect(finalizerSource).toContain('settleControlledTestQuotePayment');
    expect(finalizerSource).toContain('EscrowService.fund');
    expect(finalizerSource).toContain("provider = 'local_test'");
  });

  it('does not invoke Stax from the controlled-test router path', () => {
    expect(routerSource).not.toContain('StaxQuotePaymentProvider.charge');
    expect(routerSource).toContain("paymentMode: 'controlled_test'");
  });
});
