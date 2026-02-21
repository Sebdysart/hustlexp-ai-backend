/**
 * Zod Validator Unit Tests
 *
 * Tests all input validation schemas used in tRPC procedures.
 * Ensures .max() constraints prevent oversized inputs (memory exhaustion, ReDoS).
 */
import { describe, it, expect, vi } from 'vitest';

// Mock modules that have side effects (DB connection, logger init)
vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn(), getPool: vi.fn() },
}));

vi.mock('../../src/logger', () => {
  const childFn = () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), child: childFn, trace: vi.fn() });
  const mockLogger = { child: childFn, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
  return {
    logger: mockLogger,
    workerLogger: mockLogger,
    authLogger: mockLogger,
    dbLogger: mockLogger,
  };
});

import { Schemas } from '../../src/trpc';

// ============================================================================
// createTask
// ============================================================================
describe('Schemas.createTask', () => {
  const valid = {
    title: 'Valid Task Title',
    description: 'This is a valid task description with enough text.',
    price: 10000,
  };

  it('should accept valid minimal input', () => {
    expect(() => Schemas.createTask.parse(valid)).not.toThrow();
  });

  it('should accept all optional fields', () => {
    const full = {
      ...valid,
      requirements: 'Must be 18+',
      location: 'New York, NY',
      category: 'Delivery',
      deadline: '2025-12-31T23:59:59Z',
      requiresProof: true,
      mode: 'LIVE' as const,
      liveBroadcastRadiusMiles: 10,
      instantMode: true,
    };
    expect(() => Schemas.createTask.parse(full)).not.toThrow();
  });

  // Title constraints
  it('should reject empty title', () => {
    expect(() => Schemas.createTask.parse({ ...valid, title: '' })).toThrow();
  });

  it('should accept title at 255 chars (boundary)', () => {
    expect(() => Schemas.createTask.parse({ ...valid, title: 'a'.repeat(255) })).not.toThrow();
  });

  it('should reject title at 256 chars', () => {
    expect(() => Schemas.createTask.parse({ ...valid, title: 'a'.repeat(256) })).toThrow();
  });

  // Description constraints
  it('should reject empty description', () => {
    expect(() => Schemas.createTask.parse({ ...valid, description: '' })).toThrow();
  });

  it('should accept description at 5000 chars (boundary)', () => {
    expect(() => Schemas.createTask.parse({ ...valid, description: 'a'.repeat(5000) })).not.toThrow();
  });

  it('should reject description at 5001 chars', () => {
    expect(() => Schemas.createTask.parse({ ...valid, description: 'a'.repeat(5001) })).toThrow();
  });

  // Price constraints
  it('should reject negative price', () => {
    expect(() => Schemas.createTask.parse({ ...valid, price: -1 })).toThrow();
  });

  it('should reject zero price', () => {
    expect(() => Schemas.createTask.parse({ ...valid, price: 0 })).toThrow();
  });

  it('should accept price at 99999900 (boundary)', () => {
    expect(() => Schemas.createTask.parse({ ...valid, price: 99999900 })).not.toThrow();
  });

  it('should reject price at 99999901', () => {
    expect(() => Schemas.createTask.parse({ ...valid, price: 99999901 })).toThrow();
  });

  it('should reject non-integer price', () => {
    expect(() => Schemas.createTask.parse({ ...valid, price: 10.5 })).toThrow();
  });

  // Optional string constraints
  it('should reject requirements at 2001 chars', () => {
    expect(() => Schemas.createTask.parse({ ...valid, requirements: 'a'.repeat(2001) })).toThrow();
  });

  it('should reject location at 501 chars', () => {
    expect(() => Schemas.createTask.parse({ ...valid, location: 'a'.repeat(501) })).toThrow();
  });

  it('should reject category at 101 chars', () => {
    expect(() => Schemas.createTask.parse({ ...valid, category: 'a'.repeat(101) })).toThrow();
  });

  // liveBroadcastRadiusMiles
  it('should reject radius over 100', () => {
    expect(() => Schemas.createTask.parse({ ...valid, liveBroadcastRadiusMiles: 101 })).toThrow();
  });

  it('should accept radius at 100 (boundary)', () => {
    expect(() => Schemas.createTask.parse({ ...valid, liveBroadcastRadiusMiles: 100 })).not.toThrow();
  });

  it('should reject negative radius', () => {
    expect(() => Schemas.createTask.parse({ ...valid, liveBroadcastRadiusMiles: -1 })).toThrow();
  });

  // Required fields
  it('should reject missing title', () => {
    const { title, ...rest } = valid;
    expect(() => Schemas.createTask.parse(rest)).toThrow();
  });

  it('should reject missing description', () => {
    const { description, ...rest } = valid;
    expect(() => Schemas.createTask.parse(rest)).toThrow();
  });

  it('should reject missing price', () => {
    const { price, ...rest } = valid;
    expect(() => Schemas.createTask.parse(rest)).toThrow();
  });
});

