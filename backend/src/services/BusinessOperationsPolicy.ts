import {
  businessRoleAllows,
  type BusinessRole,
} from './BusinessWorkspacePolicy.js';

export const BUSINESS_SPEND_BLOCKERS = [
  'INVALID_BUDGET_POLICY',
  'PER_TASK_CAP_EXCEEDED',
  'MONTHLY_CAP_EXCEEDED',
  'PURCHASE_ORDER_REQUIRED',
  'COST_CENTER_REQUIRED',
] as const;

export type BusinessSpendBlocker = (typeof BUSINESS_SPEND_BLOCKERS)[number];
export type BusinessSpendOutcome = 'AUTO_APPROVED' | 'PENDING_APPROVAL' | 'BLOCKED';

export interface BusinessSpendPolicyInput {
  amountCents: number;
  monthSpendCents: number;
  perTaskCapCents: number;
  monthlyCapCents: number;
  autoApproveLimitCents: number;
  poRequired: boolean;
  poNumber?: string | null;
  costCenterRequired: boolean;
  costCenter?: string | null;
}

export interface BusinessSpendEvaluation {
  outcome: BusinessSpendOutcome;
  projectedMonthSpendCents: number;
  blockers: BusinessSpendBlocker[];
}

function isWholeNonNegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isWholePositive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

const SPEND_POLICY_CHECKS: ReadonlyArray<(input: BusinessSpendPolicyInput) => boolean> = [
  (input) => isWholePositive(input.amountCents),
  (input) => isWholeNonNegative(input.monthSpendCents),
  (input) => isWholeNonNegative(input.perTaskCapCents),
  (input) => isWholeNonNegative(input.monthlyCapCents),
  (input) => isWholeNonNegative(input.autoApproveLimitCents),
  (input) => input.perTaskCapCents <= input.monthlyCapCents,
  (input) => input.autoApproveLimitCents <= input.perTaskCapCents,
];

function hasValidSpendPolicy(input: BusinessSpendPolicyInput): boolean {
  return SPEND_POLICY_CHECKS.every((check) => check(input));
}

function spendBlockers(
  input: BusinessSpendPolicyInput,
  validPolicy: boolean,
  projectedMonthSpendCents: number,
): BusinessSpendBlocker[] {
  const rules: ReadonlyArray<[BusinessSpendBlocker, boolean]> = [
    ['INVALID_BUDGET_POLICY', !validPolicy],
    ['PER_TASK_CAP_EXCEEDED', validPolicy && input.amountCents > input.perTaskCapCents],
    ['MONTHLY_CAP_EXCEEDED', validPolicy && projectedMonthSpendCents > input.monthlyCapCents],
    ['PURCHASE_ORDER_REQUIRED', input.poRequired && !input.poNumber?.trim()],
    ['COST_CENTER_REQUIRED', input.costCenterRequired && !input.costCenter?.trim()],
  ];
  return rules.filter(([, blocked]) => blocked).map(([blocker]) => blocker);
}

function spendOutcome(
  blockers: readonly BusinessSpendBlocker[],
  amountCents: number,
  autoApproveLimitCents: number,
): BusinessSpendOutcome {
  if (blockers.length > 0) return 'BLOCKED';
  return amountCents <= autoApproveLimitCents ? 'AUTO_APPROVED' : 'PENDING_APPROVAL';
}

export function evaluateBusinessSpend(
  input: BusinessSpendPolicyInput,
): BusinessSpendEvaluation {
  const projectedMonthSpendCents = input.monthSpendCents + input.amountCents;
  const blockers = spendBlockers(
    input,
    hasValidSpendPolicy(input),
    projectedMonthSpendCents,
  );

  return {
    outcome: spendOutcome(blockers, input.amountCents, input.autoApproveLimitCents),
    projectedMonthSpendCents,
    blockers,
  };
}

export function canDecideBusinessApproval(
  actorId: string,
  requesterId: string,
  actorRole: BusinessRole,
): boolean {
  return actorId !== requesterId && businessRoleAllows(actorRole, 'APPROVE_SPEND');
}

export const SERVICE_PROFILE_READINESS_BLOCKERS = [
  'PROVIDER_MODE_DISABLED',
  'LEGAL_ENTITY_NOT_VERIFIED',
  'PAYOUT_NOT_ACTIVE',
  'COVERAGE_REQUIRED',
  'CAPACITY_REQUIRED',
  'ELIGIBLE_CREW_REQUIRED',
  'INVALID_PRICE_CORRIDOR',
  'PROOF_RECIPE_REQUIRED',
  'CREDENTIALS_NOT_MET',
] as const;

export type ServiceProfileReadinessBlocker =
  (typeof SERVICE_PROFILE_READINESS_BLOCKERS)[number];
export type BusinessPricingMode = 'INSTANT_CORRIDOR' | 'STARTING_PRICE' | 'QUOTE_REQUIRED';

export interface ServiceProfileReadinessInput {
  providerEnabled: boolean;
  verificationStatus: 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';
  payoutStatus: 'NOT_STARTED' | 'PENDING' | 'ACTIVE' | 'RESTRICTED' | 'DISABLED';
  coveragePostalCodes: readonly string[];
  weeklyCapacitySlots: number;
  eligibleCrewCount: number;
  pricingMode: BusinessPricingMode;
  corridorMinimumCents: number | null;
  corridorMaximumCents: number | null;
  proofChecklist: readonly string[];
  credentialRequirementsMet: boolean;
}

function hasCoverage(input: ServiceProfileReadinessInput): boolean {
  return input.coveragePostalCodes.some((code) => code.trim().length >= 3);
}

function hasValidPriceCorridor(input: ServiceProfileReadinessInput): boolean {
  if (input.pricingMode === 'QUOTE_REQUIRED') return true;
  const values = [input.corridorMinimumCents, input.corridorMaximumCents];
  if (!values.every((value) => value !== null && isWholePositive(value))) return false;
  return input.corridorMaximumCents! >= input.corridorMinimumCents!;
}

const READINESS_RULES: ReadonlyArray<{
  blocker: ServiceProfileReadinessBlocker;
  ready: (input: ServiceProfileReadinessInput) => boolean;
}> = [
  { blocker: 'PROVIDER_MODE_DISABLED', ready: (input) => input.providerEnabled },
  { blocker: 'LEGAL_ENTITY_NOT_VERIFIED', ready: (input) => input.verificationStatus === 'VERIFIED' },
  { blocker: 'PAYOUT_NOT_ACTIVE', ready: (input) => input.payoutStatus === 'ACTIVE' },
  { blocker: 'COVERAGE_REQUIRED', ready: hasCoverage },
  { blocker: 'CAPACITY_REQUIRED', ready: (input) => isWholePositive(input.weeklyCapacitySlots) },
  { blocker: 'ELIGIBLE_CREW_REQUIRED', ready: (input) => isWholePositive(input.eligibleCrewCount) },
  { blocker: 'INVALID_PRICE_CORRIDOR', ready: hasValidPriceCorridor },
  { blocker: 'PROOF_RECIPE_REQUIRED', ready: (input) => input.proofChecklist.some((item) => item.trim().length > 0) },
  { blocker: 'CREDENTIALS_NOT_MET', ready: (input) => input.credentialRequirementsMet },
];

export function evaluateServiceProfileReadiness(
  input: ServiceProfileReadinessInput,
): { ready: boolean; blockers: ServiceProfileReadinessBlocker[] } {
  const blockers = READINESS_RULES
    .filter(({ ready }) => !ready(input))
    .map(({ blocker }) => blocker);
  return { ready: blockers.length === 0, blockers };
}
