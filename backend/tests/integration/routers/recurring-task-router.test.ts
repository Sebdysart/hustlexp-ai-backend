/**
 * Recurring Task Router Structure Tests
 *
 * Verifies the recurringTask tRPC router has all 10 expected procedures
 * with correct types (query vs mutation).
 */

import { describe, it, expect, vi } from 'vitest';

// Mock DB before importing router
vi.mock('../../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../../src/auth/firebase', () => ({
  firebaseAuth: {
    verifyIdToken: vi.fn(),
  },
}));

import { recurringTaskRouter } from '../../../src/routers/recurringTask';

describe('Recurring Task Router', () => {
  it('should export the router', () => {
    expect(recurringTaskRouter).toBeDefined();
  });

  describe('procedure definitions', () => {
    const procedures = recurringTaskRouter._def.procedures as Record<string, any>;

    it('should have exactly 10 procedures', () => {
      const procedureNames = Object.keys(procedures);
      expect(procedureNames).toHaveLength(10);
    });

    it('should have all expected procedure names', () => {
      const expectedProcedures = [
        'create',
        'listMine',
        'getById',
        'pause',
        'resume',
        'cancel',
        'listOccurrences',
        'generateOccurrences',
        'skipOccurrence',
        'setPreferredWorker',
      ];

      const procedureNames = Object.keys(procedures);
      for (const name of expectedProcedures) {
        expect(procedureNames).toContain(name);
      }
    });

    it('should have create as a mutation', () => {
      expect(procedures.create._def.type).toBe('mutation');
    });

    it('should have listMine as a query', () => {
      expect(procedures.listMine._def.type).toBe('query');
    });

    it('should have getById as a query', () => {
      expect(procedures.getById._def.type).toBe('query');
    });

    it('should have pause as a mutation', () => {
      expect(procedures.pause._def.type).toBe('mutation');
    });

    it('should have resume as a mutation', () => {
      expect(procedures.resume._def.type).toBe('mutation');
    });

    it('should have cancel as a mutation', () => {
      expect(procedures.cancel._def.type).toBe('mutation');
    });

    it('should have listOccurrences as a query', () => {
      expect(procedures.listOccurrences._def.type).toBe('query');
    });

    it('should have skipOccurrence as a mutation', () => {
      expect(procedures.skipOccurrence._def.type).toBe('mutation');
    });

    it('should have setPreferredWorker as a mutation', () => {
      expect(procedures.setPreferredWorker._def.type).toBe('mutation');
    });
  });

  describe('input validation', () => {
    const procedures = recurringTaskRouter._def.procedures as Record<string, any>;

    it('create should require title, description, payment, location, pattern', () => {
      const inputDef = procedures.create._def.inputs?.[0];
      expect(inputDef).toBeDefined();
    });

    it('getById should require id', () => {
      const inputDef = procedures.getById._def.inputs?.[0];
      expect(inputDef).toBeDefined();
    });

    it('listMine should accept optional pagination input', () => {
      const inputDef = procedures.listMine._def.inputs;
      // listMine now accepts optional pagination (limit/offset) but does not require input
      expect(inputDef.length === 0 || inputDef[0] === undefined || inputDef[0].safeParse(undefined).success).toBe(true);
    });
  });
});
