import { describe, expect, it } from 'vitest';
import {
  evaluateRecurringSafeguards,
  type RecurringSafeguardSnapshot,
} from '../../src/services/RecurringTemplatePolicy.js';

const BASE: RecurringSafeguardSnapshot = {
  templateStatus: 'active',
  scheduledCustomerTotalCents: 10_000,
  corridorMaximumCents: 12_000,
  repeatedCorridorBreachCount: 0,
  repeatedProviderFailureCount: 0,
  budgetCapCents: 50_000,
  budgetSpentCents: 10_000,
  credentialsRequired: true,
  credentialsValidUntil: '2026-08-01T00:00:00.000Z',
  locationClosed: false,
  openDisputeCount: 0,
  materialScopeChange: false,
  failedFulfillmentAttempts: 0,
  evaluateAt: '2026-07-18T12:00:00.000Z',
};

describe('recurring template fail-closed safeguards', () => {
  it('allows a healthy active template', () => {
    expect(evaluateRecurringSafeguards(BASE)).toEqual({ allowed: true, pauseCode: null });
  });

  it.each([
    ['PRICE_CORRIDOR_REPEATED', { repeatedCorridorBreachCount: 2 }],
    ['PROVIDER_FAILURE_REPEATED', { repeatedProviderFailureCount: 2 }],
    ['BUDGET_WOULD_EXCEED', { budgetSpentCents: 45_000 }],
    ['CREDENTIAL_EXPIRED', { credentialsValidUntil: '2026-07-18T11:59:59.000Z' }],
    ['LOCATION_CLOSED', { locationClosed: true }],
    ['RECENT_DISPUTE', { openDisputeCount: 1 }],
    ['MATERIAL_SCOPE_CHANGE', { materialScopeChange: true }],
    ['FULFILLMENT_ATTEMPTS_EXHAUSTED', { failedFulfillmentAttempts: 3 }],
  ] as const)('pauses for %s', (pauseCode, override) => {
    expect(evaluateRecurringSafeguards({ ...BASE, ...override })).toEqual({
      allowed: false,
      pauseCode,
    });
  });

  it('refuses generation for paused, cancelled, or completed templates', () => {
    for (const templateStatus of ['paused', 'cancelled', 'completed'] as const) {
      expect(evaluateRecurringSafeguards({ ...BASE, templateStatus })).toEqual({
        allowed: false,
        pauseCode: 'TEMPLATE_NOT_ACTIVE',
      });
    }
  });

  it('fails closed when required credential evidence has no expiry', () => {
    expect(evaluateRecurringSafeguards({ ...BASE, credentialsValidUntil: null })).toEqual({
      allowed: false,
      pauseCode: 'CREDENTIAL_EXPIRED',
    });
  });
});
