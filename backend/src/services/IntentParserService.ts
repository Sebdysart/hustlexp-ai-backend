/**
 * IntentParserService v1.0.0
 *
 * Natural Language Intent Bridge (Layer 20)
 *
 * Takes a developer's natural language description of a change and returns
 * structured analysis: affected invariants, specs, services, routers,
 * risk assessment, and suggested test files.
 *
 * Pipeline:
 * 1. Query knowledge graph (pgvector) for semantic matches
 * 2. Fall back to keyword matching if KG unavailable
 * 3. Optionally enrich with AI synthesis (fast route)
 * 4. Build structured IntentAnalysis
 *
 * @see KnowledgeGraphService.ts
 * @see AIClient.ts
 */

import { KnowledgeGraphService } from './KnowledgeGraphService';
import { AIClient } from './AIClient';
import type { ServiceResult } from '../types';
import { aiLogger } from '../logger';

const log = aiLogger.child({ service: 'IntentParser' });

// ============================================================================
// TYPES
// ============================================================================

export interface IntentAnalysis {
  query: string;
  affectedInvariants: string[];
  affectedSpecs: string[];
  affectedServices: string[];
  affectedRouters: string[];
  suggestedTier: 'trivial' | 'standard' | 'critical' | 'architectural';
  riskAssessment: string;
  suggestedTestFiles: string[];
  relatedDocs: Array<{ filePath: string; section: string; similarity: number }>;
}

// ============================================================================
// KEYWORD MAPS
// ============================================================================

const FINANCIAL_KEYWORDS = ['escrow', 'payment', 'ledger', 'stripe', 'payout', 'refund', 'fee', 'money', 'transfer', 'revenue', 'chargeback', 'balance'];
const TRUST_KEYWORDS = ['trust', 'tier', 'xp', 'level', 'reputation', 'ban', 'shadow', 'fraud'];
const TASK_KEYWORDS = ['task', 'create', 'accept', 'complete', 'cancel', 'expire', 'proof', 'submit'];
const AUTH_KEYWORDS = ['auth', 'login', 'signup', 'token', 'session', 'permission', 'admin', 'firebase'];
const MESSAGING_KEYWORDS = ['message', 'messaging', 'chat', 'notification', 'push', 'sms'];
const AI_KEYWORDS = ['ai', 'onboarding', 'calibration', 'matchmaker', 'dispute-ai', 'judge', 'scoper'];
const LIVE_KEYWORDS = ['live', 'broadcast', 'realtime', 'websocket', 'sse'];
const GDPR_KEYWORDS = ['gdpr', 'privacy', 'data-export', 'data-deletion', 'consent', 'pii'];
const SQUAD_KEYWORDS = ['squad', 'team', 'group', 'batch', 'quest'];

const ARCHITECTURAL_KEYWORDS = ['migration', 'schema', 'database', 'trigger', 'index', 'infrastructure', 'deploy', 'architecture'];
const TRIVIAL_KEYWORDS = ['readme', 'docs', 'documentation', 'typo', 'comment', 'formatting', 'lint'];

// Service → keyword domain mapping
interface DomainMapping {
  keywords: string[];
  services: string[];
  routers: string[];
  invariants: string[];
  specs: string[];
}

