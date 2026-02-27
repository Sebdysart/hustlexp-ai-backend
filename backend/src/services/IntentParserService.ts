/**
 * Intent Parser Service v1.0.0
 *
 * Natural language → structured implementation analysis:
 * - Affected invariants (INV-1, INV-2, etc.)
 * - Affected specs (HUSTLEXP-DOCS paths)
 * - Affected services/routers
 * - Suggested tier (trivial/standard/critical/architectural)
 * - Risk assessment
 *
 * Pipeline: KnowledgeGraphService → AIClient reasoning → structured output
 *
 * @see scripts/intent-bridge.ts (CLI wrapper)
 * @see scripts/analyze-pr-description.ts (PR validation)
 */

import { ServiceResult } from '../types';
import { AIClient } from './AIClient';
import { KnowledgeGraphService } from './KnowledgeGraphService';

export interface IntentAnalysis {
  affectedInvariants: string[]; // INV-1, INV-2, etc.
  affectedSpecs: string[]; // HUSTLEXP-DOCS/* paths
  affectedServices: string[]; // EscrowService, TaskService, etc.
  affectedRouters: string[]; // escrow, task, etc.
  suggestedTier: 'trivial' | 'standard' | 'critical' | 'architectural';
  riskAssessment: string;
  suggestedTestFiles: string[];
  implementationPlan: string[];
}

export const IntentParserService = {
  /**
   * Analyze natural language intent
   */
  async analyzeIntent(description: string): Promise<ServiceResult<IntentAnalysis>> {
    try {
      // Normalize null/undefined to empty string
      description = description ?? '';

      // Query knowledge graph for context
      let knowledgeContext = '';
      try {
        const kgResults = await KnowledgeGraphService.queryDocs(description, 5);
        if (kgResults && kgResults.length > 0) {
          knowledgeContext = kgResults.map((doc) => `- ${doc.filePath}: ${doc.content.substring(0, 100)}`).join('\n');
        }
      } catch (kgError) {
        console.warn('Knowledge graph query failed, proceeding without context:', kgError);
      }

      // Build prompt for AI reasoning
      const prompt = this.buildIntentPrompt(description, knowledgeContext);

      // Call AI reasoning route
      let analysis: IntentAnalysis;

      try {
        const aiResponse = await AIClient.call({
          route: 'reasoning',
          
          systemPrompt: 'You are an expert software architect analyzing implementation requirements.',
          prompt,
        });

        analysis = this.parseAIAnalysis(aiResponse.content);
      } catch (aiError) {
        console.warn('AI reasoning failed, using heuristic analysis:', aiError);
        analysis = this.heuristicAnalysis(description);
      }

      return { success: true, data: analysis };
    } catch (error) {
      console.error('IntentParserService.analyzeIntent error:', error);
      return {
        success: false,
        error: { code: 'HX600', message: 'Internal server error' },
      };
    }
  },

  /**
   * Build intent analysis prompt
   */
  buildIntentPrompt(description: string, knowledgeContext: string): string {
    return `
Analyze the following feature request and provide structured implementation guidance:

**Request:** ${description}

**Knowledge Graph Context:**
${knowledgeContext || 'No relevant documentation found'}

Provide a structured analysis in JSON format:

{
  "affectedInvariants": ["INV-1", "INV-2", ...],  // Which constitutional invariants this affects
  "affectedSpecs": ["HUSTLEXP-DOCS/path/to/spec.md", ...],  // Relevant spec files
  "affectedServices": ["TaskService", "EscrowService", ...],  // Backend services to modify
  "affectedRouters": ["task", "escrow", ...],  // tRPC routers to modify
  "suggestedTier": "standard",  // trivial | standard | critical | architectural
  "riskAssessment": "Low risk - isolated feature addition",
  "suggestedTestFiles": ["backend/tests/unit/task-service.test.ts", ...],
  "implementationPlan": [
    "1. Add new column to tasks table",
    "2. Update TaskService.createTask() to validate new field",
    "3. Add tRPC procedure task.updateField",
    "4. Update iOS TaskDetailScreen to show new field"
  ]
}

Focus on:
- Financial invariants (escrow, payments, XP) → critical tier
- Database schema changes → architectural tier
- New features with existing patterns → standard tier
- UI-only changes → trivial tier
`;
  },

  /**
   * Parse AI analysis response
   */
  parseAIAnalysis(aiResponse: string): IntentAnalysis {
    try {
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          affectedInvariants: parsed.affectedInvariants || [],
          affectedSpecs: parsed.affectedSpecs || [],
          affectedServices: parsed.affectedServices || [],
          affectedRouters: parsed.affectedRouters || [],
          suggestedTier: parsed.suggestedTier || 'standard',
          riskAssessment: parsed.riskAssessment || 'Unknown risk level',
          suggestedTestFiles: parsed.suggestedTestFiles || [],
          implementationPlan: parsed.implementationPlan || [],
        };
      }
    } catch (parseError) {
      console.warn('Failed to parse AI analysis JSON:', parseError);
    }

    // Fallback
    return this.heuristicAnalysis(aiResponse);
  },

  /**
   * Heuristic analysis (fallback when AI unavailable)
   */
  heuristicAnalysis(description: string): IntentAnalysis {
    const lowerDesc = description.toLowerCase();

    const affectedServices: string[] = [];
    const affectedRouters: string[] = [];
    const affectedInvariants: string[] = [];
    let suggestedTier: IntentAnalysis['suggestedTier'] = 'standard';

    // Detect services
    if (lowerDesc.includes('task') || lowerDesc.includes('quest')) {
      affectedServices.push('TaskService');
      affectedRouters.push('task');
    }
    if (lowerDesc.includes('escrow') || lowerDesc.includes('payment') || lowerDesc.includes('refund')) {
      affectedServices.push('EscrowService');
      affectedRouters.push('escrow');
      affectedInvariants.push('INV-1', 'INV-2'); // Escrow invariants
      suggestedTier = 'critical';
    }
    if (lowerDesc.includes('stripe')) {
      affectedServices.push('StripeService');
      suggestedTier = 'critical';
    }
    if (lowerDesc.includes('user') || lowerDesc.includes('profile')) {
      affectedServices.push('UserService');
      affectedRouters.push('user');
    }
    if (lowerDesc.includes('ai') || lowerDesc.includes('matchmaking')) {
      affectedServices.push('AIService');
    }
    if (lowerDesc.includes('proof') || lowerDesc.includes('submit proof') || lowerDesc.includes('evidence')) {
      affectedServices.push('ProofService');
    }
    if (lowerDesc.includes('notification') || lowerDesc.includes('messaging') || lowerDesc.includes('message')) {
      affectedServices.push('MessagingService');
    }

    // Detect tier
    if (lowerDesc.includes('migration') || lowerDesc.includes('database') || lowerDesc.includes('schema')) {
      suggestedTier = 'architectural';
    } else if (
      lowerDesc.includes('ui') ||
      lowerDesc.includes('screen') ||
      lowerDesc.includes('button') ||
      lowerDesc.includes('readme') ||
      lowerDesc.includes('typo') ||
      lowerDesc.includes('docs ') ||
      lowerDesc.includes(' docs') ||
      lowerDesc === 'docs' ||
      lowerDesc.includes('documentation') ||
      affectedServices.length === 0
    ) {
      suggestedTier = 'trivial';
    }

    return {
      affectedInvariants,
      affectedSpecs: [],
      affectedServices,
      affectedRouters,
      suggestedTier,
      riskAssessment: `Heuristic analysis based on keywords (AI unavailable)`,
      suggestedTestFiles: affectedServices.map(s => serviceToTestFile(s)),
      implementationPlan: [
        '1. Review affected services and invariants',
        '2. Implement changes with tests',
        '3. Run full pipeline verification',
      ],
    };
  },
};