// ============================================================================
// fundEscrow
// ============================================================================
describe('Schemas.fundEscrow', () => {
  const validUUID = '550e8400-e29b-41d4-a716-446655440000';
  const valid = { escrowId: validUUID, stripePaymentIntentId: 'pi_1234567890' };

  it('should accept valid input', () => {
    expect(() => Schemas.fundEscrow.parse(valid)).not.toThrow();
  });

  it('should reject stripePaymentIntentId at 256 chars', () => {
    expect(() => Schemas.fundEscrow.parse({ ...valid, stripePaymentIntentId: 'a'.repeat(256) })).toThrow();
  });

  it('should accept stripePaymentIntentId at 255 chars (boundary)', () => {
    expect(() => Schemas.fundEscrow.parse({ ...valid, stripePaymentIntentId: 'a'.repeat(255) })).not.toThrow();
  });

  it('should reject invalid escrowId UUID', () => {
    expect(() => Schemas.fundEscrow.parse({ ...valid, escrowId: 'not-a-uuid' })).toThrow();
  });

  it('should reject missing escrowId', () => {
    const { escrowId, ...rest } = valid;
    expect(() => Schemas.fundEscrow.parse(rest)).toThrow();
  });

  it('should reject missing stripePaymentIntentId', () => {
    const { stripePaymentIntentId, ...rest } = valid;
    expect(() => Schemas.fundEscrow.parse(rest)).toThrow();
  });
});

// ============================================================================
// releaseEscrow
// ============================================================================
describe('Schemas.releaseEscrow', () => {
  const validUUID = '550e8400-e29b-41d4-a716-446655440000';
  const valid = { escrowId: validUUID, stripeTransferId: 'tr_1234567890' };

  it('should accept valid input', () => {
    expect(() => Schemas.releaseEscrow.parse(valid)).not.toThrow();
  });

  it('should accept without optional stripeTransferId', () => {
    expect(() => Schemas.releaseEscrow.parse({ escrowId: validUUID })).not.toThrow();
  });

  it('should reject stripeTransferId at 256 chars', () => {
    expect(() => Schemas.releaseEscrow.parse({ ...valid, stripeTransferId: 'a'.repeat(256) })).toThrow();
  });

  it('should accept stripeTransferId at 255 chars (boundary)', () => {
    expect(() => Schemas.releaseEscrow.parse({ ...valid, stripeTransferId: 'a'.repeat(255) })).not.toThrow();
  });
});

// ============================================================================
// submitProof
// ============================================================================
describe('Schemas.submitProof', () => {
  const validUUID = '550e8400-e29b-41d4-a716-446655440000';
  const valid = { taskId: validUUID, description: 'Completed the delivery' };

  it('should accept valid input', () => {
    expect(() => Schemas.submitProof.parse(valid)).not.toThrow();
  });

  it('should accept without optional description', () => {
    expect(() => Schemas.submitProof.parse({ taskId: validUUID })).not.toThrow();
  });

  it('should reject description at 2001 chars', () => {
    expect(() => Schemas.submitProof.parse({ ...valid, description: 'a'.repeat(2001) })).toThrow();
  });

  it('should accept description at 2000 chars (boundary)', () => {
    expect(() => Schemas.submitProof.parse({ ...valid, description: 'a'.repeat(2000) })).not.toThrow();
  });

  it('should reject invalid taskId', () => {
    expect(() => Schemas.submitProof.parse({ ...valid, taskId: 'bad' })).toThrow();
  });
});

// ============================================================================
// reviewProof
// ============================================================================
describe('Schemas.reviewProof', () => {
  const validUUID = '550e8400-e29b-41d4-a716-446655440000';
  const valid = { proofId: validUUID, decision: 'ACCEPTED' as const };

  it('should accept valid input', () => {
    expect(() => Schemas.reviewProof.parse(valid)).not.toThrow();
  });

  it('should accept REJECTED decision', () => {
    expect(() => Schemas.reviewProof.parse({ ...valid, decision: 'REJECTED' })).not.toThrow();
  });

  it('should reject invalid decision value', () => {
    expect(() => Schemas.reviewProof.parse({ ...valid, decision: 'MAYBE' })).toThrow();
  });

  it('should reject reason at 1001 chars', () => {
    expect(() => Schemas.reviewProof.parse({ ...valid, reason: 'a'.repeat(1001) })).toThrow();
  });

  it('should accept reason at 1000 chars (boundary)', () => {
    expect(() => Schemas.reviewProof.parse({ ...valid, reason: 'a'.repeat(1000) })).not.toThrow();
  });
});