const DOMAIN_MAP: DomainMapping[] = [
  {
    keywords: FINANCIAL_KEYWORDS,
    services: ['EscrowService', 'StripeService', 'RevenueService', 'ChargebackService', 'StripeConnectService'],
    routers: ['escrow', 'stripeConnect'],
    invariants: ['INV-1', 'INV-2', 'INV-4'],
    specs: ['specs/01-product/PRODUCT_SPEC.md'],
  },
  {
    keywords: TRUST_KEYWORDS,
    services: ['TrustService', 'TrustTierService', 'ReputationAIService', 'FraudDetectionService', 'ShadowBanService'],
    routers: ['reputation', 'fraud', 'user'],
    invariants: ['INV-5'],
    specs: ['specs/01-product/PRODUCT_SPEC.md'],
  },
  {
    keywords: TASK_KEYWORDS,
    services: ['TaskService', 'ProofService', 'TaskDiscoveryService'],
    routers: ['task', 'taskDiscovery'],
    invariants: ['INV-3'],
    specs: ['specs/01-product/PRODUCT_SPEC.md'],
  },
  {
    keywords: AUTH_KEYWORDS,
    services: ['BackgroundCheckService'],
    routers: ['admin', 'user'],
    invariants: [],
    specs: ['specs/01-product/PRODUCT_SPEC.md'],
  },
  {
    keywords: MESSAGING_KEYWORDS,
    services: ['MessagingService', 'NotificationService', 'PushNotificationService'],
    routers: ['messaging', 'notification'],
    invariants: [],
    specs: ['specs/01-product/PRODUCT_SPEC.md'],
  },
  {
    keywords: AI_KEYWORDS,
    services: ['AIDecisionService', 'OnboardingAIService', 'MatchmakerAIService', 'DisputeAIService', 'JudgeAIService', 'ScoperAIService'],
    routers: ['ai', 'matchmaker', 'disputeAI'],
    invariants: [],
    specs: ['specs/01-product/PRODUCT_SPEC.md'],
  },
  {
    keywords: LIVE_KEYWORDS,
    services: ['InstantTaskGate', 'InstantModeKillSwitch'],
    routers: ['live', 'instant'],
    invariants: [],
    specs: ['specs/01-product/PRODUCT_SPEC.md'],
  },
  {
    keywords: GDPR_KEYWORDS,
    services: ['GDPRService', 'BreachNotificationService'],
    routers: ['gdpr'],
    invariants: [],
    specs: ['specs/01-product/PRODUCT_SPEC.md'],
  },
  {
    keywords: SQUAD_KEYWORDS,
    services: ['BatchQuestingService'],
    routers: ['squad', 'batchQuest'],
    invariants: [],
    specs: ['specs/01-product/PRODUCT_SPEC.md'],
  },
];

// ============================================================================
// KNOWN NAMES (for router/service extraction from docs)
// ============================================================================

const KNOWN_SERVICE_NAMES = [
  'EscrowService', 'TaskService', 'XPService', 'ProofService', 'StripeService',
  'TrustService', 'TrustTierService', 'ReputationAIService', 'FraudDetectionService',
  'MessagingService', 'NotificationService', 'PushNotificationService',
  'AIDecisionService', 'OnboardingAIService', 'MatchmakerAIService',
  'DisputeAIService', 'JudgeAIService', 'ScoperAIService',
  'GDPRService', 'BreachNotificationService', 'RevenueService',
  'ChargebackService', 'ShadowBanService', 'TaskDiscoveryService',
  'WorkerSkillService', 'DynamicPricingService', 'PhotoVerificationService',
  'GeofenceService', 'HeatMapService', 'BatchQuestingService',
  'TutorialQuestService', 'JuryPoolService', 'BackgroundCheckService',
  'StripeConnectService', 'InstantTaskGate', 'InstantModeKillSwitch',
  'BiometricVerificationService', 'XPTaxService', 'SelfInsurancePoolService',
  'ContentModerationService', 'TippingService', 'AnalyticsService',
  'BadgeService', 'BadgeEvaluationService', 'StreakService',
  'ExpertiseSupplyService', 'RatingService', 'FlagsService',
  'AlphaInstrumentation', 'AuditService', 'PlanService',
  'TaskRiskClassifier', 'EligibilityGuard', 'CapabilityRecomputeService',
  'EarnedVerificationUnlockService', 'LogisticsAIService',
  'AIEventService', 'AIJobService', 'AIProposalService',
  'StripeEntitlementProcessor', 'StripeSubscriptionProcessor',
  'StripeWebhookService', 'InstantRateLimiter', 'InstantObservability',
  'BetaService', 'AdminNotificationHelper', 'TaxReportingService',
  'GeocodingService', 'TwilioSMSService',
];

const KNOWN_ROUTER_NAMES = [
  'task', 'escrow', 'user', 'ai', 'live', 'health', 'ui', 'instant',
  'taskDiscovery', 'messaging', 'notification', 'rating', 'gdpr',
  'analytics', 'fraud', 'moderation', 'alphaTelemetry',
  'xpTax', 'insurance', 'biometric',
  'skills', 'pricing', 'geofence', 'heatmap', 'batchQuest', 'tutorial', 'jury', 'upload',
  'matchmaker', 'disputeAI', 'reputation',
  'betaDashboard', 'challenges', 'expertiseSupply', 'featured', 'referral', 'subscription', 'tipping',
  'squad', 'stripeConnect', 'flags', 'admin',
];

// ============================================================================
// HELPERS
// ============================================================================