// ============================================================================
// Exported helper functions (used by tests and CLI tools)
// ============================================================================

const KNOWN_SERVICES = [
  'EscrowService', 'TaskService', 'StripeService', 'UserService', 'AIService',
  'ProofService', 'MessagingService', 'TrustService', 'ReputationAIService',
  'NotificationService', 'DisputeService', 'CapabilityProfileService',
  'StripeConnectService', 'AIDecisionService', 'OnboardingAIService',
];

const KNOWN_ROUTERS = [
  'escrow', 'task', 'user', 'admin', 'ai', 'dispute', 'stripe',
  'notification', 'proof', 'analytics', 'fraud', 'moderation',
];

const FINANCIAL_SERVICES = new Set(['EscrowService', 'StripeService', 'StripeConnectService']);
const FINANCIAL_INVARIANTS = new Set(['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5']);

/**
 * Convert a CamelCase service name to a kebab-case test file path.
 * EscrowService → backend/tests/unit/escrow-service.test.ts
 * AIDecisionService → backend/tests/unit/ai-decision-service.test.ts
 */
export function serviceToTestFile(serviceName: string): string {
  // Handle transitions from lowercase to uppercase and from a run of uppercase
  // letters to a mixed word (e.g. "AI" before "Decision")
  const kebab = serviceName
    .replace(/([a-z])([A-Z])/g, '$1-$2')         // camelCase boundary: e → D
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')   // acronym boundary: AI → D
    .toLowerCase();
  return `backend/tests/unit/${kebab}.test.ts`;
}

/**
 * Match keywords in a description and return matched services, routers, and invariants.
 */
