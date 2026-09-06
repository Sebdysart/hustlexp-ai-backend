/**
 * Recurring Task Router Structure Tests
 *
 * Verifies the recurringTask tRPC router exposes read-only legacy evidence
 * plus the controlled recurring-work contract with the correct procedure types.
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

    it('registers only controlled-v2 procedures and legacy evidence reads', () => {
      const procedureNames = Object.keys(procedures);
      const expectedProcedures = [
        'createControlled',
        'generateControlled',
        'getById',
        'listControlled',
        'listMine',
        'listOccurrences',
        'recordControlledSafeguard',
        'recoverControlled',
      ];
      expect(procedureNames.sort()).toEqual(expectedProcedures.sort());
    });

    it.each([
      'create',
      'pause',
      'resume',
      'cancel',
      'generateOccurrences',
      'skipOccurrence',
      'setPreferredWorker',
    ])('does not register legacy public writer %s', (name) => {
      expect(procedures).not.toHaveProperty(name);
    });

    it.each([
      'createControlled',
      'generateControlled',
      'recordControlledSafeguard',
      'recoverControlled',
    ])('should have %s as a mutation', (name) => {
      expect(procedures[name]._def.type).toBe('mutation');
    });

    it.each(['listMine', 'listControlled', 'getById', 'listOccurrences'])(
      'should have %s as a query',
      (name) => {
        expect(procedures[name]._def.type).toBe('query');
      }
    );
  });

  describe('input validation', () => {
    const procedures = recurringTaskRouter._def.procedures as Record<string, any>;

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
