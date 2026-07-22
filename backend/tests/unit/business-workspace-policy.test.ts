import { describe, expect, it } from 'vitest';
import {
  BUSINESS_ROLES,
  businessRoleAllows,
  canManageBusinessMember,
  type BusinessAction,
  type BusinessRole,
} from '../../src/services/BusinessWorkspacePolicy.js';

const ALL_ACTIONS: BusinessAction[] = [
  'READ_WORKSPACE',
  'MANAGE_ORGANIZATION',
  'MANAGE_MEMBERS',
  'MANAGE_LOCATIONS',
  'MANAGE_SERVICES',
  'MANAGE_CREWS',
  'CREATE_WORK_ORDER',
  'APPROVE_SPEND',
  'VIEW_BILLING',
  'MANAGE_BILLING',
  'ASSIGN_CREW',
  'SUBMIT_PROOF',
];

function allowed(role: BusinessRole): BusinessAction[] {
  return ALL_ACTIONS.filter((action) => businessRoleAllows(role, action));
}

describe('business workspace role policy', () => {
  it('keeps the complete role vocabulary explicit and stable', () => {
    expect(BUSINESS_ROLES).toEqual([
      'OWNER', 'ADMIN', 'DISPATCHER', 'APPROVER', 'REQUESTER', 'VIEWER', 'CREW',
    ]);
  });

  it('gives the owner every organization action', () => {
    expect(allowed('OWNER')).toEqual(ALL_ACTIONS);
  });

  it('lets an admin operate the workspace without granting ownership', () => {
    expect(allowed('ADMIN')).toEqual(ALL_ACTIONS);
    expect(canManageBusinessMember('ADMIN', 'VIEWER', 'DISPATCHER')).toBe(true);
    expect(canManageBusinessMember('ADMIN', 'OWNER', 'VIEWER')).toBe(false);
    expect(canManageBusinessMember('ADMIN', 'VIEWER', 'OWNER')).toBe(false);
  });

  it('limits dispatcher, approver, requester, viewer, and crew to their jobs', () => {
    expect(allowed('DISPATCHER')).toEqual([
      'READ_WORKSPACE', 'MANAGE_LOCATIONS', 'MANAGE_SERVICES', 'MANAGE_CREWS',
      'CREATE_WORK_ORDER', 'ASSIGN_CREW', 'SUBMIT_PROOF',
    ]);
    expect(allowed('APPROVER')).toEqual([
      'READ_WORKSPACE', 'APPROVE_SPEND', 'VIEW_BILLING',
    ]);
    expect(allowed('REQUESTER')).toEqual(['READ_WORKSPACE', 'CREATE_WORK_ORDER']);
    expect(allowed('VIEWER')).toEqual(['READ_WORKSPACE', 'VIEW_BILLING']);
    expect(allowed('CREW')).toEqual(['READ_WORKSPACE', 'SUBMIT_PROOF']);
  });

  it('allows only an owner to grant, revoke, or transfer ownership', () => {
    expect(canManageBusinessMember('OWNER', 'ADMIN', 'OWNER')).toBe(true);
    expect(canManageBusinessMember('OWNER', 'OWNER', 'ADMIN')).toBe(true);
    expect(canManageBusinessMember('DISPATCHER', 'VIEWER', 'REQUESTER')).toBe(false);
  });
});
