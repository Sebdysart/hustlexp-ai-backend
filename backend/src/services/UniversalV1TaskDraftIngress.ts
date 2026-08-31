import crypto from 'node:crypto';

import { deriveTaskTemplatePolicy } from './TaskTemplatePolicy.js';
import { TEMPLATE_SLUGS, type TemplateSlug } from './TaskTemplateRegistry.js';

export const UNIVERSAL_V1_ROUTING_OUTCOMES = [
  'FULFILLMENT_CANDIDATE',
  'ESTIMATE_REQUIRED',
  'MANUAL_SOURCING',
  'REFERRAL',
  'WAITLIST',
  'DECLINE',
] as const;

export type UniversalV1RoutingOutcome = (typeof UNIVERSAL_V1_ROUTING_OUTCOMES)[number];

export const UNIVERSAL_V1_ROUTING_POLICY_VERSION = 'universal-v1-intake-1.2.0';

export type TaskDraftCategory =
  | 'moving'
  | 'furniture_assembly'
  | 'errands'
  | 'yard'
  | 'tech'
  | 'cleaning'
  | 'handyman'
  | 'other';

export const UNIVERSAL_V1_WORK_CATEGORY_CODES = [
  'moving',
  'furniture_assembly',
  'errands',
  'yard',
  'tech',
  'cleaning',
  'handyman',
  'other',
  'plumbing',
  'electrical',
  'hvac',
  'roofing',
  'general_contracting',
] as const;

export type UniversalV1WorkCategoryCode =
  (typeof UNIVERSAL_V1_WORK_CATEGORY_CODES)[number];

export type UniversalV1RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';

export type UniversalV1ServiceCellAvailability =
  | 'ACTIVE'
  | 'WAITLIST'
  | 'UNAVAILABLE'
  | 'UNRESOLVED';

export type UniversalV1ServiceCellEnvironment =
  | 'local'
  | 'preview'
  | 'staging'
  | 'production';

export interface UniversalV1ServiceCellAuthoritySnapshot {
  id: string;
  postalCode: string;
  regionCode: string;
  roughLocation: string;
  availability: Exclude<UniversalV1ServiceCellAvailability, 'UNRESOLVED'>;
  environment: UniversalV1ServiceCellEnvironment;
  authorityKind: 'SYNTHETIC_FIXTURE' | 'SIGNED_DATASET';
  authorityVersion: number;
  evidenceSha256: string;
}

export interface UniversalV1TaskDraftRouteContext {
  workCategoryCode: UniversalV1WorkCategoryCode;
  regionCode: string | null;
  roughLocation: string | null;
  riskLevel: UniversalV1RiskLevel;
  requiresProof: true;
  finalAvailabilityConfirmationRequired: true;
  postalCode: string | null;
  serviceCellAuthorityId: string | null;
  serviceCellAuthorityVersion: number | null;
  serviceCellAuthorityEnvironment: UniversalV1ServiceCellEnvironment | null;
  serviceCellAuthorityKind: 'SYNTHETIC_FIXTURE' | 'SIGNED_DATASET' | null;
  serviceCellEvidenceSha256: string | null;
  serviceCellAvailability: UniversalV1ServiceCellAvailability;
  blockerCodes: string[];
}

export interface UniversalV1ServiceCellResolution {
  postalCode: string | null;
  authority: UniversalV1ServiceCellAuthoritySnapshot | null;
  blockerCodes: string[];
}

export interface TaskDraftRoutingInput {
  category: TaskDraftCategory;
  rawInput: string;
  answers: Record<string, unknown>;
  safetyEvidence: string;
  serverRiskFlags: readonly string[];
  scopeEvidenceComplete: boolean;
  nowMs: number;
  routeContext: UniversalV1TaskDraftRouteContext;
}

