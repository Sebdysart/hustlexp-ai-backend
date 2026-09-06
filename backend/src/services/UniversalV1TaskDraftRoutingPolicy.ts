import { deriveTaskTemplatePolicy } from './TaskTemplatePolicy.js';
import { TEMPLATE_SLUGS, type TemplateSlug } from './TaskTemplateRegistry.js';
import { exactStandardizedScopeIsEligible } from './UniversalV1StandardizedScopePolicy.js';
import {
  UNIVERSAL_V1_ROUTING_POLICY_VERSION,
  type TaskDraftCategory,
  type TaskDraftRoutingDecision,
  type TaskDraftRoutingInput,
  type UniversalV1RiskLevel,
  type UniversalV1RoutingOutcome,
  type UniversalV1ServiceCellAuthoritySnapshot,
  type UniversalV1ServiceCellResolution,
  type UniversalV1TaskDraftRouteContext,
  type UniversalV1WorkCategoryCode,
} from './UniversalV1TaskDraftContracts.js';

const EMERGENCY_SIGNALS = [
  /\bactive gas leak\b/iu,
  /\b(?:house|building|electrical) fire\b/iu,
  /\belectrocution\b/iu,
  /\bsevere flooding\b/iu,
  /\bstructural instability\b/iu,
  /\bemergency utility work\b/iu,
  /\bimmediate danger\b/iu,
];

const PROHIBITED_SIGNALS = [
  /\basbestos\b/iu,
  /\bhazardous materials?\b/iu,
  /\bregulated waste\b/iu,
  /\bbiohazard\b/iu,
  /\bmold (?:cleanup|remediation|removal)\b/iu,
  /\bcrime[- ]scene cleanup\b/iu,
  /\bmedical cleanup\b/iu,
  /\bregulated pesticide application\b/iu,
  /\btree removal\b/iu,
  /\bexcavation\b/iu,
  /\bchildcare\b/iu,
  /\bmedical care\b/iu,
  /\bpersonal care\b/iu,
  /\b(?:alcohol|tobacco|prescription) (?:errand|delivery|pickup)\b/iu,
  /\bcontrolled substances?\b/iu,
  /\bweapons?\b/iu,
  /\bgambling\b/iu,
  /\bhack(?:ing)? (?:an )?account\b/iu,
  /\baccount takeover\b/iu,
  /\bcredential bypass\b/iu,
  /\bunlawful surveillance\b/iu,
  /\bunlawful data access\b/iu,
];

const CREDENTIALED_TRADE_RULES: ReadonlyArray<{
  workCategoryCode: Extract<
    UniversalV1WorkCategoryCode,
    'plumbing' | 'electrical' | 'hvac' | 'roofing' | 'general_contracting'
  >;
  signals: readonly RegExp[];
}> = [
  {
    workCategoryCode: 'plumbing',
    signals: [/\bplumb(?:er|ing)\b/iu, /\b(?:water|sewer|gas) lines?\b/iu],
  },
  {
    workCategoryCode: 'electrical',
    signals: [/\belectric(?:al|ian)\b/iu, /\b(?:breaker|service) panels?\b/iu],
  },
  {
    workCategoryCode: 'hvac',
    signals: [/\bhvac\b/iu, /\b(?:furnace|heat pump|air conditioner)\b/iu],
  },
  {
    workCategoryCode: 'roofing',
    signals: [/\broof(?:ing|er)?\b/iu],
  },
  {
    workCategoryCode: 'general_contracting',
    signals: [
      /\bgeneral contractor\b/iu,
      /\bstructural (?:repair|modification|work)\b/iu,
      /\bpermit(?:ted|required)\b/iu,
    ],
  },
];

const CREDENTIALED_TRADE_CATEGORIES = new Set<UniversalV1WorkCategoryCode>(
  CREDENTIALED_TRADE_RULES.map((rule) => rule.workCategoryCode),
);

const CONTROLLED_REFERRAL_SIGNALS = [
  /\bground[- ]level pressure washing\b/iu,
  /\b(?:light )?hauling\b/iu,
];

