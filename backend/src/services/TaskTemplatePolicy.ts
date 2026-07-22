import type { ComplianceResult } from './ComplianceGuardianService.js';
import { TaskRisk, TaskRiskClassifier } from './TaskRiskClassifier.js';
import {
  getTemplate,
  isCareContent,
  isContentReleaseRequired,
  TEMPLATE_SLUGS,
  type CompletionCriteriaType,
} from './TaskTemplateRegistry.js';

const IN_HOME_LOCATION = /\b(apartment|condo|house|home|bedroom|bathroom|kitchen|living\s+room|garage|basement|attic)\b/i;
const IN_HOME_ACTIVITY = /\b(clean(?:ing)?|deep\s+clean|organize|repair|fix|install|assemble|paint(?:ing)?|mount|handyman|massage)\b/i;
const EXPLICIT_HOME_ENTRY = /\b(?:inside|enter(?:ing)?|access)\s+(?:my|the|a|an)?\s*(?:apartment|condo|house|home|bedroom|bathroom|kitchen|garage)\b/i;

const LICENSED_WORK = /\b(electric(?:al|ian)?|plumb(?:er|ing)?|structural|hvac|heating|air\s+conditioning|contractor|massage|therap(?:y|ist)|notar(?:y|ize)|gas\s+(?:line|fitting)|elevator)\b/i;

const DETERMINISTIC_BIZARRE = /\b(costume|costumed|mascot|human\s+statue|serenade|performance|perform|performer|audience|crowd\s+work|street\s+theater|flash\s+mob|scatter(?:ing)?\b.{0,60}\bashes|one[-\s]off\s+(?:act|appearance))\b/i;

const TEMPLATE_MINIMUM_PRICE_CENTS: Record<string, number> = {
  [TEMPLATE_SLUGS.STANDARD_PHYSICAL]: 1500,
  [TEMPLATE_SLUGS.IN_HOME]: 4000,
  [TEMPLATE_SLUGS.CARE]: 3600,
  [TEMPLATE_SLUGS.CONTENT_CREATOR]: 2000,
  [TEMPLATE_SLUGS.EVENT_APPEARANCE]: 5400,
  [TEMPLATE_SLUGS.CREATIVE_PRODUCTION]: 5000,
  [TEMPLATE_SLUGS.SPECIALIZED_LICENSED]: 3000,
  [TEMPLATE_SLUGS.WILDCARD_BIZARRE]: 5000,
};

const TRUST_TIER_NUMBER = {
  rookie: 1,
  verified: 2,
  trusted: 3,
  licensed: 4,
} as const;

const RISK_LEVEL_TIER = {
  LOW: TaskRisk.TIER_0,
  MEDIUM: TaskRisk.TIER_1,
  HIGH: TaskRisk.TIER_2,
  IN_HOME: TaskRisk.TIER_3,
} as const;

export interface TaskTemplatePolicyInput {
  description: string;
  templateSlug?: string;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';
  insideHome?: boolean;
  peoplePresent?: boolean;
  petsPresent?: boolean;
  wildcardFlags?: string[];
  complianceResult?: Pick<
    ComplianceResult,
    'ai_signals_computed' | 'deception_detected' | 'is_genuinely_bizarre'
  >;
}

export interface EffectiveTaskTemplatePolicy {
  riskTier: TaskRisk;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';
  requiredWorkerTrustTier: number;
  minimumPriceCents: number;
  completionCriteriaType: CompletionCriteriaType;
  contentReleaseRequired: boolean;
  mutualConsentRequired: boolean;
  cancellationWindowHours: number;
  lateCancelPct: number;
  cancellationPolicyVersion: string;
  licensedContent: boolean;
  inHomeContent: boolean;
  careContent: boolean;
  allowedWildcardFlags: string[];
}

export function isInHomeContent(description: string): boolean {
  return EXPLICIT_HOME_ENTRY.test(description)
    || (IN_HOME_LOCATION.test(description) && IN_HOME_ACTIVITY.test(description));
}

export function isLicensedWorkContent(description: string): boolean {
  return LICENSED_WORK.test(description);
}

export function isDeterministicallyBizarreContent(description: string): boolean {
  return DETERMINISTIC_BIZARRE.test(description);
}

