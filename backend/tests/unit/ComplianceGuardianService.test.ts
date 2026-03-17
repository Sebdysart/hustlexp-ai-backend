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
  });
});