// ============================================================================
// awardXP
// ============================================================================
describe('Schemas.awardXP', () => {
  const validUUID1 = '550e8400-e29b-41d4-a716-446655440000';
  const validUUID2 = '550e8400-e29b-41d4-a716-446655440001';
  const valid = { taskId: validUUID1, escrowId: validUUID2, baseXP: 100 };

  it('should accept valid input', () => {
    expect(() => Schemas.awardXP.parse(valid)).not.toThrow();
  });

  it('should reject baseXP over 10000', () => {
    expect(() => Schemas.awardXP.parse({ ...valid, baseXP: 10001 })).toThrow();
  });

  it('should accept baseXP at 10000 (boundary)', () => {
    expect(() => Schemas.awardXP.parse({ ...valid, baseXP: 10000 })).not.toThrow();
  });

  it('should reject negative baseXP', () => {
    expect(() => Schemas.awardXP.parse({ ...valid, baseXP: -1 })).toThrow();
  });

  it('should reject zero baseXP', () => {
    expect(() => Schemas.awardXP.parse({ ...valid, baseXP: 0 })).toThrow();
  });

  it('should reject non-integer baseXP', () => {
    expect(() => Schemas.awardXP.parse({ ...valid, baseXP: 1.5 })).toThrow();
  });
});

// ============================================================================
// pagination
// ============================================================================
describe('Schemas.pagination', () => {
  it('should accept valid input', () => {
    expect(() => Schemas.pagination.parse({ limit: 20, offset: 0 })).not.toThrow();
  });

  it('should accept limit at 100 (boundary)', () => {
    expect(() => Schemas.pagination.parse({ limit: 100, offset: 0 })).not.toThrow();
  });

  it('should reject limit at 101', () => {
    expect(() => Schemas.pagination.parse({ limit: 101, offset: 0 })).toThrow();
  });

  it('should reject limit at 0', () => {
    expect(() => Schemas.pagination.parse({ limit: 0, offset: 0 })).toThrow();
  });

  it('should reject negative limit', () => {
    expect(() => Schemas.pagination.parse({ limit: -1, offset: 0 })).toThrow();
  });

  it('should reject negative offset', () => {
    expect(() => Schemas.pagination.parse({ limit: 10, offset: -1 })).toThrow();
  });

  it('should reject non-integer limit', () => {
    expect(() => Schemas.pagination.parse({ limit: 10.5, offset: 0 })).toThrow();
  });

  it('should use defaults when fields omitted', () => {
    const result = Schemas.pagination.parse({});
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
  });
});

// ============================================================================
// submitCalibration
// ============================================================================
describe('Schemas.submitCalibration', () => {
  const valid = { calibrationPrompt: 'I enjoy helping people move' };

  it('should accept valid input', () => {
    expect(() => Schemas.submitCalibration.parse(valid)).not.toThrow();
  });

  it('should reject empty calibrationPrompt', () => {
    expect(() => Schemas.submitCalibration.parse({ calibrationPrompt: '' })).toThrow();
  });

  it('should reject calibrationPrompt at 5001 chars', () => {
    expect(() => Schemas.submitCalibration.parse({ calibrationPrompt: 'a'.repeat(5001) })).toThrow();
  });

  it('should accept calibrationPrompt at 5000 chars (boundary)', () => {
    expect(() => Schemas.submitCalibration.parse({ calibrationPrompt: 'a'.repeat(5000) })).not.toThrow();
  });

  it('should reject onboardingVersion at 21 chars', () => {
    expect(() => Schemas.submitCalibration.parse({ ...valid, onboardingVersion: 'a'.repeat(21) })).toThrow();
  });

  it('should accept onboardingVersion at 20 chars (boundary)', () => {
    expect(() => Schemas.submitCalibration.parse({ ...valid, onboardingVersion: 'a'.repeat(20) })).not.toThrow();
  });

  it('should use default onboardingVersion', () => {
    const result = Schemas.submitCalibration.parse(valid);
    expect(result.onboardingVersion).toBe('1.0.0');
  });
});

// ============================================================================
// uuid
// ============================================================================
describe('Schemas.uuid', () => {
  it('should accept valid UUID v4', () => {
    expect(() => Schemas.uuid.parse('550e8400-e29b-41d4-a716-446655440000')).not.toThrow();
  });

  it('should reject invalid UUID format', () => {
    expect(() => Schemas.uuid.parse('not-a-uuid')).toThrow();
  });

  it('should reject empty string', () => {
    expect(() => Schemas.uuid.parse('')).toThrow();
  });

  it('should reject number input', () => {
    expect(() => Schemas.uuid.parse(123)).toThrow();
  });

  it('should reject null', () => {
    expect(() => Schemas.uuid.parse(null)).toThrow();
  });

  it('should reject undefined', () => {
    expect(() => Schemas.uuid.parse(undefined)).toThrow();
  });
});