function matchKeywords(description: string): {
  services: Set<string>;
  routers: Set<string>;
  invariants: Set<string>;
  specs: Set<string>;
} {
  const lower = description.toLowerCase();
  const services = new Set<string>();
  const routers = new Set<string>();
  const invariants = new Set<string>();
  const specs = new Set<string>();

  for (const domain of DOMAIN_MAP) {
    const matched = domain.keywords.some((kw) => lower.includes(kw));
    if (matched) {
      domain.services.forEach((s) => services.add(s));
      domain.routers.forEach((r) => routers.add(r));
      domain.invariants.forEach((i) => invariants.add(i));
      domain.specs.forEach((s) => specs.add(s));
    }
  }

  return { services, routers, invariants, specs };
}

function determineTier(
  description: string,
  invariants: string[],
  services: string[],
): 'trivial' | 'standard' | 'critical' | 'architectural' {
  const lower = description.toLowerCase();

  // Trivial: docs-only changes (no services affected)
  if (TRIVIAL_KEYWORDS.some((kw) => lower.includes(kw)) && services.length === 0) {
    return 'trivial';
  }

  // Critical: touches financial invariants (INV-1, INV-2, INV-4) — highest priority
  const financialInvariants = ['INV-1', 'INV-2', 'INV-4'];
  if (invariants.some((inv) => financialInvariants.includes(inv))) {
    return 'critical';
  }

  // Critical: mentions financial keywords directly
  if (FINANCIAL_KEYWORDS.some((kw) => lower.includes(kw))) {
    return 'critical';
  }

  // Architectural: schema/migration/infrastructure (after financial check)
  if (ARCHITECTURAL_KEYWORDS.some((kw) => lower.includes(kw))) {
    return 'architectural';
  }

  return 'standard';
}

function buildRiskAssessment(
  tier: 'trivial' | 'standard' | 'critical' | 'architectural',
  services: string[],
  invariants: string[],
): string {
  const riskLevel =
    tier === 'critical' ? 'high' :
    tier === 'architectural' ? 'high' :
    tier === 'standard' ? 'medium' :
    'low';

  const details: string[] = [];
  if (invariants.length > 0) {
    details.push(`touches invariants ${invariants.join(', ')}`);
  }
  const financialServices = services.filter((s) =>
    ['EscrowService', 'StripeService', 'RevenueService', 'ChargebackService', 'StripeConnectService'].includes(s)
  );
  if (financialServices.length > 0) {
    details.push('affects financial path');
  }
  if (services.length === 0 && invariants.length === 0) {
    details.push('no critical paths identified');
  }

  return `${riskLevel} — ${details.join('; ') || 'standard change'}`;
}

export function serviceToTestFile(serviceName: string): string {
  // Convert PascalCase to kebab-case
  const kebab = serviceName
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
  return `backend/tests/unit/${kebab}.test.ts`;
}

function extractInvariantsFromText(text: string): string[] {
  const matches = text.match(/INV-\d+/g);
  return matches ? [...new Set(matches)] : [];
}

function extractServicesFromText(text: string): string[] {
  return KNOWN_SERVICE_NAMES.filter((name) => text.includes(name));
}

function extractRoutersFromText(text: string): string[] {
  return KNOWN_ROUTER_NAMES.filter((name) => {
    // Match as a standalone word (avoid matching 'ai' inside 'detail', etc.)
    const regex = new RegExp(`\\b${name}\\b`, 'i');
    return regex.test(text);
  });
}

// ============================================================================
// SERVICE
// ============================================================================

