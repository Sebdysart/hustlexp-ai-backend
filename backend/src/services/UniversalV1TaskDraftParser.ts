import type { TaskDraftCategory } from './UniversalV1TaskDraftIngress';

export type SanitizedTaskDraftAnswer = string | string[] | boolean | number;

export interface UniversalV1TaskDraftParserInput {
  /** Contact PII and exact addresses must be removed by ingress before parsing. */
  sanitizedRaw: string;
  category: TaskDraftCategory;
  /** Answer keys and values must be sanitized by ingress before parsing. */
  sanitizedAnswers: Record<string, SanitizedTaskDraftAnswer>;
}

export interface UniversalV1TaskDraftParse {
  title: string;
  category: TaskDraftCategory;
  scope_summary: string;
  labor_label: string;
  /** Display guidance only. This value is never an authorization or charge amount. */
  est_price_min_cents: number;
  /** Display guidance only. This value is never an authorization or charge amount. */
  est_price_max_cents: number;
  /** A literal guard against treating either estimate bound as payable value. */
  estimate_display_only: true;
  required_skills: string[];
  required_tools: string[];
  risk_flags: string[];
  missing_questions: string[];
  recommended_hustler_profile: string;
  /** Deterministic, sanitized answer evidence evaluated by the safety rules. */
  safetyEvidence: string;
}

interface AdaptiveQuestion {
  key: string;
  label: string;
  kind: 'select' | 'multiselect' | 'yesno' | 'text';
  options?: ReadonlyArray<{ value: string; label: string }>;
  required?: boolean;
}

const CATEGORY_LABELS: Record<TaskDraftCategory, string> = {
  moving: 'Moving / hauling',
  furniture_assembly: 'Furniture assembly',
  errands: 'Errand / delivery',
  yard: 'Yard help',
  tech: 'Tech help',
  cleaning: 'Cleaning',
  handyman: 'Handyman / repair',
  other: 'Task',
};

const PRICE_RANGES: Record<TaskDraftCategory, { minCents: number; maxCents: number }> = {
  moving: { minCents: 12000, maxCents: 40000 },
  furniture_assembly: { minCents: 6000, maxCents: 20000 },
  errands: { minCents: 4000, maxCents: 12000 },
  yard: { minCents: 10000, maxCents: 35000 },
  tech: { minCents: 6000, maxCents: 18000 },
  cleaning: { minCents: 12000, maxCents: 30000 },
  handyman: { minCents: 9000, maxCents: 25000 },
  other: { minCents: 6000, maxCents: 25000 },
};

const LABOR_LABELS: Record<TaskDraftCategory, string> = {
  moving: '1.5–4 hours',
  furniture_assembly: '45 min–2.5 hours',
  errands: '30–90 min',
  yard: '1–3.5 hours',
  tech: '45 min–2 hours',
  cleaning: '1.5–3.5 hours',
  handyman: '1–3 hours',
  other: '1–3 hours',
};

const SKILLS: Record<TaskDraftCategory, readonly string[]> = {
  moving: ['heavy lifting', 'furniture handling'],
  furniture_assembly: ['flat-pack assembly', 'basic hand tools'],
  errands: ['reliable transportation', 'time management'],
  yard: ['yard work', 'debris hauling'],
  tech: ['device setup', 'basic wiring'],
  cleaning: ['detail cleaning'],
  handyman: ['basic repairs', 'hand & power tools'],
  other: ['general labor'],
};

const TOOLS: Record<TaskDraftCategory, readonly string[]> = {
  moving: ['moving dolly', 'straps', 'vehicle / truck'],
  furniture_assembly: ['screwdriver', 'allen keys', 'drill (optional)'],
  errands: ['vehicle'],
  yard: ['rake', 'yard bags', 'trimmer (if available)'],
  tech: ['basic tools', 'cables'],
  cleaning: ['cleaning supplies'],
  handyman: ['hand tools', 'drill'],
  other: [],
};

const PROFILES: Record<TaskDraftCategory, string> = {
  moving: '2-person crew with a truck or van',
  furniture_assembly: 'Solo handy helper with basic tools',
  errands: 'Helper with a reliable vehicle',
  yard: 'Yard / landscaping helper with hauling capacity',
  tech: 'Tech-savvy helper',
  cleaning: 'Detail-oriented cleaner',
  handyman: 'Handyman with own tools',
  other: 'General task helper',
};

