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
      // Query knowledge graph for context
      let knowledgeContext = '';
      try {
        const kgResults = await KnowledgeGraphService.queryDocs(description, 5);
        if (kgResults && kgResults.length > 0) {
          knowledgeContext = kgResults.map((doc: any) => `- ${doc.path}: ${doc.content.substring(0, 100)}`).join('\n');
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

    // Detect tier
    if (lowerDesc.includes('migration') || lowerDesc.includes('database') || lowerDesc.includes('schema')) {
      suggestedTier = 'architectural';
    } else if (lowerDesc.includes('ui') || lowerDesc.includes('screen') || lowerDesc.includes('button')) {
      suggestedTier = 'trivial';
    }

    return {
      affectedInvariants,
      affectedSpecs: [],
      affectedServices,
      affectedRouters,
      suggestedTier,
      riskAssessment: `Heuristic analysis based on keywords (AI unavailable)`,
      suggestedTestFiles: affectedServices.map(s => `backend/tests/unit/${s.toLowerCase()}.test.ts`),
      implementationPlan: [
        '1. Review affected services and invariants',
        '2. Implement changes with tests',
        '3. Run full pipeline verification',
      ],
    };
  },
};