export interface TaskDraftRoutingDecision {
  outcome: UniversalV1RoutingOutcome;
  reasonCodes: string[];
  policyVersion: string;
  routeContext: UniversalV1TaskDraftRouteContext | null;
}

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
  'errands',
  'tech',
  'cleaning',
  'handyman',
]);

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
  outcome: UniversalV1RoutingOutcome,
  reasonCodes: string[],
): TaskDraftRoutingDecision {
  const completeReasonCodes = [
    ...reasonCodes,
    ...input.routeContext.blockerCodes.filter((code) => !reasonCodes.includes(code)),
  ];
  return {
    outcome,
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

const UNIVERSAL_V1_RISK_ORDER: Record<UniversalV1RiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  IN_HOME: 3,
};

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
  const workCategoryCode = ambiguousTradeScope
    ? 'other'
    : tradeCategories[0] ?? input.category;
  const authority = input.serviceCell.authority;
  return {
    workCategoryCode,
    regionCode: authority?.regionCode ?? null,
    roughLocation: authority?.roughLocation ?? null,
    riskLevel: riskLevelFor(workCategoryCode, input.serverRiskFlags, normalized),
    requiresProof: true,
    finalAvailabilityConfirmationRequired: true,
    postalCode: input.serviceCell.postalCode,
    serviceCellAuthorityId: authority?.id ?? null,
    serviceCellAuthorityVersion: authority?.authorityVersion ?? null,
    serviceCellAuthorityEnvironment: authority?.environment ?? null,
    serviceCellAuthorityKind: authority?.authorityKind ?? null,
    serviceCellEvidenceSha256: authority?.evidenceSha256 ?? null,
    serviceCellAvailability: authority?.availability ?? 'UNRESOLVED',
    blockerCodes: [
      ...input.serviceCell.blockerCodes,
      ...(ambiguousTradeScope ? ['AMBIGUOUS_CREDENTIALED_TRADE_SCOPE'] : []),
    ],
  };
}

/**
 * Conservative Charter routing. This function creates no opportunity, quote,
 * assignment, payment authorization, or provider promise. Client-supplied
 * signals can only narrow the result (decline/waitlist/manual review); they do
 * not independently establish provider eligibility or availability.
 */
export function evaluateUniversalV1TaskDraftRouting(
  input: TaskDraftRoutingInput,
): TaskDraftRoutingDecision {
  const raw = `${input.rawInput}\n${input.safetyEvidence}`.normalize('NFKC');
  if (EMERGENCY_SIGNALS.some((signal) => signal.test(raw))) {
    return routeDecision(input, 'DECLINE', ['EMERGENCY_SERVICE_NOT_OFFERED']);
  }
  if (PROHIBITED_SIGNALS.some((signal) => signal.test(raw))) {
    return routeDecision(input, 'DECLINE', ['PROHIBITED_SCOPE']);
  }
  if (input.routeContext.blockerCodes.includes('AMBIGUOUS_CREDENTIALED_TRADE_SCOPE')) {
    return routeDecision(input, 'MANUAL_SOURCING', [
      'AMBIGUOUS_CREDENTIALED_TRADE_SCOPE',
    ]);
  }
  if (CONTROLLED_REFERRAL_SIGNALS.some((signal) => signal.test(raw))) {
    return routeDecision(input, 'REFERRAL', ['CONTROLLED_CATEGORY_REFERRAL_ONLY']);
  }
  if (answerString(input.answers, 'supply_state') === 'TEMPORARILY_UNAVAILABLE') {
    return routeDecision(input, 'WAITLIST', ['PUBLIC_CATEGORY_INTAKE_UNAVAILABLE']);
  }
  if (input.routeContext.serviceCellAvailability === 'WAITLIST') {
    return routeDecision(input, 'WAITLIST', ['SERVICE_CELL_WAITLIST']);
  }
  if (input.routeContext.serviceCellAvailability === 'UNAVAILABLE') {
    return routeDecision(input, 'MANUAL_SOURCING', ['SERVICE_CELL_UNAVAILABLE']);
  }
  if (input.routeContext.serviceCellAvailability === 'UNRESOLVED') {
    return routeDecision(
      input,
      'MANUAL_SOURCING',
      input.routeContext.blockerCodes.length > 0
        ? [...input.routeContext.blockerCodes]
        : ['SERVICE_CELL_AUTHORITY_UNRESOLVED'],
    );
  }
  if (CREDENTIALED_TRADE_CATEGORIES.has(input.routeContext.workCategoryCode)) {
    return routeDecision(input, 'ESTIMATE_REQUIRED', [
      'CREDENTIALED_TRADE_REVIEW_REQUIRED',
    ]);
  }
  // A client risk label is not authoritative evidence that legitimate work is
  // prohibited. Preserve it as a fail-closed review signal after the server has
  // already recognized credentialed trade scope, and before any fulfillment
  // candidacy can be emitted.
  if (answerString(input.answers, 'risk_level') === 'RED') {
    return routeDecision(input, 'MANUAL_SOURCING', ['CLIENT_RISK_REVIEW_REQUIRED']);
  }
  if (input.category === 'yard') {
    return routeDecision(input, 'ESTIMATE_REQUIRED', ['VARIABLE_SCOPE_REQUIRES_ESTIMATE']);
  }
  if (input.serverRiskFlags.length > 0) {
    return routeDecision(input, 'ESTIMATE_REQUIRED', ['SAFETY_OR_SCOPE_ESTIMATE_REQUIRED']);
  }
  if (
    STANDARDIZED_GENERAL_CATEGORIES.has(input.category)
    && input.scopeEvidenceComplete
    && confirmedScopeAtIsCurrent(
      answerString(input.answers, 'scope_confirmed_at'),
      input.nowMs,
    )
  ) {
    return routeDecision(input, 'FULFILLMENT_CANDIDATE', [
      'STANDARDIZED_SCOPE_CANDIDATE_ONLY',
    ]);
  }
  return routeDecision(input, 'MANUAL_SOURCING', ['SCOPE_OR_SUPPLY_REVIEW_REQUIRED']);
}

