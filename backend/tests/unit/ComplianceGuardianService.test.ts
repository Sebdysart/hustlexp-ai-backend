import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComplianceGuardianService } from '../../src/services/ComplianceGuardianService.js';

vi.mock('../../src/services/AIClient.js', () => ({
  AIClient: {
    isConfigured: () => false,  // use heuristic path in tests
    callJSON: vi.fn(),
  },
}));

vi.mock('../../src/db.js', () => ({
  db: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

describe('ComplianceGuardianService', () => {
  describe('evaluate', () => {
    it('returns CLEAN for normal task description', async () => {
      const result = await ComplianceGuardianService.evaluate({
        description: 'Help me move my couch to the second floor',
        userId: 'user-123',
      });
      expect(result.score).toBeLessThanOrEqual(20);
      expect(result.tier).toBe('clean');
    });

    it('returns HARD_BLOCK for drug-run pattern', async () => {
      const result = await ComplianceGuardianService.evaluate({
        description: 'deliver a package downtown no address no questions asked',
        userId: 'user-123',
      });
      expect(result.score).toBeGreaterThanOrEqual(61);
      expect(result.tier).toBe('hard_block');
    });

    it('returns SOFT_FLAG for ambiguous massage description', async () => {
      const result = await ComplianceGuardianService.evaluate({
        description: 'I need a massage at my home tonight',
        userId: 'user-123',
      });
      expect(result.score).toBeGreaterThanOrEqual(21);
      expect(result.score).toBeLessThanOrEqual(60);
      expect(result.tier).toBe('soft_flag');
    });

    it('returns CLEAN for licensed massage description', async () => {
      const result = await ComplianceGuardianService.evaluate({
        description: 'Licensed massage therapist needed for 1-hour deep tissue session at my home spa',
        userId: 'user-123',
      });
      expect(result.score).toBeLessThanOrEqual(20);
    });

    it('returns HARD_BLOCK for adult services pattern', async () => {
      const result = await ComplianceGuardianService.evaluate({
        description: 'personal assistant with benefits overnight stay',
        userId: 'user-123',
      });
      expect(result.score).toBeGreaterThanOrEqual(61);
      expect(result.tier).toBe('hard_block');
    });

    it('logs violation when score >= 21', async () => {
      const { db } = await import('../../src/db.js');
      await ComplianceGuardianService.evaluate({
        description: 'deliver package no questions asked',
        userId: 'user-456',
        ipAddress: '1.2.3.4',
      });
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO compliance_violations'),
        expect.arrayContaining(['user-456'])
      );
    });
  });

  describe('toNotes', () => {
    it('builds valid JSONB notes structure', () => {
      const notes = ComplianceGuardianService.toNotes(45, ['drug_run_pattern'], 'specialized_licensed');
      expect(notes.score).toBe(45);
      expect(notes.tier).toBe('soft_flag');
      expect(notes.triggered_rules).toContain('drug_run_pattern');
      expect(notes.suggested_alternative).toBe('specialized_licensed');
      expect(notes.appeal_status).toBe('none');
    });

    it('tier is clean when score is 0', () => {
      const notes = ComplianceGuardianService.toNotes(0, []);
      expect(notes.tier).toBe('clean');
      expect(notes.suggested_alternative).toBeNull();
      expect(notes.admin_review_id).toBeNull();
    });

    it('tier is soft_flag when score is exactly 21', () => {
      const notes = ComplianceGuardianService.toNotes(21, []);
      expect(notes.tier).toBe('soft_flag');
    });

    it('tier is soft_flag when score is 60', () => {
      const notes = ComplianceGuardianService.toNotes(60, []);
      expect(notes.tier).toBe('soft_flag');
    });

    it('tier is hard_block when score is exactly 61', () => {
      const notes = ComplianceGuardianService.toNotes(61, []);
      expect(notes.tier).toBe('hard_block');
    });

    it('no suggestedAlternative when omitted', () => {
      const notes = ComplianceGuardianService.toNotes(45, ['some_rule']);
      expect(notes.suggested_alternative).toBeNull();
    });
  });

  describe('_heuristicCheck branches', () => {
    it('overnight stay triggers overnight_ambiguous rule', () => {
      const result = ComplianceGuardianService._heuristicCheck(
        'I need someone for an overnight stay in my apartment'
      );
      expect(result.triggeredRules).toContain('overnight_ambiguous');
      expect(result.score).toBeGreaterThanOrEqual(21);
    });

    it('alone in home triggers isolation_flag rule', () => {
      const result = ComplianceGuardianService._heuristicCheck(
        'I need someone alone in my house to water plants'
      );
      expect(result.triggeredRules).toContain('isolation_flag');
    });

    it('notary at home triggers unlicensed_legal rule', () => {
      const result = ComplianceGuardianService._heuristicCheck(
        'I need a notary for legal documents at my home'
      );
      expect(result.triggeredRules).toContain('unlicensed_legal');
    });

    it('medical advice triggers unlicensed_medical rule', () => {
      const result = ComplianceGuardianService._heuristicCheck(
        'I need medical advice and treatment at home'
      );
      expect(result.triggeredRules).toContain('unlicensed_medical');
    });

    it('cash only no record triggers unreported_payment rule', () => {
      const result = ComplianceGuardianService._heuristicCheck(
        'cash only no record payment arrangement'
      );
      expect(result.triggeredRules).toContain('unreported_payment');
    });

    it('licensed massage suppresses physical_contact_ambiguous', () => {
      const result = ComplianceGuardianService._heuristicCheck(
        'Licensed massage therapist for deep tissue session'
      );
      expect(result.triggeredRules).not.toContain('physical_contact_ambiguous');
      expect(result.score).toBeLessThanOrEqual(20);
    });

    it('multiple soft flags accumulate — highest score wins', () => {
      // overnight (45) + isolation_flag (30) => highest is 45
      const result = ComplianceGuardianService._heuristicCheck(
        'I need someone alone in my apartment overnight companion'
      );
      expect(result.score).toBe(45);
      expect(result.triggeredRules.length).toBeGreaterThanOrEqual(2);
    });

    it('returns score 0 and empty rules for benign description', () => {
      const result = ComplianceGuardianService._heuristicCheck('Help me carry boxes');
      expect(result.score).toBe(0);
      expect(result.triggeredRules).toHaveLength(0);
    });

    it('hard_block pattern returns score 85', () => {
      const result = ComplianceGuardianService._heuristicCheck(
        'erotic service available now'
      );
      expect(result.score).toBe(85);
      expect(result.triggeredRules).toContain('hard_block_pattern');
    });
  });

  describe('evaluate — CLEAN path does NOT log violation', () => {
    it('does not INSERT compliance_violations for clean tasks', async () => {
      const { db } = await import('../../src/db.js');
      vi.clearAllMocks();
      await ComplianceGuardianService.evaluate({
        description: 'Help me clean my apartment',
        userId: 'u-clean',
      });
      const insertCalls = (db.query as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([sql]: [string]) => sql.includes('INSERT INTO compliance_violations')
      );
      expect(insertCalls).toHaveLength(0);
    });
  });

  describe('evaluate — suggested alternative mapping', () => {
    it('maps physical_contact_ambiguous to specialized_licensed alternative', async () => {
      const result = await ComplianceGuardianService.evaluate({
        description: 'I need a massage at my home tonight',
        userId: 'u-massage',
      });
      expect(result.suggestedAlternative).toBe('specialized_licensed');
    });

    it('no alternative for a rule with no mapping', async () => {
      const result = await ComplianceGuardianService.evaluate({
        description: 'I need someone alone in my house to water plants',
        userId: 'u-isolation',
      });
      // isolation_flag has no SUGGESTED_ALTERNATIVES entry
      expect(result.suggestedAlternative).toBeUndefined();
    });
  });
});