const STANDARDIZED_GENERAL_CATEGORIES = new Set<TaskDraftCategory>([
  'moving',
  'furniture_assembly',
  // Do not emit a fixed-price fulfillment route without a reviewed canonical
  // Price Book row. Other legitimate general work remains manual sourcing
  // until its deterministic scope and economics are separately approved.
]);

const UNIVERSAL_V1_RISK_ORDER: Record<UniversalV1RiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  IN_HOME: 3,
};
interface RoutingRuleResult {
  outcome: UniversalV1RoutingOutcome;
  reasonCodes: string[];
}
type RoutingRule = (
  input: TaskDraftRoutingInput,
  normalizedEvidence: string,
) => RoutingRuleResult | null;

function answerString(answers: Record<string, unknown>, key: string): string {
  const value = answers[key];
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}
function confirmedScopeAtIsCurrent(value: string, nowMs: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && Math.abs(nowMs - parsed) <= 10 * 60 * 1_000;
}

function routeDecision(
  input: TaskDraftRoutingInput,
  result: RoutingRuleResult,
): TaskDraftRoutingDecision {
  const completeReasonCodes = [
    ...result.reasonCodes,
    ...input.routeContext.blockerCodes.filter((code) => !result.reasonCodes.includes(code)),
  ];
  return {
    outcome: result.outcome,
    reasonCodes: completeReasonCodes,
    policyVersion: UNIVERSAL_V1_ROUTING_POLICY_VERSION,
    routeContext: input.routeContext,
  };
}

function normalizedTradeCategories(input: string): UniversalV1WorkCategoryCode[] {
  return CREDENTIALED_TRADE_RULES
    .filter((rule) => rule.signals.some((signal) => signal.test(input)))
    .map((rule) => rule.workCategoryCode);
}
function routeTemplateFor(workCategoryCode: UniversalV1WorkCategoryCode): TemplateSlug {
  if (workCategoryCode === 'cleaning' || workCategoryCode === 'handyman') {
    return TEMPLATE_SLUGS.IN_HOME;
  }
  if (CREDENTIALED_TRADE_CATEGORIES.has(workCategoryCode)) {
    return TEMPLATE_SLUGS.SPECIALIZED_LICENSED;
  }
  return TEMPLATE_SLUGS.STANDARD_PHYSICAL;
}

function stricterRiskLevel(
  left: UniversalV1RiskLevel,
  right: UniversalV1RiskLevel,
): UniversalV1RiskLevel {
  return UNIVERSAL_V1_RISK_ORDER[left] >= UNIVERSAL_V1_RISK_ORDER[right] ? left : right;
}
function riskLevelFor(
  workCategoryCode: UniversalV1WorkCategoryCode,
  serverRiskFlags: readonly string[],
  scopeEvidence: string,
): UniversalV1RiskLevel {
  let routeFloor: UniversalV1RiskLevel = 'LOW';
  if (serverRiskFlags.some((flag) =>
    /height|ladder|tree|chainsaw|hazardous|heavy machinery/iu.test(flag))) {
    routeFloor = 'HIGH';
  } else if (
    CREDENTIALED_TRADE_CATEGORIES.has(workCategoryCode)
    || serverRiskFlags.length > 0
  ) {
    routeFloor = 'MEDIUM';
  }
  const existingPolicyRisk = deriveTaskTemplatePolicy({
    description: scopeEvidence,
    templateSlug: routeTemplateFor(workCategoryCode),
  }).riskLevel;
  return stricterRiskLevel(routeFloor, existingPolicyRisk);
}

function selectWorkCategory(
  category: TaskDraftCategory,
  tradeCategories: readonly UniversalV1WorkCategoryCode[],
): UniversalV1WorkCategoryCode {
  if (tradeCategories.length > 1) return 'other';
  return tradeCategories[0] ?? category;
}

function authorityRouteFields(
  authority: UniversalV1ServiceCellAuthoritySnapshot | null,
) {
  if (authority === null) {
    return {
      regionCode: null,
      roughLocation: null,
      serviceCellAuthorityId: null,
      serviceCellAuthorityVersion: null,
      serviceCellAuthorityEnvironment: null,
      serviceCellAuthorityKind: null,
      serviceCellEvidenceSha256: null,
      serviceCellAvailability: 'UNRESOLVED' as const,
    };
  }
  return {
    regionCode: authority.regionCode,
    roughLocation: authority.roughLocation,
    serviceCellAuthorityId: authority.id,
    serviceCellAuthorityVersion: authority.authorityVersion,
    serviceCellAuthorityEnvironment: authority.environment,
    serviceCellAuthorityKind: authority.authorityKind,
    serviceCellEvidenceSha256: authority.evidenceSha256,
    serviceCellAvailability: authority.availability,
  };
}

