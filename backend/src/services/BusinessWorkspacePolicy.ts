export const BUSINESS_ROLES = [
  'OWNER',
  'ADMIN',
  'DISPATCHER',
  'APPROVER',
  'REQUESTER',
  'VIEWER',
  'CREW',
] as const;

export type BusinessRole = (typeof BUSINESS_ROLES)[number];

export const BUSINESS_ACTIONS = [
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
] as const;

export type BusinessAction = (typeof BUSINESS_ACTIONS)[number];

const ROLE_ACTIONS: Readonly<Record<BusinessRole, ReadonlySet<BusinessAction>>> = {
  OWNER: new Set(BUSINESS_ACTIONS),
  ADMIN: new Set(BUSINESS_ACTIONS),
  DISPATCHER: new Set([
    'READ_WORKSPACE',
    'MANAGE_LOCATIONS',
    'MANAGE_SERVICES',
    'MANAGE_CREWS',
    'CREATE_WORK_ORDER',
    'ASSIGN_CREW',
    'SUBMIT_PROOF',
  ]),
  APPROVER: new Set(['READ_WORKSPACE', 'APPROVE_SPEND', 'VIEW_BILLING']),
  REQUESTER: new Set(['READ_WORKSPACE', 'CREATE_WORK_ORDER']),
  VIEWER: new Set(['READ_WORKSPACE', 'VIEW_BILLING']),
  CREW: new Set(['READ_WORKSPACE', 'SUBMIT_PROOF']),
};

export function businessRoleAllows(role: BusinessRole, action: BusinessAction): boolean {
  return ROLE_ACTIONS[role].has(action);
}

export function canManageBusinessMember(
  actorRole: BusinessRole,
  currentRole: BusinessRole,
  nextRole: BusinessRole,
): boolean {
  if (actorRole === 'OWNER') return true;
  return actorRole === 'ADMIN' && currentRole !== 'OWNER' && nextRole !== 'OWNER';
}
