import crypto from 'node:crypto';

export const UNIVERSAL_V1_ROUTING_OUTCOMES = [
  'FULFILLMENT_CANDIDATE',
  'ESTIMATE_REQUIRED',
  'MANUAL_SOURCING',
  'REFERRAL',
  'WAITLIST',
  'DECLINE',
] as const;

export type UniversalV1RoutingOutcome = (typeof UNIVERSAL_V1_ROUTING_OUTCOMES)[number];

export const UNIVERSAL_V1_ROUTING_POLICY_VERSION = 'universal-v1-intake-1.1.0';

export type TaskDraftCategory =
  | 'moving'
  | 'furniture_assembly'
  | 'errands'
  | 'yard'
  | 'tech'
  | 'cleaning'
  | 'handyman'
  | 'other';

export interface TaskDraftRoutingInput {
  category: TaskDraftCategory;
  rawInput: string;
  answers: Record<string, unknown>;
  safetyEvidence: string;
  serverRiskFlags: readonly string[];
  scopeEvidenceComplete: boolean;
  nowMs: number;
}

export interface TaskDraftRoutingDecision {
  outcome: UniversalV1RoutingOutcome;
  reasonCodes: string[];
  policyVersion: string;
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

const CREDENTIALED_TRADE_SIGNALS = [
  /\bplumb(?:er|ing)\b/iu,
  /\belectric(?:al|ian)\b/iu,
  /\bhvac\b/iu,
  /\broof(?:ing|er)?\b/iu,
  /\bgeneral contractor\b/iu,
  /\bstructural (?:repair|modification|work)\b/iu,
  /\bpermit(?:ted|required)?\b/iu,
];

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
    return {
      outcome: 'DECLINE',
      reasonCodes: ['EMERGENCY_SERVICE_NOT_OFFERED'],
      policyVersion: UNIVERSAL_V1_ROUTING_POLICY_VERSION,
    };
  }
  if (
    PROHIBITED_SIGNALS.some((signal) => signal.test(raw))
    || answerString(input.answers, 'risk_level') === 'RED'
  ) {
    return {
      outcome: 'DECLINE',
      reasonCodes: ['PROHIBITED_OR_RISK_BLOCKED_SCOPE'],
      policyVersion: UNIVERSAL_V1_ROUTING_POLICY_VERSION,
    };
  }
  if (CREDENTIALED_TRADE_SIGNALS.some((signal) => signal.test(raw))) {
    return {
      outcome: 'ESTIMATE_REQUIRED',
      reasonCodes: ['CREDENTIALED_TRADE_REVIEW_REQUIRED'],
      policyVersion: UNIVERSAL_V1_ROUTING_POLICY_VERSION,
    };
  }
  if (CONTROLLED_REFERRAL_SIGNALS.some((signal) => signal.test(raw))) {
    return {
      outcome: 'REFERRAL',
      reasonCodes: ['CONTROLLED_CATEGORY_REFERRAL_ONLY'],
      policyVersion: UNIVERSAL_V1_ROUTING_POLICY_VERSION,
    };
  }
  if (answerString(input.answers, 'supply_state') === 'TEMPORARILY_UNAVAILABLE') {
    return {
      outcome: 'WAITLIST',
      reasonCodes: ['PUBLIC_CATEGORY_INTAKE_UNAVAILABLE'],
      policyVersion: UNIVERSAL_V1_ROUTING_POLICY_VERSION,
    };
  }
  if (input.category === 'yard') {
    return {
      outcome: 'ESTIMATE_REQUIRED',
      reasonCodes: ['VARIABLE_SCOPE_REQUIRES_ESTIMATE'],
      policyVersion: UNIVERSAL_V1_ROUTING_POLICY_VERSION,
    };
  }
  if (input.serverRiskFlags.length > 0) {
    return {
      outcome: 'ESTIMATE_REQUIRED',
      reasonCodes: ['SAFETY_OR_SCOPE_ESTIMATE_REQUIRED'],
      policyVersion: UNIVERSAL_V1_ROUTING_POLICY_VERSION,
    };
  }
  if (
    STANDARDIZED_GENERAL_CATEGORIES.has(input.category)
    && input.scopeEvidenceComplete
    && confirmedScopeAtIsCurrent(
      answerString(input.answers, 'scope_confirmed_at'),
      input.nowMs,
    )
  ) {
    return {
      outcome: 'FULFILLMENT_CANDIDATE',
      reasonCodes: ['STANDARDIZED_SCOPE_CANDIDATE_ONLY'],
      policyVersion: UNIVERSAL_V1_ROUTING_POLICY_VERSION,
    };
  }
  return {
    outcome: 'MANUAL_SOURCING',
    reasonCodes: ['SCOPE_OR_SUPPLY_REVIEW_REQUIRED'],
    policyVersion: UNIVERSAL_V1_ROUTING_POLICY_VERSION,
  };
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
