/**
 * Squad Router Structure Tests
 *
 * Verifies the squad tRPC router has all 15 expected procedures
 * (8 original + 3: listTasks, acceptTask, leaderboard + 4 team task: createTeamTask, getTeamTask, startTeamTask, withdrawFromTeamTask)
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

import { squadRouter } from '../../../src/routers/squad';

describe('Squad Router', () => {
  it('should export the router', () => {
    expect(squadRouter).toBeDefined();
  });

  describe('procedure definitions', () => {
    const procedures = squadRouter._def.procedures as Record<string, any>;

    it('should have exactly 15 procedures', () => {
      const procedureNames = Object.keys(procedures);
      expect(procedureNames).toHaveLength(15);
    });

    it('should have all original procedure names', () => {
      const originalProcedures = [
        'create',
        'listMine',
        'getById',
        'invite',
        'respondToInvite',
        'listInvites',
        'leave',
        'disband',
      ];

      const procedureNames = Object.keys(procedures);
      for (const name of originalProcedures) {
        expect(procedureNames).toContain(name);
      }
    });

    it('should have all team task and list procedure names', () => {
      const newProcedures = ['listTasks', 'getTeamTask', 'createTeamTask', 'startTeamTask', 'withdrawFromTeamTask', 'acceptTask', 'leaderboard'];

      const procedureNames = Object.keys(procedures);
      for (const name of newProcedures) {
        expect(procedureNames).toContain(name);
      }
    });

    // New procedure type checks
    it('should have listTasks as a query', () => {
      expect(procedures.listTasks._def.type).toBe('query');
    });

    it('should have acceptTask as a mutation', () => {
      expect(procedures.acceptTask._def.type).toBe('mutation');
    });

    it('should have leaderboard as a query', () => {
      expect(procedures.leaderboard._def.type).toBe('query');
    });

    // Original procedure type checks (regression)
    it('should have create as a mutation', () => {
      expect(procedures.create._def.type).toBe('mutation');
    });

    it('should have listMine as a query', () => {
      expect(procedures.listMine._def.type).toBe('query');
    });

    it('should have getById as a query', () => {
      expect(procedures.getById._def.type).toBe('query');
    });

    it('should have invite as a mutation', () => {
      expect(procedures.invite._def.type).toBe('mutation');
    });

    it('should have respondToInvite as a mutation', () => {
      expect(procedures.respondToInvite._def.type).toBe('mutation');
    });

    it('should have listInvites as a query', () => {
      expect(procedures.listInvites._def.type).toBe('query');
    });

    it('should have leave as a mutation', () => {
      expect(procedures.leave._def.type).toBe('mutation');
    });

    it('should have disband as a mutation', () => {
      expect(procedures.disband._def.type).toBe('mutation');
    });
  });

  describe('new procedure input validation', () => {
    const procedures = squadRouter._def.procedures as Record<string, any>;

    it('listTasks should require squadId input', () => {
      const inputDef = procedures.listTasks._def.inputs?.[0];
      expect(inputDef).toBeDefined();
    });

    it('acceptTask should require squadTaskId input', () => {
      const inputDef = procedures.acceptTask._def.inputs?.[0];
      expect(inputDef).toBeDefined();
    });

    it('leaderboard should not require input', () => {
      const inputDef = procedures.leaderboard._def.inputs;
      // z.void() counts as "no user input required"
      const hasNoInput = inputDef.length === 0
        || inputDef[0] === undefined
        || inputDef[0]?._def?.typeName === 'ZodVoid';
      expect(hasNoInput).toBe(true);
    });
  });
});