const RISK_RULES: ReadonlyArray<{ flag: string; keywords: readonly string[] }> = [
  {
    flag: 'Height / ladder work',
    keywords: ['ladder', 'roof', 'gutter', 'second story', '2nd story', 'high up'],
  },
  { flag: 'Tree / chainsaw work', keywords: ['tree', 'chainsaw', 'branch', 'stump'] },
  { flag: 'Electrical', keywords: ['electrical', 'wiring', 'outlet', 'breaker', 'rewire'] },
  { flag: 'Plumbing / water', keywords: ['plumb', 'water line', 'pipe', 'leak'] },
  {
    flag: 'Heavy items (2+ people)',
    keywords: [
      'piano',
      'safe',
      'fridge',
      'refrigerator',
      'washer',
      'dryer',
      'heavy',
      'bulky',
      'over 150',
    ],
  },
  { flag: 'Stairs / constrained access', keywords: ['stairs', 'staircase'] },
  { flag: 'Licensed gas work', keywords: ['gas line', 'natural gas'] },
  {
    flag: 'Hazardous materials',
    keywords: ['asbestos', 'hazardous material', 'biohazard', 'mold remediation'],
  },
  { flag: 'Heavy machinery', keywords: ['forklift', 'excavator', 'heavy machinery'] },
  { flag: 'Pets on site', keywords: ['dog', 'cat', 'pet'] },
];

const ADAPTIVE_QUESTIONS: Record<TaskDraftCategory, readonly AdaptiveQuestion[]> = {
  moving: [
    {
      key: 'size_weight',
      label: 'How heavy are the items?',
      kind: 'select',
      required: true,
      options: [
        { value: 'light', label: 'Light (one person)' },
        { value: 'medium', label: 'Medium' },
        { value: 'heavy', label: 'Heavy (needs two)' },
        { value: 'very_heavy', label: 'Very heavy / bulky' },
      ],
    },
    {
      key: 'access',
      label: 'Stairs or elevator?',
      kind: 'select',
      required: true,
      options: [
        { value: 'ground', label: 'Ground floor' },
        { value: 'stairs', label: 'Stairs' },
        { value: 'elevator', label: 'Elevator' },
      ],
    },
    {
      key: 'move_type',
      label: 'Same property or transport across town?',
      kind: 'select',
      required: true,
      options: [
        { value: 'same', label: 'Same property' },
        { value: 'transport', label: 'Transport to another address' },
      ],
    },
    {
      key: 'workers_needed',
      label: 'How many helpers?',
      kind: 'select',
      options: [
        { value: 'one', label: 'One' },
        { value: 'two', label: 'Two' },
        { value: 'three_plus', label: 'Three or more' },
      ],
    },
    { key: 'fragile', label: 'Anything fragile or high-value?', kind: 'yesno' },
    { key: 'timing', label: 'Preferred day / time?', kind: 'text', required: true },
  ],
  yard: [
    { key: 'areas', label: 'Which areas need work?', kind: 'text', required: true },
    { key: 'pressure_washing', label: 'Pressure washing needed?', kind: 'yesno' },
    {
      key: 'equipment_provided',
      label: 'Will you provide equipment?',
      kind: 'yesno',
      required: true,
    },
    {
      key: 'debris',
      label: 'How should debris be handled?',
      kind: 'select',
      required: true,
      options: [
        { value: 'bag_onsite', label: 'Bag on site' },
        { value: 'haul_away', label: 'Haul away' },
        { value: 'bins', label: 'Use my yard-waste bins' },
      ],
    },
    {
      key: 'ladder_tree',
      label: 'Any ladder, tree or chainsaw work?',
      kind: 'yesno',
      required: true,
    },
    { key: 'timing', label: 'Preferred day / time?', kind: 'text', required: true },
  ],
  furniture_assembly: [
    { key: 'item', label: 'What item(s) — brand / model?', kind: 'text', required: true },
    { key: 'product_link', label: 'Product link (optional)', kind: 'text' },
    { key: 'new_in_box', label: 'New in box?', kind: 'yesno', required: true },
    { key: 'tools_included', label: 'Are assembly tools included?', kind: 'yesno' },
    { key: 'old_item_removal', label: 'Remove / haul an old item?', kind: 'yesno' },
    { key: 'timing', label: 'Preferred day / time?', kind: 'text', required: true },
  ],
  errands: [
    { key: 'pickup_dropoff', label: 'Pickup and drop-off areas?', kind: 'text', required: true },
    {
      key: 'item_size',
      label: 'How big is the item?',
      kind: 'select',
      required: true,
      options: [
        { value: 'small', label: 'Small' },
        { value: 'medium', label: 'Medium' },
        { value: 'large', label: 'Large' },
      ],
    },
    { key: 'paid_already', label: 'Is the item already paid for?', kind: 'yesno', required: true },
    { key: 'vehicle_needed', label: 'Is a vehicle required?', kind: 'yesno' },
    { key: 'timing', label: 'Preferred day / time?', kind: 'text', required: true },
  ],
  tech: [
    { key: 'details', label: 'What needs setting up or fixing?', kind: 'text', required: true },
    { key: 'timing', label: 'Preferred day / time?', kind: 'text', required: true },
  ],
  cleaning: [
    {
      key: 'details',
      label: 'What needs cleaning, and how big is the space?',
      kind: 'text',
      required: true,
    },
    { key: 'timing', label: 'Preferred day / time?', kind: 'text', required: true },
  ],
  handyman: [
    { key: 'details', label: 'What needs fixing?', kind: 'text', required: true },
    { key: 'timing', label: 'Preferred day / time?', kind: 'text', required: true },
  ],
  other: [
    { key: 'details', label: 'Tell us a bit more about the task', kind: 'text', required: true },
    { key: 'timing', label: 'Preferred day / time?', kind: 'text', required: true },
  ],
};

