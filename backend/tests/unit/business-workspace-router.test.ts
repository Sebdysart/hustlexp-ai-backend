import { beforeEach, describe, expect, it, vi } from 'vitest';

const workspace = vi.hoisted(() => ({
  createBusinessWorkspace: vi.fn(),
  listBusinessWorkspaces: vi.fn(),
  setBusinessMemberRole: vi.fn(),
  setBusinessMemberRoleByEmail: vi.fn(),
  listBusinessMembers: vi.fn(),
  createBusinessLocation: vi.fn(),
  listBusinessLocations: vi.fn(),
}));

vi.mock('../../src/services/BusinessWorkspaceService.js', () => workspace);
vi.mock('../../src/db.js', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/auth/firebase.js', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import { businessWorkspaceRouter } from '../../src/routers/businessWorkspace.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';
const ORG = '10000000-0000-4000-8000-000000000001';
const MEMBER = '20000000-0000-4000-8000-000000000001';

const caller = businessWorkspaceRouter.createCaller({
  user: {
    id: ACTOR,
    email: 'owner@example.com',
    full_name: 'Workspace Owner',
    account_status: 'ACTIVE',
  } as any,
  firebaseUid: 'firebase-owner',
});

describe('business workspace authenticated router', () => {
  beforeEach(() => vi.clearAllMocks());

  it('binds workspace ownership to the authenticated actor', async () => {
    workspace.createBusinessWorkspace.mockResolvedValue({
      success: true, data: { id: ORG, role: 'OWNER' },
    });
    await caller.createWorkspace({
      legalName: 'Eastside Property Services LLC',
      displayName: 'Eastside Property Services',
      providerEnabled: true,
      clientEnabled: true,
      idempotencyKey: 'workspace:eps:001',
    });
    expect(workspace.createBusinessWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      actorId: ACTOR,
    }));
  });

  it('rejects browser attempts to inject ownership or verification state', async () => {
    await expect(caller.createWorkspace({
      legalName: 'Injected LLC', displayName: 'Injected', providerEnabled: true,
      clientEnabled: false, idempotencyKey: 'workspace:inject:001',
      actorId: MEMBER, verificationStatus: 'VERIFIED', payoutStatus: 'ACTIVE',
    } as any)).rejects.toThrow();
    expect(workspace.createBusinessWorkspace).not.toHaveBeenCalled();
  });

  it('binds member role changes to the authenticated actor', async () => {
    workspace.setBusinessMemberRole.mockResolvedValue({
      success: true, data: { id: '30000000-0000-4000-8000-000000000001', role: 'DISPATCHER' },
    });
    await caller.setMemberRole({ organizationId: ORG, memberUserId: MEMBER, role: 'DISPATCHER' });
    expect(workspace.setBusinessMemberRole).toHaveBeenCalledWith({
      actorId: ACTOR, organizationId: ORG, memberUserId: MEMBER, role: 'DISPATCHER',
    });
  });

  it('assigns a role by email without accepting a browser actor', async () => {
    workspace.setBusinessMemberRoleByEmail.mockResolvedValue({
      success: true, data: { id: '30000000-0000-4000-8000-000000000001', role: 'APPROVER' },
    });
    await caller.setMemberRoleByEmail({
      organizationId: ORG, memberEmail: 'approver@example.com', role: 'APPROVER',
    });
    expect(workspace.setBusinessMemberRoleByEmail).toHaveBeenCalledWith({
      actorId: ACTOR, organizationId: ORG,
      memberEmail: 'approver@example.com', role: 'APPROVER',
    });
    await expect(caller.setMemberRoleByEmail({
      organizationId: ORG, memberEmail: 'approver@example.com', role: 'APPROVER',
      actorId: MEMBER,
    } as any)).rejects.toThrow();
  });

  it('rejects an injected actor on a location write and never reaches encryption', async () => {
    await expect(caller.createLocation({
      organizationId: ORG, name: 'Bellevue Store', roughLocation: 'Bellevue',
      postalCode: '98004', regionCode: 'US-WA', timezone: 'America/Los_Angeles',
      exactAddress: '123 Private Way, Bellevue, WA', accessProcedure: 'Call the manager.',
      idempotencyKey: 'location:bellevue:001', actorId: MEMBER,
    } as any)).rejects.toThrow();
    expect(workspace.createBusinessLocation).not.toHaveBeenCalled();
  });

  it('uses the authenticated actor for every list boundary', async () => {
    workspace.listBusinessWorkspaces.mockResolvedValue({ success: true, data: [] });
    workspace.listBusinessMembers.mockResolvedValue({ success: true, data: [] });
    workspace.listBusinessLocations.mockResolvedValue({ success: true, data: [] });
    await caller.listMine();
    await caller.listMembers({ organizationId: ORG });
    await caller.listLocations({ organizationId: ORG });
    expect(workspace.listBusinessWorkspaces).toHaveBeenCalledWith(ACTOR);
    expect(workspace.listBusinessMembers).toHaveBeenCalledWith(ACTOR, ORG);
    expect(workspace.listBusinessLocations).toHaveBeenCalledWith(ACTOR, ORG);
  });

  it('maps database permission denial to a forbidden response', async () => {
    workspace.listBusinessMembers.mockResolvedValue({
      success: false,
      error: { code: 'BUSINESS_PERMISSION_DENIED', message: 'This business action is not permitted.' },
    });
    await expect(caller.listMembers({ organizationId: ORG })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
