import { expect, it, vi } from 'vitest';

vi.mock('../../src/config', () => ({ config: { stripe: { secretKey: 'placeholder' } } }));
vi.mock('stripe', () => ({ default: vi.fn() }));

import { getStripe } from '../../src/routers/escrow-common';

it('fails closed before constructing Stripe when payment configuration is absent', () => {
  expect(() => getStripe()).toThrow('Payment processing is not configured');
});