export const IntentParserService = {
  /**
   * Analyze a natural language intent description and return structured impact analysis.
   */
  analyzeIntent: async (description: string): Promise<ServiceResult<IntentAnalysis>> => {
    if (!description || description.trim().length === 0) {
      return {
        success: true,
        data: {
          query: description || '',
          affectedInvariants: [],
          affectedSpecs: [],
          affectedServices: [],
          affectedRouters: [],
          suggestedTier: 'trivial',
          riskAssessment: 'low — empty description',
          suggestedTestFiles: [],
          relatedDocs: [],
        },
      };
    }

    const services = new Set<string>();
    const routers = new Set<string>();
    const invariants = new Set<string>();
    const specs = new Set<string>();
    const relatedDocs: Array<{ filePath: string; section: string; similarity: number }> = [];

    // ── Step 1: Try knowledge graph ──────────────────────────────────────
    let kgAvailable = false;
    try {
      const docs = await KnowledgeGraphService.queryDocs(description, 10);
      kgAvailable = true;

      for (const doc of docs) {
        relatedDocs.push({
          filePath: doc.filePath,
          section: doc.sectionHeader,
          similarity: doc.similarity,
        });

        // Extract invariant references from doc content
        for (const inv of extractInvariantsFromText(doc.content)) {
          invariants.add(inv);
        }

        // Extract service names from doc content
        for (const svc of extractServicesFromText(doc.content)) {
          services.add(svc);
        }

        // Extract router names from doc content
        for (const rtr of extractRoutersFromText(doc.content)) {
          routers.add(rtr);
        }

        // Track spec file paths
        if (doc.filePath.includes('SPEC') || doc.filePath.includes('spec')) {
          specs.add(doc.filePath);
        }
      }

      log.debug({ docCount: docs.length }, 'Knowledge graph query successful');
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'Knowledge graph unavailable, using keyword fallback');
    }

    // ── Step 2: Keyword fallback (always runs to supplement KG) ──────────
    const keywordMatch = matchKeywords(description);
    keywordMatch.services.forEach((s) => services.add(s));
    keywordMatch.routers.forEach((r) => routers.add(r));
    keywordMatch.invariants.forEach((i) => invariants.add(i));
    keywordMatch.specs.forEach((s) => specs.add(s));

    // Also extract INV- references from the description itself
    for (const inv of extractInvariantsFromText(description)) {
      invariants.add(inv);
    }

    // Extract services/routers mentioned directly in the description
    for (const svc of extractServicesFromText(description)) {
      services.add(svc);
    }
    for (const rtr of extractRoutersFromText(description)) {
      routers.add(rtr);
    }

    const servicesList = [...services];
    const invariantsList = [...invariants];

    // ── Step 3: Determine tier ───────────────────────────────────────────
    const suggestedTier = determineTier(description, invariantsList, servicesList);

    // ── Step 4: Try AI enrichment (optional, non-blocking) ───────────────
    let aiRiskAssessment: string | null = null;
    try {
      if (AIClient.isConfigured()) {
        const topDocs = relatedDocs.slice(0, 5);
        const docsContext = topDocs.length > 0
          ? topDocs.map((d) => `- ${d.filePath} > ${d.section} (similarity: ${d.similarity.toFixed(2)})`).join('\n')
          : 'No related documentation found.';

        const aiResult = await AIClient.call({
          route: 'fast',
          systemPrompt:
            'You are analyzing a developer\'s intent description for the HustleXP gig marketplace platform. ' +
            'Given the intent and related documentation, produce a brief (1-2 sentence) risk assessment. ' +
            'Mention any additional affected services or invariants not already listed. ' +
            'Be concise and specific.',
          prompt: `Intent: "${description}"\n\nRelated docs:\n${docsContext}\n\nAlready identified services: ${servicesList.join(', ') || 'none'}\nAlready identified invariants: ${invariantsList.join(', ') || 'none'}`,
          temperature: 0.3,
          maxTokens: 256,
          timeoutMs: 5000,
          enableCache: true,
        });

        aiRiskAssessment = aiResult.content.trim();

        // Extract any additional invariants/services from AI response
        for (const inv of extractInvariantsFromText(aiResult.content)) {
          invariants.add(inv);
        }
        for (const svc of extractServicesFromText(aiResult.content)) {
          services.add(svc);
        }
      }
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'AI enrichment unavailable, using rule-based assessment');
    }

    // ── Step 5: Build final result ───────────────────────────────────────
    const finalServices = [...services];
    const finalInvariants = [...invariants];
    const finalRouters = [...routers];
    const finalSpecs = [...specs];

    const riskAssessment = aiRiskAssessment || buildRiskAssessment(suggestedTier, finalServices, finalInvariants);

    const suggestedTestFiles = finalServices.map(serviceToTestFile);

    return {
      success: true,
      data: {
        query: description,
        affectedInvariants: finalInvariants,
        affectedSpecs: finalSpecs,
        affectedServices: finalServices,
        affectedRouters: finalRouters,
        suggestedTier,
        riskAssessment,
        suggestedTestFiles,
        relatedDocs,
      },
    };
  },
};

// Export helpers for testing
export {
  matchKeywords,
  determineTier,
  buildRiskAssessment,
  extractInvariantsFromText,
  extractServicesFromText,
  extractRoutersFromText,
  KNOWN_SERVICE_NAMES,
  KNOWN_ROUTER_NAMES,
};