function routeBlockerCodes(
  serviceCell: UniversalV1ServiceCellResolution,
  ambiguousTradeScope: boolean,
): string[] {
  if (!ambiguousTradeScope) return [...serviceCell.blockerCodes];
  return [...serviceCell.blockerCodes, 'AMBIGUOUS_CREDENTIALED_TRADE_SCOPE'];
}
/**
 * Build the immutable server-owned route snapshot. Client category remains a
 * coarse parser hint; explicit trade evidence wins, while mixed trades never
 * silently select a credential category.
 */
export function buildUniversalV1TaskDraftRouteContext(input: {
  category: TaskDraftCategory;
  rawInput: string;
  safetyEvidence: string;
  serverRiskFlags: readonly string[];
  serviceCell: UniversalV1ServiceCellResolution;
}): UniversalV1TaskDraftRouteContext {
  const normalized = `${input.rawInput}\n${input.safetyEvidence}`.normalize('NFKC');
  const tradeCategories = normalizedTradeCategories(normalized);
  const ambiguousTradeScope = tradeCategories.length > 1;
  const workCategoryCode = selectWorkCategory(input.category, tradeCategories);
  return {
    workCategoryCode,
    ...authorityRouteFields(input.serviceCell.authority),
    riskLevel: riskLevelFor(workCategoryCode, input.serverRiskFlags, normalized),
    requiresProof: true,
    finalAvailabilityConfirmationRequired: true,
    postalCode: input.serviceCell.postalCode,
    blockerCodes: routeBlockerCodes(input.serviceCell, ambiguousTradeScope),
  };
}

function emergencyRule(
  _input: TaskDraftRoutingInput,
  normalizedEvidence: string,
): RoutingRuleResult | null {
  return EMERGENCY_SIGNALS.some((signal) => signal.test(normalizedEvidence))
    ? { outcome: 'DECLINE', reasonCodes: ['EMERGENCY_SERVICE_NOT_OFFERED'] }
    : null;
}

function prohibitedRule(
  _input: TaskDraftRoutingInput,
  normalizedEvidence: string,
): RoutingRuleResult | null {
  return PROHIBITED_SIGNALS.some((signal) => signal.test(normalizedEvidence))
    ? { outcome: 'DECLINE', reasonCodes: ['PROHIBITED_SCOPE'] }
    : null;
}

function ambiguousTradeRule(input: TaskDraftRoutingInput): RoutingRuleResult | null {
  return input.routeContext.blockerCodes.includes('AMBIGUOUS_CREDENTIALED_TRADE_SCOPE')
    ? {
      outcome: 'MANUAL_SOURCING',
      reasonCodes: ['AMBIGUOUS_CREDENTIALED_TRADE_SCOPE'],
    }
    : null;
}

function controlledReferralRule(
  _input: TaskDraftRoutingInput,
  normalizedEvidence: string,
): RoutingRuleResult | null {
  return CONTROLLED_REFERRAL_SIGNALS.some((signal) => signal.test(normalizedEvidence))
    ? { outcome: 'REFERRAL', reasonCodes: ['CONTROLLED_CATEGORY_REFERRAL_ONLY'] }
    : null;
}

function declaredSupplyRule(input: TaskDraftRoutingInput): RoutingRuleResult | null {
  return answerString(input.answers, 'supply_state') === 'TEMPORARILY_UNAVAILABLE'
    ? { outcome: 'WAITLIST', reasonCodes: ['PUBLIC_CATEGORY_INTAKE_UNAVAILABLE'] }
    : null;
}

