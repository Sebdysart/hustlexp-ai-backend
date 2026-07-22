export type RecurringTemplateStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export type RecurringPauseCode =
  | 'TEMPLATE_NOT_ACTIVE'
  | 'PRICE_CORRIDOR_REPEATED'
  | 'PROVIDER_FAILURE_REPEATED'
  | 'BUDGET_WOULD_EXCEED'
  | 'CREDENTIAL_EXPIRED'
  | 'LOCATION_CLOSED'
  | 'RECENT_DISPUTE'
  | 'MATERIAL_SCOPE_CHANGE'
  | 'FULFILLMENT_ATTEMPTS_EXHAUSTED';

export interface RecurringSafeguardSnapshot {
  templateStatus: RecurringTemplateStatus;
  scheduledCustomerTotalCents: number;
  corridorMaximumCents: number;
  repeatedCorridorBreachCount: number;
  repeatedProviderFailureCount: number;
  budgetCapCents: number;
  budgetSpentCents: number;
  credentialsRequired: boolean;
  credentialsValidUntil: string | null;
  locationClosed: boolean;
  openDisputeCount: number;
  materialScopeChange: boolean;
  failedFulfillmentAttempts: number;
  evaluateAt: string;
}

export interface RecurringSafeguardDecision {
  allowed: boolean;
  pauseCode: RecurringPauseCode | null;
}

const PRICE_BREACH_LIMIT = 2;
const PROVIDER_FAILURE_LIMIT = 2;
const FULFILLMENT_ATTEMPT_LIMIT = 3;

function credentialsExpired(snapshot: RecurringSafeguardSnapshot): boolean {
  if (!snapshot.credentialsRequired) return false;
  const expiry = snapshot.credentialsValidUntil
    ? Date.parse(snapshot.credentialsValidUntil)
    : Number.NaN;
  const evaluatedAt = Date.parse(snapshot.evaluateAt);
  return !Number.isFinite(expiry) || !Number.isFinite(evaluatedAt) || expiry <= evaluatedAt;
}

const SAFEGUARD_RULES: ReadonlyArray<{
  pauseCode: RecurringPauseCode;
  blocked: (snapshot: RecurringSafeguardSnapshot) => boolean;
}> = [
  {
    pauseCode: 'TEMPLATE_NOT_ACTIVE',
    blocked: (snapshot) => snapshot.templateStatus !== 'active',
  },
  {
    pauseCode: 'PRICE_CORRIDOR_REPEATED',
    blocked: (snapshot) => snapshot.repeatedCorridorBreachCount >= PRICE_BREACH_LIMIT
      || snapshot.scheduledCustomerTotalCents > snapshot.corridorMaximumCents,
  },
  {
    pauseCode: 'PROVIDER_FAILURE_REPEATED',
    blocked: (snapshot) => snapshot.repeatedProviderFailureCount >= PROVIDER_FAILURE_LIMIT,
  },
  {
    pauseCode: 'BUDGET_WOULD_EXCEED',
    blocked: (snapshot) => snapshot.budgetSpentCents + snapshot.scheduledCustomerTotalCents
      > snapshot.budgetCapCents,
  },
  { pauseCode: 'CREDENTIAL_EXPIRED', blocked: credentialsExpired },
  { pauseCode: 'LOCATION_CLOSED', blocked: (snapshot) => snapshot.locationClosed },
  { pauseCode: 'RECENT_DISPUTE', blocked: (snapshot) => snapshot.openDisputeCount > 0 },
  { pauseCode: 'MATERIAL_SCOPE_CHANGE', blocked: (snapshot) => snapshot.materialScopeChange },
  {
    pauseCode: 'FULFILLMENT_ATTEMPTS_EXHAUSTED',
    blocked: (snapshot) => snapshot.failedFulfillmentAttempts >= FULFILLMENT_ATTEMPT_LIMIT,
  },
];

/**
 * The recurring generation gate. The order is deliberate: it produces one stable,
 * auditable primary reason while the full snapshot remains available for review.
 */
export function evaluateRecurringSafeguards(
  snapshot: RecurringSafeguardSnapshot,
): RecurringSafeguardDecision {
  const failedRule = SAFEGUARD_RULES.find((rule) => rule.blocked(snapshot));
  if (failedRule) return { allowed: false, pauseCode: failedRule.pauseCode };
  return { allowed: true, pauseCode: null };
}
