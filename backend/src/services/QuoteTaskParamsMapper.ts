import type { CreateTaskParams } from './TaskServiceShared.js';

type JsonObject = Record<string, unknown>;

interface QuoteTaskDraft {
  id: string;
  category: string;
  title: string | null;
  scope_summary: string | null;
  structured: JsonObject | null;
  zip: string | null;
  region: string | null;
  region_code: string | null;
  region_policy_id: string | null;
  region_policy_version: string | null;
  region_policy_hash: string | null;
  region_policy_snapshot: Record<string, unknown> | null;
  scheduled_service_date: string | null;
  validated_risk_level:
    | 'LOW'
    | 'MEDIUM'
    | 'HIGH'
    | 'IN_HOME'
    | null;
  compliance_result: Record<string, unknown> | null;
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
  required_vehicle?: unknown;
  required_worker_count?: unknown;
  preferred_window?: unknown;
  equipment_provided?: unknown;
  safety_restrictions?: unknown;
  scope_confirmed?: unknown;
  scope_policy_version?: unknown;
}

export interface MapQuoteToTaskParamsInput {
  posterId: string;
  draft: QuoteTaskDraft;
  quoteVersion: QuoteVersion;
  automationClassification: 'PRODUCTION' | 'CONTROLLED_TEST';
  clientIdempotencyKey?: string;

  businessOrganizationId?: string | null;
  businessLocationId?: string | null;
  providerServiceProfileId?: string | null;
  claimedByUserId?: string | null;
  businessFulfillerOrganizationId?: string | null;
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

  if (!draft.validated_risk_level) {
    throw new Error(
      'Task draft is missing authoritative risk validation',
    );
  }

  const complianceResult = draft.compliance_result as
    | { score?: unknown }
    | null;
  const complianceScore = typeof complianceResult?.score === 'number'
    && Number.isFinite(complianceResult.score)
    ? complianceResult.score
    : undefined;

  if (!draft.region_code) {
    throw new Error(
      'Task draft is missing authoritative region validation',
    );
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
    regionCode: draft.region_code,

    price,
    hustlerPayoutCents: payout,
    platformMarginCents: margin,

    riskLevel: draft.validated_risk_level,
    illegalRiskScore: complianceScore,
    complianceGuardianNotes: draft.compliance_result ?? {},

    requiredTools: asStringArray(answers.required_tools),

    // These are intentionally conservative defaults until the draft schema
    // exposes authoritative values for them.
    requiresProof: true,
    mode: 'STANDARD',
    instantMode: false,
    sensitive: false,

    automationClassification: input.automationClassification,

    dispatchExpiresAt: quoteVersion.dispatch_expires_at,

    scheduledServiceDate: draft.scheduled_service_date ?? undefined,

    // Existing task-create policy defaults will handle the rest.
    clientIdempotencyKey: input.clientIdempotencyKey,
    
    businessOrganizationId:
      input.businessOrganizationId ?? undefined,

    businessLocationId:
      input.businessLocationId ?? undefined,

    providerOrganizationId:
      undefined,

    providerServiceProfileId:
      input.providerServiceProfileId ?? undefined,

    businessFulfillerOrganizationId:
      input.businessFulfillerOrganizationId ?? undefined,

    orchestrationMode:
      input.businessOrganizationId
        ? 'OPS_MANUAL'
        : 'AUTOMATED',
  };
}