/** Remove contact PII and exact street addresses from the TaskDraft aggregate. */
export function sanitizeTaskDraftText(input: string): string {
  const withoutDirectIdentifiers = input
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/giu, '')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/gu, '')
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gu, '');
  const withoutPhones = withoutDirectIdentifiers
    .split(/(\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?\b)/gu)
    .map((segment, index) => index % 2 === 1
      ? segment
      : segment.replace(/\+?\d[\d\s().-]{6,}\d/gu, ''))
    .join('');
  return withoutPhones
    .replace(
      /\b\d{1,6}\s+(?:(?:n|s|e|w|ne|nw|se|sw|north|south|east|west)\s+)?(?:[A-Za-z0-9.'-]+\s+){1,5}(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|ct|court|way|pl|place|ter|terrace|cir|circle)\b\.?(?:\s+(?:apt|apartment|unit|suite|#)\s*[A-Za-z0-9-]+)?/giu,
      '',
    )
    .split('')
    .map((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint < 32 || codePoint === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

/** Reject obvious placeholders/repeated low-entropy capabilities at ingress. */
export function isPlausiblyRandomTaskDraftCardToken(token: string): boolean {
  if (!/^[0-9a-f]{64}$/iu.test(token)) return false;
  const normalized = token.toLowerCase();
  const bytes = normalized.match(/.{2}/gu) ?? [];
  if (new Set(bytes).size < 8 || new Set(normalized).size < 10) return false;
  for (let period = 1; period <= normalized.length / 2; period += 1) {
    if (normalized.length % period === 0
      && normalized.slice(0, period).repeat(normalized.length / period) === normalized) {
      return false;
    }
  }
  return true;
}

export function sanitizeTaskDraftAnswers(
  input: Record<string, unknown>,
): Record<string, string | string[] | boolean | number> {
  const output: Record<string, string | string[] | boolean | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (/address|street|email|phone|(?:^|_)name(?:$|_)|ssn|social_security|date_of_birth|(?:^|_)dob(?:$|_)/iu.test(key)) continue;
    if (typeof value === 'string') {
      output[key] = sanitizeTaskDraftText(value) || '[details redacted]';
    } else if (Array.isArray(value)) {
      output[key] = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => sanitizeTaskDraftText(item) || '[details redacted]');
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      output[key] = value;
    }
  }
  return output;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export function universalTaskDraftRequestHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function taskDraftCardTokenHash(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function taskDraftMutationIdempotencyKey(
  submissionId: string,
  expectedVersion: number,
): string {
  return `taskdraft:${submissionId}:v${expectedVersion + 1}`;
}
