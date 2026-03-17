import { describe, it, expect, vi } from 'vitest';
import { ProofService } from '../../src/services/ProofService.js';

vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT') && sql.includes('tasks')) {
        return { rows: [{ completion_criteria: { type: 'check_in_check_out' }, state: 'in_progress' }] };
      }
      return { rows: [] };
    }),
  },
}));

describe('ProofService — criteria-type validation', () => {
  it('check_in_check_out criteria requires GPS timestamps', async () => {
    const result = await ProofService.validateProofForCriteria('task-123', {
      type: 'check_in_check_out',
      checkInAt: null,
      checkOutAt: new Date().toISOString(),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('GPS check-in');
  });

  it('photo_proof criteria requires at least one photo', async () => {
    const result = await ProofService.validateProofForCriteria('task-123', {
      type: 'photo_proof',
      photoUrls: [],
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('photo');
  });

  it('session_completion requires both-party confirmation', async () => {
    const result = await ProofService.validateProofForCriteria('task-123', {
      type: 'session_completion',
      hustlerConfirmed: true,
      posterConfirmed: false,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Poster');
  });
});