const SERVER_DERIVED_NEGATIVE_SCOPE_KEYS = new Set(['excluded_work', 'safety_restrictions']);

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function capFirst(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

function makeTitle(sanitizedRaw: string, category: TaskDraftCategory): string {
  const clean = normalizedText(sanitizedRaw);
  if (clean.length < 3) return CATEGORY_LABELS[category];
  const words = clean.split(' ').slice(0, 9).join(' ');
  return capFirst(words.length > 60 ? `${words.slice(0, 57).trimEnd()}…` : words);
}

function makeScope(sanitizedRaw: string, category: TaskDraftCategory): string {
  const clean = normalizedText(sanitizedRaw);
  return clean.length < 3 ? `${CATEGORY_LABELS[category]} requested.` : clean.slice(0, 280);
}

function isAnswered(value: SanitizedTaskDraftAnswer | undefined): boolean {
  return value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);
}

function missingQuestionsFor(
  category: TaskDraftCategory,
  answers: Record<string, SanitizedTaskDraftAnswer>
): string[] {
  return ADAPTIVE_QUESTIONS[category]
    .filter((question) => question.required === true && !isAnswered(answers[question.key]))
    .map((question) => question.label);
}

function isAffirmative(value: SanitizedTaskDraftAnswer): boolean {
  return value === true || (typeof value === 'string' && /^(?:yes|true|1)$/iu.test(value.trim()));
}

function evidenceItem(question: AdaptiveQuestion, value: string | number): string | null {
  const rawValue = String(value).trim();
  if (!rawValue) return null;
  return question.options?.find((option) => option.value === rawValue)?.label ?? rawValue;
}

function evidenceFragments(
  question: AdaptiveQuestion,
  value: SanitizedTaskDraftAnswer | undefined
): string[] {
  if (value === undefined || value === '') return [];
  if (question.kind === 'yesno') return isAffirmative(value) ? [question.label] : [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    .map((item) => evidenceItem(question, item))
    .filter((item): item is string => item !== null);
}

function readableAnswerKey(key: string): string {
  return key.replace(/[^a-z0-9]+/giu, ' ').trim();
}

function additionalAnswerEvidence(
  category: TaskDraftCategory,
  answers: Record<string, SanitizedTaskDraftAnswer>
): string[] {
  const categoryKeys = new Set(ADAPTIVE_QUESTIONS[category].map((question) => question.key));
  return Object.entries(answers)
    .filter(
      ([key]) =>
        !categoryKeys.has(key) && !SERVER_DERIVED_NEGATIVE_SCOPE_KEYS.has(key.toLowerCase())
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([key, value]) => {
      if (value === false) return [];
      if (value === true) return [readableAnswerKey(key)];
      const values = Array.isArray(value) ? value : [value];
      return values
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    });
}

export function buildUniversalV1TaskDraftSafetyEvidence(
  category: TaskDraftCategory,
  answers: Record<string, SanitizedTaskDraftAnswer>
): string {
  const categoryEvidence = ADAPTIVE_QUESTIONS[category].flatMap((question) =>
    evidenceFragments(question, answers[question.key])
  );
  return [...categoryEvidence, ...additionalAnswerEvidence(category, answers)].join('\n');
}

function detectRiskFlags(input: string): string[] {
  const normalized = input.toLowerCase();
  return RISK_RULES.filter((rule) =>
    rule.keywords.some((keyword) => normalized.includes(keyword))
  ).map((rule) => rule.flag);
}

/**
 * Pure Universal V1 scope parser. It never performs assignment, quote creation,
 * authorization, capture, payout, or another financial effect.
 */
export function parseUniversalV1TaskDraft(
  input: UniversalV1TaskDraftParserInput
): UniversalV1TaskDraftParse {
  const priceRange = PRICE_RANGES[input.category];
  const safetyEvidence = buildUniversalV1TaskDraftSafetyEvidence(
    input.category,
    input.sanitizedAnswers
  );
  const safetyInput = `${input.sanitizedRaw}\n${safetyEvidence}`;

  return {
    title: makeTitle(input.sanitizedRaw, input.category),
    category: input.category,
    scope_summary: makeScope(input.sanitizedRaw, input.category),
    labor_label: LABOR_LABELS[input.category],
    est_price_min_cents: priceRange.minCents,
    est_price_max_cents: priceRange.maxCents,
    estimate_display_only: true,
    required_skills: [...SKILLS[input.category]],
    required_tools: [...TOOLS[input.category]],
    risk_flags: detectRiskFlags(safetyInput),
    missing_questions: missingQuestionsFor(input.category, input.sanitizedAnswers),
    recommended_hustler_profile: PROFILES[input.category],
    safetyEvidence,
  };
}
