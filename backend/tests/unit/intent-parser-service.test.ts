/**
 * IntentParserService Unit Tests
 *
 * Tests the keyword fallback path for intent analysis.
 * The knowledge graph requires a running database with embeddings,
 * so these tests verify the offline/keyword-based analysis works correctly.
 *
 * @see backend/src/services/IntentParserService.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  IntentParserService,
  matchKeywords,
  determineTier,
  buildRiskAssessment,
  serviceToTestFile,
  extractInvariantsFromText,
  extractServicesFromText,
  extractRoutersFromText,
} from '../../src/services/IntentParserService';

// ============================================================================
// MOCK: KnowledgeGraphService (simulate unavailable)
// ============================================================================

vi.mock('../../src/services/KnowledgeGraphService', () => ({
  KnowledgeGraphService: {
    queryDocs: vi.fn().mockRejectedValue(new Error('Database not available')),
    getRelatedInvariants: vi.fn().mockRejectedValue(new Error('Database not available')),
    getContractForProcedure: vi.fn().mockRejectedValue(new Error('Database not available')),
  },
}));

// ============================================================================
// MOCK: AIClient (simulate unavailable)
// ============================================================================

vi.mock('../../src/services/AIClient', () => ({
  AIClient: {
    call: vi.fn().mockRejectedValue(new Error('No AI providers configured')),
    callJSON: vi.fn().mockRejectedValue(new Error('No AI providers configured')),
    isConfigured: vi.fn().mockReturnValue(false),
  },
  default: {
    call: vi.fn().mockRejectedValue(new Error('No AI providers configured')),
    callJSON: vi.fn().mockRejectedValue(new Error('No AI providers configured')),
    isConfigured: vi.fn().mockReturnValue(false),
  },
}));

// ============================================================================
// MOCK: Logger
// ============================================================================

vi.mock('../../src/logger', () => ({
  aiLogger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
  logger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// ============================================================================
// TESTS: analyzeIntent (full integration with keyword fallback)
// ============================================================================

describe('IntentParserService.analyzeIntent', () => {
  describe('Financial domain', () => {
    it('should identify EscrowService and critical tier for escrow description', async () => {
      const result = await IntentParserService.analyzeIntent(
        'Fix the escrow release flow when payment is disputed'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.affectedServices).toContain('EscrowService');
      expect(result.data.suggestedTier).toBe('critical');
      expect(result.data.affectedInvariants).toContain('INV-1');
    });

    it('should identify StripeService for payment descriptions', async () => {
      const result = await IntentParserService.analyzeIntent(
        'Update Stripe payment intent creation to support new currency'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.affectedServices).toContain('StripeService');
      expect(result.data.suggestedTier).toBe('critical');
    });

    it('should mark refund flow as critical', async () => {
      const result = await IntentParserService.analyzeIntent(
        'Add automatic refund for cancelled tasks within 24 hours'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.suggestedTier).toBe('critical');
    });
  });

  describe('Task domain', () => {
    it('should identify TaskService for task creation descriptions', async () => {
      const result = await IntentParserService.analyzeIntent(
        'Add timezone tracking to task creation for scheduling'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.affectedServices).toContain('TaskService');
      expect(result.data.affectedRouters).toContain('task');
    });

    it('should identify ProofService for proof submission descriptions', async () => {
      const result = await IntentParserService.analyzeIntent(
        'Allow users to submit multiple proofs for a single task'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.affectedServices).toContain('ProofService');
    });
  });

  describe('Tier classification', () => {
    it('should classify migration descriptions as architectural', async () => {
      const result = await IntentParserService.analyzeIntent(
        'Run database migration to add new column for user preferences'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.suggestedTier).toBe('architectural');
    });

    it('should classify schema changes as architectural', async () => {
      const result = await IntentParserService.analyzeIntent(
        'Update the schema to add a new index on tasks table'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.suggestedTier).toBe('architectural');
    });

    it('should classify doc-only changes as trivial', async () => {
      const result = await IntentParserService.analyzeIntent(
        'Fix typo in README documentation'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.suggestedTier).toBe('trivial');
    });

    it('should classify docs changes as trivial', async () => {
      const result = await IntentParserService.analyzeIntent(
        'Update docs for API contract changes'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.suggestedTier).toBe('trivial');
    });
  });

  describe('Empty and edge cases', () => {
    it('should handle empty description', async () => {
      const result = await IntentParserService.analyzeIntent('');

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.affectedServices).toEqual([]);
      expect(result.data.affectedRouters).toEqual([]);
      expect(result.data.affectedInvariants).toEqual([]);
      expect(result.data.suggestedTier).toBe('trivial');
    });

    it('should handle null-ish description gracefully', async () => {
      const result = await IntentParserService.analyzeIntent(undefined as unknown as string);

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.suggestedTier).toBe('trivial');
    });
  });

  describe('Multiple domains', () => {
    it('should identify multiple services when description spans domains', async () => {
      const result = await IntentParserService.analyzeIntent(
        'Update escrow release to also trigger task completion notification via messaging'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.affectedServices).toContain('EscrowService');
      expect(result.data.affectedServices).toContain('MessagingService');
      expect(result.data.suggestedTier).toBe('critical'); // escrow = financial = critical
    });
  });

  describe('Test file suggestions', () => {
    it('should map EscrowService to correct test file', async () => {
      const result = await IntentParserService.analyzeIntent(
        'Modify escrow release logic'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.suggestedTestFiles).toContain('backend/tests/unit/escrow-service.test.ts');
    });

    it('should map TaskService to correct test file', async () => {
      const result = await IntentParserService.analyzeIntent(
        'Update task creation flow'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.suggestedTestFiles).toContain('backend/tests/unit/task-service.test.ts');
    });
  });
});

// ============================================================================
// TESTS: Helper functions
// ============================================================================

describe('matchKeywords', () => {
  it('should match financial keywords', () => {
    const result = matchKeywords('fix the escrow payment flow');
    expect(result.services.has('EscrowService')).toBe(true);
    expect(result.services.has('StripeService')).toBe(true);
    expect(result.invariants.has('INV-1')).toBe(true);
  });

  it('should match trust keywords', () => {
    const result = matchKeywords('update trust tier calculation for reputation');
    expect(result.services.has('TrustService')).toBe(true);
    expect(result.services.has('ReputationAIService')).toBe(true);
  });

  it('should match task keywords', () => {
    const result = matchKeywords('fix task creation and proof submit');
    expect(result.services.has('TaskService')).toBe(true);
    expect(result.services.has('ProofService')).toBe(true);
  });

  it('should match auth keywords', () => {
    const result = matchKeywords('fix admin login permission check');
    expect(result.routers.has('admin')).toBe(true);
    expect(result.routers.has('user')).toBe(true);
  });

  it('should return empty sets for unrecognized input', () => {
    const result = matchKeywords('adjust the color of the header bar');
    expect(result.services.size).toBe(0);
    expect(result.routers.size).toBe(0);
    expect(result.invariants.size).toBe(0);
  });
});

describe('determineTier', () => {
  it('should return critical for financial invariants', () => {
    expect(determineTier('some change', ['INV-1', 'INV-2'], ['EscrowService'])).toBe('critical');
  });

  it('should return architectural for migration keyword', () => {
    expect(determineTier('run database migration', [], [])).toBe('architectural');
  });

  it('should return trivial for docs-only changes', () => {
    expect(determineTier('update readme documentation', [], [])).toBe('trivial');
  });

  it('should return standard for non-critical changes', () => {
    expect(determineTier('add notification bell icon', [], ['NotificationService'])).toBe('standard');
  });

  it('should return critical for financial keywords even without invariants', () => {
    expect(determineTier('update stripe payment handler', [], ['StripeService'])).toBe('critical');
  });
});

describe('buildRiskAssessment', () => {
  it('should indicate high risk for critical tier', () => {
    const assessment = buildRiskAssessment('critical', ['EscrowService'], ['INV-1']);
    expect(assessment).toContain('high');
    expect(assessment).toContain('INV-1');
  });

  it('should indicate medium risk for standard tier', () => {
    const assessment = buildRiskAssessment('standard', ['TaskService'], []);
    expect(assessment).toContain('medium');
  });

  it('should indicate low risk for trivial tier', () => {
    const assessment = buildRiskAssessment('trivial', [], []);
    expect(assessment).toContain('low');
  });

  it('should mention financial path when financial services are affected', () => {
    const assessment = buildRiskAssessment('critical', ['EscrowService', 'StripeService'], ['INV-2']);
    expect(assessment).toContain('financial path');
  });
});

describe('serviceToTestFile', () => {
  it('should convert EscrowService to kebab-case test path', () => {
    expect(serviceToTestFile('EscrowService')).toBe('backend/tests/unit/escrow-service.test.ts');
  });

  it('should convert TaskService to kebab-case test path', () => {
    expect(serviceToTestFile('TaskService')).toBe('backend/tests/unit/task-service.test.ts');
  });

  it('should convert AIDecisionService to kebab-case test path', () => {
    expect(serviceToTestFile('AIDecisionService')).toBe('backend/tests/unit/ai-decision-service.test.ts');
  });

  it('should convert StripeConnectService to kebab-case test path', () => {
    expect(serviceToTestFile('StripeConnectService')).toBe('backend/tests/unit/stripe-connect-service.test.ts');
  });
});

describe('extractInvariantsFromText', () => {
  it('should extract INV- references', () => {
    expect(extractInvariantsFromText('This enforces INV-1 and INV-2')).toEqual(['INV-1', 'INV-2']);
  });

  it('should deduplicate invariants', () => {
    expect(extractInvariantsFromText('INV-1 references INV-1 again')).toEqual(['INV-1']);
  });

  it('should return empty array for no matches', () => {
    expect(extractInvariantsFromText('no invariants here')).toEqual([]);
  });
});

describe('extractServicesFromText', () => {
  it('should extract known service names', () => {
    const result = extractServicesFromText('The EscrowService and TaskService are affected');
    expect(result).toContain('EscrowService');
    expect(result).toContain('TaskService');
  });

  it('should not match partial names', () => {
    const result = extractServicesFromText('some random text without services');
    expect(result).toEqual([]);
  });
});

describe('extractRoutersFromText', () => {
  it('should extract known router names', () => {
    const result = extractRoutersFromText('the escrow router and task router');
    expect(result).toContain('escrow');
    expect(result).toContain('task');
  });
});
