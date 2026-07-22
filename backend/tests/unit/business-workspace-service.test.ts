import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  encryptTaskLocation: vi.fn((vaultId: string, value: string) => ({
    ciphertext: `cipher:${vaultId}`,
    nonce: `nonce:${value.length}`,
    authTag: `tag:${value.length}`,
    keyId: 'location-v1',
    fingerprint: 'a'.repeat(64),
  })),
}));

vi.mock('../../src/db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/services/TaskLocationCrypto.js', () => ({
  encryptTaskLocation: mocks.encryptTaskLocation,
}));
vi.mock('../../src/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  createBusinessLocation,
  createBusinessWorkspace,
  listBusinessLocations,
  listBusinessMembers,
  listBusinessWorkspaces,
  setBusinessMemberRole,
  setBusinessMemberRoleByEmail,
} from '../../src/services/BusinessWorkspaceService.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';
const ORG = '10000000-0000-4000-8000-000000000001';
const MEMBER = '20000000-0000-4000-8000-000000000001';

describe('business workspace service boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a dual-mode workspace with the authenticated actor as owner', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ organization_id: ORG, actor_role: 'OWNER' }] });
    const result = await createBusinessWorkspace({
      actorId: ACTOR,
      legalName: 'Eastside Property Services LLC',
      displayName: 'Eastside Property Services',
      providerEnabled: true,
      clientEnabled: true,
      idempotencyKey: 'workspace:eps:001',
    });
    expect(result).toEqual({ success: true, data: { id: ORG, role: 'OWNER' } });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      ACTOR, 'Eastside Property Services LLC', 'Eastside Property Services',
      true, true, 'workspace:eps:001',
    ]);
  });

  it('lists only active memberships for the authenticated actor', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: ORG, display_name: 'Eastside', provider_enabled: true, client_enabled: false,
      verification_status: 'PENDING', payout_status: 'NOT_STARTED', role: 'OWNER',
      member_count: 1, location_count: 0,
    }] });
    const result = await listBusinessWorkspaces(ACTOR);
    expect(result).toMatchObject({ success: true, data: [{ id: ORG, role: 'OWNER' }] });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([ACTOR]);
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain("membership.status='ACTIVE'");
  });

  it('delegates member role changes to the database authority function', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ membership_id: '30000000-0000-4000-8000-000000000001', member_role: 'DISPATCHER' }] });
    const result = await setBusinessMemberRole({
      actorId: ACTOR, organizationId: ORG, memberUserId: MEMBER, role: 'DISPATCHER',
    });
    expect(result).toMatchObject({ success: true, data: { role: 'DISPATCHER' } });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([ORG, ACTOR, MEMBER, 'DISPATCHER']);
  });

  it('assigns a member by normalized email only through the permission-first database function', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      membership_id: '30000000-0000-4000-8000-000000000001', member_role: 'APPROVER',
    }] });
    const result = await setBusinessMemberRoleByEmail({
      actorId: ACTOR,
      organizationId: ORG,
      memberEmail: '  Approver@Example.com ',
      role: 'APPROVER',
    });
    expect(result).toMatchObject({ success: true, data: { role: 'APPROVER' } });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      ORG, ACTOR, 'approver@example.com', 'APPROVER',
    ]);
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('set_business_member_role_by_email');
  });

  it('lists member identity without exposing email or Firebase identity', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: '30000000-0000-4000-8000-000000000001', user_id: MEMBER,
      full_name: 'Casey Dispatcher', role: 'DISPATCHER', status: 'ACTIVE',
    }] });
    const result = await listBusinessMembers(ACTOR, ORG);
    expect(result).toMatchObject({ success: true, data: [{ fullName: 'Casey Dispatcher' }] });
    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).not.toMatch(/email|firebase/i);
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([ORG, ACTOR]);
  });

  it('encrypts exact address and access procedure before persistence', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ location_id: '40000000-0000-4000-8000-000000000001' }] });
    const result = await createBusinessLocation({
      actorId: ACTOR,
      organizationId: ORG,
      name: 'Bellevue Store 12',
      roughLocation: 'Downtown Bellevue',
      postalCode: '98004',
      regionCode: 'US-WA',
      timezone: 'America/Los_Angeles',
      exactAddress: '123 Private Service Way, Bellevue, WA 98004',
      accessProcedure: 'Manager opens the rear service entrance.',
      idempotencyKey: 'location:bellevue:12',
    });
    expect(result).toMatchObject({ success: true, data: { id: expect.any(String) } });
    expect(mocks.encryptTaskLocation).toHaveBeenCalledTimes(2);
    const serializedParams = JSON.stringify(mocks.query.mock.calls[0]?.[1]);
    expect(serializedParams).not.toContain('123 Private Service Way');
    expect(serializedParams).not.toContain('Manager opens the rear service entrance');
  });

  it('lists only rough location metadata and never vault material', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: '40000000-0000-4000-8000-000000000001', name: 'Bellevue Store 12',
      rough_location: 'Downtown Bellevue', postal_code: '98004', region_code: 'US-WA',
      timezone: 'America/Los_Angeles', status: 'ACTIVE', access_configured: true,
    }] });
    const result = await listBusinessLocations(ACTOR, ORG);
    expect(result).toMatchObject({ success: true, data: [{ roughLocation: 'Downtown Bellevue' }] });
    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).not.toMatch(/ciphertext|nonce|auth_tag|fingerprint|SELECT \*/i);
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([ORG, ACTOR]);
  });

  it('maps database permission refusal to a stable fail-closed error', async () => {
    mocks.query.mockRejectedValueOnce(new Error('HXBUS2: business location action is not permitted'));
    const result = await createBusinessLocation({
      actorId: ACTOR, organizationId: ORG, name: 'Cross-org target',
      roughLocation: 'Bellevue', postalCode: '98004', regionCode: 'US-WA',
      timezone: 'America/Los_Angeles', exactAddress: '1 Private Way',
      accessProcedure: 'Call the manager', idempotencyKey: 'location:cross:001',
    });
    expect(result).toEqual({
      success: false,
      error: { code: 'BUSINESS_PERMISSION_DENIED', message: 'This business action is not permitted.' },
    });
  });

  it('returns a generic member-not-found result after an authorized email lookup', async () => {
    mocks.query.mockRejectedValueOnce(new Error('HXBUS6: no eligible user account matched'));
    const result = await setBusinessMemberRoleByEmail({
      actorId: ACTOR, organizationId: ORG, memberEmail: 'missing@example.com', role: 'VIEWER',
    });
    expect(result).toEqual({
      success: false,
      error: { code: 'BUSINESS_MEMBER_NOT_FOUND', message: 'No eligible HustleXP account matched that email.' },
    });
  });
});
