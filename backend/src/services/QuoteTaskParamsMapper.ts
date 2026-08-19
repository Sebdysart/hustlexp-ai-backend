import type { CreateTaskParams, TaskRiskLevel } from './TaskServiceShared.js';

type JsonObject = Record<string, unknown>;

interface QuoteTaskDraft {
  id: string;
  category: string;
  title: string | null;
  scope_summary: string | null;
  structured: JsonObject | null;
  zip: string | null;
  region: string | null;
}

interface QuoteVersion {
  id: string;
  total_cents: number;
  hustler_payout_cents: number;
  arrival_window_start: Date;
  arrival_window_end: Date;
  dispatch_expires_at: Date;
}

interface DraftAnswers {
  included_work?: unknown;
  excluded_work?: unknown;
  required_tools?: unknown;
  risk_level?: unknown;
  required_vehicle?: unknown;
  required_worker_count?: unknown;
  preferred_window?: unknown;
  equipment_provided?: unknown;
  safety_restrictions?: unknown;
  scope_confirmed?: unknown;
  scope_policy_version?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (item): item is string =>
      typeof item === 'string' && item.trim().length > 0,
  ).map((item) => item.trim());
}

function mapRiskLevel(value: unknown): TaskRiskLevel {
  switch (String(value ?? '').toLowerCase()) {
    case 'high':
    case 'red':
      return 'HIGH';

    case 'medium':
    case 'yellow':
      return 'MEDIUM';

    case 'in_home':
      return 'IN_HOME';

    case 'low':
    case 'green':
    default:
      return 'LOW';
  }
}

function buildRequirements(answers: DraftAnswers): string | undefined {
  const included = asStringArray(answers.included_work);
  const excluded = asStringArray(answers.excluded_work);
  const restrictions = asStringArray(answers.safety_restrictions);

  const lines: string[] = [];

  for (const item of included) {
    lines.push(`Included: ${item}`);
  }

  for (const item of excluded) {
    lines.push(`Excluded: ${item}`);
  }

  for (const item of restrictions) {
    lines.push(`Safety restriction: ${item}`);
  }

  return lines.length > 0 ? lines.join('\n') : undefined;
}

export interface MapQuoteToTaskParamsInput {
  posterId: string;
  draft: QuoteTaskDraft;
  quoteVersion: QuoteVersion;
  automationClassification: 'PRODUCTION' | 'CONTROLLED_TEST';
  clientIdempotencyKey?: string;
}

export function mapQuoteToCreateTaskParams(
  input: MapQuoteToTaskParamsInput,
): CreateTaskParams {
  const { posterId, draft, quoteVersion } = input;

  const structured = draft.structured ?? {};
  const answers =
    structured.answers && typeof structured.answers === 'object'
      ? structured.answers as DraftAnswers
      : {};

  const payout = Number(quoteVersion.hustler_payout_cents);
  const price = Number(quoteVersion.total_cents);
  const margin = price - payout;

  if (!Number.isInteger(price) || price <= 0) {
    throw new Error('Quote version has invalid total_cents');
  }

  if (!Number.isInteger(payout) || payout <= 0) {
    throw new Error('Quote version has invalid hustler_payout_cents');
  }

  if (!Number.isInteger(margin) || margin < 0) {
    throw new Error('Quote version has invalid platform margin');
  }

  return {
    posterId,

    title: draft.title?.trim() || 'Task',

    description:
      draft.scope_summary?.trim()
      || draft.title?.trim()
      || 'Task',

    requirements: buildRequirements(answers),

    category: draft.category.trim(),

    // The current draft only carries coarse location data.
    // TaskCreatePersistence will redact/store it according to the
    // existing location policy.
    roughArea: asString(draft.zip),
    regionCode: asString(draft.region),

    price,
    hustlerPayoutCents: payout,
    platformMarginCents: margin,

    riskLevel: mapRiskLevel(answers.risk_level),

    requiredTools: asStringArray(answers.required_tools),

    // These are intentionally conservative defaults until the draft schema
    // exposes authoritative values for them.
    requiresProof: true,
    mode: 'STANDARD',
    instantMode: false,
    sensitive: false,

    automationClassification: input.automationClassification,

    dispatchExpiresAt: quoteVersion.dispatch_expires_at,

    // Existing task-create policy defaults will handle the rest.
    clientIdempotencyKey: input.clientIdempotencyKey,
  };
}