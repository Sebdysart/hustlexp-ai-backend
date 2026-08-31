import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

import { db } from '../../src/db';
import {
  adminOrEngineBridgeProcedure,
  disputeAdminProcedure,
  escrowAdminProcedure,
  financialAdminProcedure,
  heldAdminOrEngineBridgeProcedure,
  heldEscrowAdminProcedure,
  heldFinancialAdminProcedure,
  heldOperationsAdminProcedure,
  heldPlatformAdminProcedure,
  heldSafetyAdminProcedure,
  heldTrustAdminProcedure,
  heldUserManagementAdminProcedure,
  platformAdminProcedure,
  router,
  safetyAdminProcedure,
  userManagementAdminProcedure,
} from '../../src/trpc';

const mockDb = vi.mocked(db);
let heldHandlerInvocations = 0;

function heldHandler() {
  heldHandlerInvocations += 1;
  return 'must-not-run';
}

const probeRouter = router({
  platform: platformAdminProcedure.query(() => 'platform'),
  financial: financialAdminProcedure.query(() => 'financial'),
  escrow: escrowAdminProcedure.query(() => 'escrow'),
  users: userManagementAdminProcedure.query(() => 'users'),
  disputes: disputeAdminProcedure.query(() => 'disputes'),
  safety: safetyAdminProcedure.query(() => 'safety'),
  bridgeEquivalent: adminOrEngineBridgeProcedure.query(() => 'bridge-equivalent'),
  heldPlatform: heldPlatformAdminProcedure.mutation(heldHandler),
  heldFinancial: heldFinancialAdminProcedure.mutation(heldHandler),
  heldEscrow: heldEscrowAdminProcedure.mutation(heldHandler),
  heldUsers: heldUserManagementAdminProcedure.mutation(heldHandler),
  heldTrust: heldTrustAdminProcedure.mutation(heldHandler),
  heldSafety: heldSafetyAdminProcedure.mutation(heldHandler),
  heldOperations: heldOperationsAdminProcedure.mutation(heldHandler),
  heldBridgeEquivalent: heldAdminOrEngineBridgeProcedure.mutation(heldHandler),
});

function caller(isAdmin: boolean | undefined = true) {
  return probeRouter.createCaller({
    user: {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      email: 'operator@example.com',
      full_name: 'Operator',
      firebase_uid: 'operator-firebase',
      is_admin: isAdmin,
    },
    firebaseUid: 'operator-firebase',
    identityAssurance: {
      authenticatedAtSeconds: Math.floor(Date.now() / 1000),
      tokenExpiresAtSeconds: Math.floor(Date.now() / 1000) + 3_600,
      signInProvider: 'password',
      secondFactor: 'phone',
      mfaVerified: true,
    },
  } as any);
}

function roleRow(role: string, capabilityGranted = false) {
  mockDb.query.mockResolvedValueOnce({
    rows: [{ role, capability_granted: capabilityGranted }],
    rowCount: 1,
  } as any);
}

describe('administrator capability procedures', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    heldHandlerInvocations = 0;
  });

  it.each(['admin', 'founder'])('allows %s break-glass access to platform control', async (role) => {
    roleRow(role);
    await expect(caller().platform()).resolves.toBe('platform');
  });

  it('denies support access to platform control', async () => {
    roleRow('support');
    await expect(caller().platform()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows finance only when financial capability is persisted', async () => {
    roleRow('finance', true);
    await expect(caller().financial()).resolves.toBe('financial');

    roleRow('finance', false);
    await expect(caller().escrow()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows a moderator to manage incidents but not user sanctions without capability', async () => {
    roleRow('moderator', true);
    await expect(caller().safety()).resolves.toBe('safety');

    roleRow('moderator', false);
    await expect(caller().users()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps dispute and escrow capabilities separate', async () => {
    roleRow('moderator', true);
    await expect(caller().disputes()).resolves.toBe('disputes');

    roleRow('moderator', false);
    await expect(caller().escrow()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('denies an ordinary authenticated user without issuing a capability query', async () => {
    await expect(caller(false).financial()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('queries only the closed capability column associated with the procedure', async () => {
    roleRow('finance', true);
    await caller().financial();
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain('COALESCE(can_access_financials, false) AS capability_granted');
    expect(sql).not.toContain('can_override_escrow');
    expect(params).toEqual([
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      ['admin', 'support', 'finance', 'moderator', 'founder'],
    ]);
  });

  it('requires a fresh admin or founder row for human engine-equivalent actions', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    await expect(caller(true).bridgeEquivalent()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows the authenticated engine bridge without a human role query', async () => {
    const bridge = probeRouter.createCaller({
      user: null,
      firebaseUid: null,
      engineBridgeAuthorized: true,
      engineBridgeActorId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    } as any);
    await expect(bridge.bridgeEquivalent()).resolves.toBe('bridge-equivalent');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it.each([
    'heldPlatform',
    'heldFinancial',
    'heldEscrow',
    'heldUsers',
    'heldTrust',
    'heldSafety',
    'heldOperations',
    'heldBridgeEquivalent',
  ] as const)('terminally holds %s after current authority checks and before its handler', async (route) => {
    roleRow('admin', true);
    await expect(caller()[route]()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(heldHandlerInvocations).toBe(0);
  });
});

describe('administrator capability migration', () => {
  it('normalizes historical role shapes and installs every enforced capability', () => {
    const sql = readFileSync(
      resolve(process.cwd(), 'backend/database/migrations/20260719_admin_capability_contract.sql'),
      'utf8',
    );
    expect(sql).toContain("'support', 'finance', 'moderator', 'admin', 'founder'");
    for (const capability of [
      'can_resolve_disputes',
      'can_override_escrow',
      'can_modify_trust',
      'can_ban_users',
      'can_access_financials',
      'can_manage_incidents',
    ]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${capability}`);
      expect(sql).toContain(`ALTER COLUMN ${capability} SET NOT NULL`);
    }
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_roles_user');
  });

  it('restricts REST UI-violation logging to platform roles', () => {
    const source = readFileSync(resolve(process.cwd(), 'backend/src/serverStateRoutes.ts'), 'utf8');
    expect(source).toContain("[user.id, ['admin', 'founder']]");
    expect(source).not.toContain("'SELECT user_id FROM admin_roles WHERE user_id = $1 LIMIT 1'");
  });
});