function serviceCellRule(input: TaskDraftRoutingInput): RoutingRuleResult | null {
  switch (input.routeContext.serviceCellAvailability) {
    case 'WAITLIST':
      return { outcome: 'WAITLIST', reasonCodes: ['SERVICE_CELL_WAITLIST'] };
    case 'UNAVAILABLE':
      return { outcome: 'MANUAL_SOURCING', reasonCodes: ['SERVICE_CELL_UNAVAILABLE'] };
    case 'UNRESOLVED':
      return {
        outcome: 'MANUAL_SOURCING',
        reasonCodes: input.routeContext.blockerCodes.length > 0
          ? [...input.routeContext.blockerCodes]
          : ['SERVICE_CELL_AUTHORITY_UNRESOLVED'],
      };
    default:
      return null;
  }
}

function credentialedTradeRule(input: TaskDraftRoutingInput): RoutingRuleResult | null {
  return CREDENTIALED_TRADE_CATEGORIES.has(input.routeContext.workCategoryCode)
    ? {
      outcome: 'ESTIMATE_REQUIRED',
      reasonCodes: ['CREDENTIALED_TRADE_REVIEW_REQUIRED'],
    }
    : null;
}

function clientRiskRule(input: TaskDraftRoutingInput): RoutingRuleResult | null {
  return answerString(input.answers, 'risk_level') === 'RED'
    ? { outcome: 'MANUAL_SOURCING', reasonCodes: ['CLIENT_RISK_REVIEW_REQUIRED'] }
    : null;
}

function variableScopeRule(input: TaskDraftRoutingInput): RoutingRuleResult | null {
  return input.category === 'yard'
    ? { outcome: 'ESTIMATE_REQUIRED', reasonCodes: ['VARIABLE_SCOPE_REQUIRES_ESTIMATE'] }
    : null;
}

function serverRiskRule(input: TaskDraftRoutingInput): RoutingRuleResult | null {
  return input.serverRiskFlags.length > 0
    ? {
      outcome: 'ESTIMATE_REQUIRED',
      reasonCodes: ['SAFETY_OR_SCOPE_ESTIMATE_REQUIRED'],
    }
    : null;
}

function standardizedScopeRule(input: TaskDraftRoutingInput): RoutingRuleResult | null {
  if (!STANDARDIZED_GENERAL_CATEGORIES.has(input.category)) return null;
  const scopeConfirmed = confirmedScopeAtIsCurrent(
    answerString(input.answers, 'scope_confirmed_at'),
    input.nowMs,
  );
  if (input.scopeEvidenceComplete && scopeConfirmed && exactStandardizedScopeIsEligible(input)) {
    return {
      outcome: 'FULFILLMENT_CANDIDATE',
      reasonCodes: ['STANDARDIZED_SCOPE_CANDIDATE_ONLY'],
    };
  }
  return {
    outcome: 'ESTIMATE_REQUIRED',
    reasonCodes: ['STANDARDIZED_SCOPE_REQUIRES_ESTIMATE'],
  };
}

const ROUTING_RULES: readonly RoutingRule[] = [
  emergencyRule,
  prohibitedRule,
  ambiguousTradeRule,
  controlledReferralRule,
  declaredSupplyRule,
  serviceCellRule,
  credentialedTradeRule,
  // A client risk label is not authoritative evidence that legitimate work is
  // prohibited. Preserve it as a fail-closed review signal after the server has
  // already recognized credentialed trade scope, and before any fulfillment
  // candidacy can be emitted.
  clientRiskRule,
  variableScopeRule,
  serverRiskRule,
  standardizedScopeRule,
];

/**
 * Conservative Charter routing. This function creates no opportunity, quote,
 * assignment, payment authorization, or provider promise. Client-supplied
 * signals can only narrow the result (decline/waitlist/manual review); they do
 * not independently establish provider eligibility or availability.
 */
export function evaluateUniversalV1TaskDraftRouting(
  input: TaskDraftRoutingInput,
): TaskDraftRoutingDecision {
  const normalizedEvidence = `${input.rawInput}\n${input.safetyEvidence}`.normalize('NFKC');
  for (const rule of ROUTING_RULES) {
    const result = rule(input, normalizedEvidence);
    if (result !== null) return routeDecision(input, result);
  }
  return routeDecision(input, {
    outcome: 'MANUAL_SOURCING',
    reasonCodes: ['SCOPE_OR_SUPPLY_REVIEW_REQUIRED'],
  });
}