export function matchKeywords(description: string): {
  services: Set<string>;
  routers: Set<string>;
  invariants: Set<string>;
} {
  const lower = description.toLowerCase();
  const services = new Set<string>();
  const routers = new Set<string>();
  const invariants = new Set<string>();

  // Financial / escrow
  if (lower.includes('escrow') || lower.includes('refund') || lower.includes('release')) {
    services.add('EscrowService');
    routers.add('escrow');
    invariants.add('INV-1');
    invariants.add('INV-2');
  }
  if (lower.includes('payment') || lower.includes('stripe') || lower.includes('charge')) {
    services.add('EscrowService');
    services.add('StripeService');
    routers.add('escrow');
    invariants.add('INV-1');
  }
  if (lower.includes('stripe')) {
    services.add('StripeService');
  }

  // Task / proof
  if (lower.includes('task') || lower.includes('quest') || lower.includes('creation')) {
    services.add('TaskService');
    routers.add('task');
  }
  if (lower.includes('proof') || lower.includes('evidence') || lower.includes('submit')) {
    services.add('ProofService');
  }

  // User / auth / admin
  if (lower.includes('user') || lower.includes('profile') || lower.includes('login') || lower.includes('permission')) {
    services.add('UserService');
    routers.add('user');
  }
  if (lower.includes('admin')) {
    routers.add('admin');
  }

  // Trust / reputation
  if (lower.includes('trust') || lower.includes('tier')) {
    services.add('TrustService');
  }
  if (lower.includes('reputation')) {
    services.add('ReputationAIService');
  }

  // AI / matchmaking
  if (lower.includes(' ai ') || lower.includes('matchmaking') || lower.includes('decision')) {
    services.add('AIService');
    routers.add('ai');
  }

  // Messaging / notifications
  if (lower.includes('notification') || lower.includes('messaging') || lower.includes('message')) {
    services.add('MessagingService');
    services.add('NotificationService');
  }

  return { services, routers, invariants };
}

/**
 * Determine the suggested tier based on description, invariants, and services.
 */
export function determineTier(
  description: string,
  invariants: string[],
  services: string[]
): IntentAnalysis['suggestedTier'] {
  const lower = description.toLowerCase();

  // Architectural: database migrations / schema changes
  if (lower.includes('migration') || lower.includes('database') || lower.includes('schema')) {
    return 'architectural';
  }

  // Critical: financial invariants or financial services
  const hasFinancialInvariant = invariants.some(inv => FINANCIAL_INVARIANTS.has(inv));
  const hasFinancialService = services.some(svc => FINANCIAL_SERVICES.has(svc));
  if (hasFinancialInvariant || hasFinancialService) {
    return 'critical';
  }

  // Trivial: documentation or pure cosmetic UI only (no backend services involved)
  const noServices = services.length === 0;
  const isDocOnly =
    lower.includes('readme') ||
    lower.includes('typo') ||
    lower.includes('documentation') ||
    lower.includes('docs');
  const isPureUI =
    noServices &&
    (lower.includes('color') ||
      lower.includes('screen') ||
      lower.includes('button') ||
      lower.includes('ui'));
  if (isDocOnly || isPureUI) {
    return 'trivial';
  }

  return 'standard';
}

/**
 * Build a human-readable risk assessment string.
 */
export function buildRiskAssessment(
  tier: IntentAnalysis['suggestedTier'],
  services: string[],
  invariants: string[]
): string {
  const financialServices = services.filter(s => FINANCIAL_SERVICES.has(s));
  const invariantList = invariants.length > 0 ? ` Invariants: ${invariants.join(', ')}.` : '';
  const financialNote = financialServices.length > 0 ? ' Touches financial path.' : '';

  if (tier === 'critical') {
    return `high risk — financial or safety-critical change.${invariantList}${financialNote}`;
  }
  if (tier === 'architectural') {
    return `high risk — architectural change.${invariantList}`;
  }
  if (tier === 'standard') {
    return `medium risk — standard feature change.${invariantList}${financialNote}`;
  }
  return `low risk — trivial or documentation-only change.`;
}

/**
 * Extract INV-N references from arbitrary text.
 */
export function extractInvariantsFromText(text: string): string[] {
  const matches = text.match(/INV-\d+/g) ?? [];
  return [...new Set(matches)];
}

/**
 * Extract known service names from arbitrary text.
 */
export function extractServicesFromText(text: string): string[] {
  return KNOWN_SERVICES.filter(svc => text.includes(svc));
}

/**
 * Extract known router names from arbitrary text.
 */
export function extractRoutersFromText(text: string): string[] {
  const lower = text.toLowerCase();
  return KNOWN_ROUTERS.filter(router => lower.includes(router));
}
