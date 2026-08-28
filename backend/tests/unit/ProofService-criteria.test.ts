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

  // ---------- Happy paths ----------

  it('photo_proof with photos returns valid', async () => {
    const result = await ProofService.validateProofForCriteria('task-123', {
      type: 'photo_proof',
      photoUrls: ['https://example.com/proof.jpg'],
    });
    expect(result.valid).toBe(true);
  });

  it('check_in_check_out with both timestamps returns valid', async () => {
    const result = await ProofService.validateProofForCriteria('task-123', {
      type: 'check_in_check_out',
      checkInAt: '2026-01-01T10:00:00Z',
      checkOutAt: '2026-01-01T12:00:00Z',
    });
    expect(result.valid).toBe(true);
  });

  it('check_in_check_out missing checkOut returns invalid', async () => {
    const result = await ProofService.validateProofForCriteria('task-123', {
      type: 'check_in_check_out',
      checkInAt: '2026-01-01T10:00:00Z',
      checkOutAt: null,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('check-out');
  });

  it('session_completion with both parties confirmed returns valid', async () => {
    const result = await ProofService.validateProofForCriteria('task-123', {
      type: 'session_completion',
      hustlerConfirmed: true,
      posterConfirmed: true,
    });
    expect(result.valid).toBe(true);
  });

  it('session_completion missing hustlerConfirmed returns invalid', async () => {
    const result = await ProofService.validateProofForCriteria('task-123', {
      type: 'session_completion',
      hustlerConfirmed: false,
      posterConfirmed: true,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Hustler');
  });

  it('hybrid with both timestamps returns valid', async () => {
    const result = await ProofService.validateProofForCriteria('task-123', {
      type: 'hybrid',
      checkInAt: '2026-01-01T10:00:00Z',
      checkOutAt: '2026-01-01T12:00:00Z',
    });
    expect(result.valid).toBe(true);
  });

  it('hybrid missing checkIn returns invalid', async () => {
    const result = await ProofService.validateProofForCriteria('task-123', {
      type: 'hybrid',
      checkInAt: null,
      checkOutAt: '2026-01-01T12:00:00Z',
    });
    expect(result.valid).toBe(false);
  });

  it('unknown proof type returns invalid', async () => {
    const result = await ProofService.validateProofForCriteria('task-123', {
      type: 'unknown_type' as any,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Unknown proof type');
  });
});
