/**
 * PR Classifier Tests
 *
 * Verifies tier classification across representative file change patterns
 */

import { describe, it, expect } from 'vitest';
import { classifyPR, PRTier, TIER_THRESHOLDS } from '../../scripts/classify-pr-changes';

describe('PR Tier Classifier', () => {
  describe('TRIVIAL tier (docs, tests, assets)', () => {
    it('should classify README-only changes as TRIVIAL', () => {
      const files = ['README.md'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.TRIVIAL);
      expect(result.tierName).toBe('TRIVIAL');
      expect(result.threshold).toBe(TIER_THRESHOLDS[PRTier.TRIVIAL]);
      expect(result.justification).toContain('TRIVIAL: Only documentation, tests, or assets');
    });

    it('should classify docs folder changes as TRIVIAL', () => {
      const files = [
        'docs/API.md',
        'docs/ARCHITECTURE.md',
        'docs/CONTRIBUTING.md',
      ];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.TRIVIAL);
    });

    it('should classify test-only changes as TRIVIAL', () => {
      const files = [
        'backend/tests/unit/task-service.test.ts',
        'backend/tests/integration/escrow.test.ts',
      ];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.TRIVIAL);
    });

    it('should classify asset changes as TRIVIAL', () => {
      const files = [
        'assets/logo.png',
        'public/favicon.ico',
        '.gitignore',
      ];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.TRIVIAL);
    });
  });

  describe('STANDARD tier (services, routers)', () => {
    it('should classify non-financial service changes as STANDARD', () => {
      const files = [
        'backend/src/services/TaskService.ts',
        'backend/src/routers/task.ts',
      ];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.STANDARD);
      expect(result.tierName).toBe('STANDARD');
      expect(result.threshold).toBe(TIER_THRESHOLDS[PRTier.STANDARD]);
    });

    it('should classify analytics changes as STANDARD', () => {
      const files = [
        'backend/src/services/AnalyticsService.ts',
        'backend/src/routers/analytics.ts',
      ];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.STANDARD);
    });

    it('should classify notification changes as STANDARD', () => {
      const files = [
        'backend/src/services/NotificationService.ts',
        'backend/src/routers/notification.ts',
      ];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.STANDARD);
    });
  });

  describe('CRITICAL tier (financial services)', () => {
    it('should classify EscrowService changes as CRITICAL', () => {
      const files = ['backend/src/services/EscrowService.ts'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.CRITICAL);
      expect(result.tierName).toBe('CRITICAL');
      expect(result.threshold).toBe(TIER_THRESHOLDS[PRTier.CRITICAL]);
      expect(result.justification.some(j => j.includes('CRITICAL'))).toBe(true);
    });

    it('should classify LedgerService changes as CRITICAL', () => {
      const files = ['backend/src/services/LedgerService.ts'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.CRITICAL);
    });

    it('should classify PaymentService changes as CRITICAL', () => {
      const files = ['backend/src/services/PaymentService.ts'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.CRITICAL);
    });

    it('should classify XPService changes as CRITICAL', () => {
      const files = ['backend/src/services/XPService.ts'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.CRITICAL);
    });

    it('should classify TrustAndSafetyService changes as CRITICAL', () => {
      const files = ['backend/src/services/TrustAndSafetyService.ts'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.CRITICAL);
    });

    it('should classify escrow router changes as CRITICAL', () => {
      const files = ['backend/src/routers/escrow.ts'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.CRITICAL);
    });

    it('should classify xpTax router changes as CRITICAL', () => {
      const files = ['backend/src/routers/xpTax.ts'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.CRITICAL);
    });
  });

  describe('ARCHITECTURAL tier (migrations, infrastructure)', () => {
    it('should classify migrations as ARCHITECTURAL', () => {
      const files = ['backend/database/migrations/20260223_001_add_column.sql'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.ARCHITECTURAL);
      expect(result.tierName).toBe('ARCHITECTURAL');
      expect(result.threshold).toBe(TIER_THRESHOLDS[PRTier.ARCHITECTURAL]);
      expect(result.justification.some(j => j.includes('ARCHITECTURAL'))).toBe(true);
    });

    it('should classify server.ts changes as ARCHITECTURAL', () => {
      const files = ['backend/src/server.ts'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.ARCHITECTURAL);
    });

    it('should classify config.ts changes as ARCHITECTURAL', () => {
      const files = ['backend/src/config.ts'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.ARCHITECTURAL);
    });

    it('should classify trpc.ts changes as ARCHITECTURAL', () => {
      const files = ['backend/src/trpc.ts'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.ARCHITECTURAL);
    });

    it('should classify db.ts changes as ARCHITECTURAL', () => {
      const files = ['backend/src/db.ts'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.ARCHITECTURAL);
    });

    it('should classify orchestrator workflow changes as ARCHITECTURAL', () => {
      const files = ['.github/workflows/orchestrator.yml'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.ARCHITECTURAL);
    });

    it('should classify holodeck workflow changes as ARCHITECTURAL', () => {
      const files = ['.github/workflows/holodeck.yml'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.ARCHITECTURAL);
    });
  });

  describe('Mixed tier changes (highest wins)', () => {
    it('should elevate to ARCHITECTURAL when mixed with STANDARD', () => {
      const files = [
        'backend/database/migrations/20260223_001_add_column.sql',
        'backend/src/services/TaskService.ts',
        'README.md',
      ];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.ARCHITECTURAL);
    });

    it('should elevate to CRITICAL when mixed with TRIVIAL', () => {
      const files = [
        'backend/src/services/EscrowService.ts',
        'README.md',
        'docs/API.md',
      ];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.CRITICAL);
    });

    it('should elevate to CRITICAL when mixing financial and non-financial services', () => {
      const files = [
        'backend/src/services/PaymentService.ts',
        'backend/src/services/NotificationService.ts',
      ];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.CRITICAL);
    });
  });

  describe('Dimension scoring', () => {
    it('should detect high blast radius for many file changes', () => {
      const files = Array.from({ length: 10 }, (_, i) =>
        `backend/src/services/Service${i}.ts`
      );
      const result = classifyPR(files);

      expect(result.dimensions.blastRadius).toBeGreaterThanOrEqual(60);
    });

    it('should detect high security surface for auth changes', () => {
      const files = ['backend/src/middleware/auth.ts'];
      const result = classifyPR(files);

      expect(result.dimensions.securitySurface).toBeGreaterThanOrEqual(60);
    });

    it('should detect high data mutation for migrations', () => {
      const files = ['backend/database/migrations/20260223_001_add_column.sql'];
      const result = classifyPR(files);

      expect(result.dimensions.dataMutation).toBe(100);
    });

    it('should detect high user impact for router changes', () => {
      const files = ['backend/src/routers/task.ts'];
      const result = classifyPR(files);

      expect(result.dimensions.userImpact).toBeGreaterThanOrEqual(50);
    });

    it('should detect low reversibility for migrations', () => {
      const files = ['backend/database/migrations/20260223_001_add_column.sql'];
      const result = classifyPR(files);

      expect(result.dimensions.reversibility).toBe(100);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty file list gracefully', () => {
      expect(() => classifyPR([])).toThrow('No changed files detected');
    });

    it('should handle single file change', () => {
      const files = ['backend/src/services/TaskService.ts'];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.STANDARD);
      expect(result.changedFiles).toHaveLength(1);
    });

    it('should include all changed files in result', () => {
      const files = [
        'README.md',
        'backend/src/services/TaskService.ts',
        'docs/API.md',
      ];
      const result = classifyPR(files);

      expect(result.changedFiles).toEqual(files);
    });

    it('should provide justification for classification', () => {
      const files = ['backend/src/services/EscrowService.ts'];
      const result = classifyPR(files);

      expect(result.justification).toBeDefined();
      expect(result.justification.length).toBeGreaterThan(0);
    });
  });

  describe('Real-world scenarios', () => {
    it('should handle typical bug fix PR (service + test)', () => {
      const files = [
        'backend/src/services/TaskService.ts',
        'backend/tests/unit/task-service.test.ts',
      ];
      const result = classifyPR(files);

      // Should be STANDARD (test file ignored, service is non-financial)
      expect(result.tier).toBe(PRTier.STANDARD);
    });

    it('should handle feature PR with router + service + tests', () => {
      const files = [
        'backend/src/routers/taskDiscovery.ts',
        'backend/src/services/TaskDiscoveryService.ts',
        'backend/tests/unit/task-discovery-service.test.ts',
        'backend/tests/integration/task-discovery.test.ts',
      ];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.STANDARD);
    });

    it('should handle hotfix PR with escrow service change', () => {
      const files = [
        'backend/src/services/EscrowService.ts',
        'backend/tests/integration/escrow-service.test.ts',
      ];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.CRITICAL);
    });

    it('should handle database schema change with migration + service', () => {
      const files = [
        'backend/database/migrations/20260223_001_add_payment_intent_column.sql',
        'backend/src/services/PaymentService.ts',
      ];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.ARCHITECTURAL);
    });

    it('should handle documentation-only PR', () => {
      const files = [
        'README.md',
        'docs/API.md',
        'docs/ARCHITECTURE.md',
        'CHANGELOG.md',
      ];
      const result = classifyPR(files);

      expect(result.tier).toBe(PRTier.TRIVIAL);
      expect(result.threshold).toBe(40);
    });
  });
});