export function allowedWildcardFlags(input: TaskTemplatePolicyInput): string[] {
  const requested = [...new Set(input.wildcardFlags ?? [])];
  if (requested.length === 0 || input.templateSlug !== TEMPLATE_SLUGS.WILDCARD_BIZARRE) return [];

  const compliance = input.complianceResult;
  if (compliance?.deception_detected) return [];
  const policyConfirmed = compliance?.is_genuinely_bizarre === true;
  const ordinaryInHome = isInHomeContent(input.description) || isCareContent(input.description);
  const deterministic = !ordinaryInHome && isDeterministicallyBizarreContent(input.description);
  return policyConfirmed || deterministic ? requested : [];
}

function contentMinimumPriceCents(input: {
  careContent: boolean;
  inHomeContent: boolean;
  licensedContent: boolean;
  contentReleaseRequired: boolean;
}): number {
  if (input.careContent) return 3600;
  if (input.licensedContent) return 3000;
  if (input.inHomeContent) return 4000;
  if (input.contentReleaseRequired) return 2000;
  return 1500;
}

function completionCriteria(
  templateType: CompletionCriteriaType | undefined,
  content: { care: boolean; release: boolean },
): CompletionCriteriaType {
  if (content.care) return 'check_in_check_out';
  if (content.release && templateType === 'photo_proof') return 'hybrid';
  return templateType ?? 'photo_proof';
}

export function deriveTaskTemplatePolicy(input: TaskTemplatePolicyInput): EffectiveTaskTemplatePolicy {
  const effectiveTemplateSlug = input.templateSlug ?? TEMPLATE_SLUGS.STANDARD_PHYSICAL;
  const template = getTemplate(effectiveTemplateSlug);
  const careContent = template?.slug === TEMPLATE_SLUGS.CARE || isCareContent(input.description);
  const inHomeContent = template?.slug === TEMPLATE_SLUGS.IN_HOME || isInHomeContent(input.description);
  const licensedContent = isLicensedWorkContent(input.description);
  const contentReleaseRequired = Boolean(
    template?.requiresContentRelease || isContentReleaseRequired(input.description),
  );
  const derivedTier = TaskRiskClassifier.classifyWithTemplate({
    insideHome: Boolean(input.insideHome || inHomeContent),
    peoplePresent: input.peoplePresent ?? false,
    petsPresent: input.petsPresent ?? false,
    caregiving: careContent,
  }, effectiveTemplateSlug, input.wildcardFlags ?? [], input.complianceResult as ComplianceResult | undefined);
  const suppliedTier = input.riskLevel ? RISK_LEVEL_TIER[input.riskLevel] : TaskRisk.TIER_0;
  const riskTier = Math.max(derivedTier, suppliedTier) as TaskRisk;
  const templateTrustTier = template
    ? TRUST_TIER_NUMBER[template.requiredTrustTier]
    : 1;
  const riskTrustTier = riskTier >= TaskRisk.TIER_2 ? 2 : 1;
  const contentTrustTier = licensedContent ? 4 : contentReleaseRequired ? 2 : 1;
  const minimumPriceCents = Math.max(
    TEMPLATE_MINIMUM_PRICE_CENTS[effectiveTemplateSlug] ?? 1500,
    contentMinimumPriceCents({ careContent, inHomeContent, licensedContent, contentReleaseRequired }),
  );
  const crossTemplateContent = contentReleaseRequired
    && template?.slug !== TEMPLATE_SLUGS.CONTENT_CREATOR
    && template?.slug !== TEMPLATE_SLUGS.CREATIVE_PRODUCTION;

  return {
    riskTier,
    riskLevel: TaskRiskClassifier.toLegacyRiskLevel(riskTier),
    requiredWorkerTrustTier: Math.max(templateTrustTier, riskTrustTier, contentTrustTier),
    minimumPriceCents,
    completionCriteriaType: completionCriteria(template?.completionCriteriaType, {
      care: careContent,
      release: contentReleaseRequired,
    }),
    contentReleaseRequired,
    mutualConsentRequired: Boolean(template?.requiresMutualConsent || contentReleaseRequired),
    cancellationWindowHours: careContent || contentReleaseRequired
      ? 0
      : template?.autoReleaseHours ?? 24,
    lateCancelPct: crossTemplateContent
      ? Math.max(template?.lateCancelPct ?? 0, 75)
      : template?.lateCancelPct ?? 0,
    cancellationPolicyVersion: `task-template-v2:${template?.slug ?? 'internal'}:${riskTier}`,
    licensedContent,
    inHomeContent,
    careContent,
    allowedWildcardFlags: allowedWildcardFlags(input),
  };
}
