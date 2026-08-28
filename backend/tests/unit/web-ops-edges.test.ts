import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), listTasks: vi.fn(), requestCommand: vi.fn(),
  approveCommand: vi.fn(), rejectCommand: vi.fn(), listPendingCommands: vi.fn(),
  listCommandHistory: vi.fn(),
}));

vi.mock('../../src/db', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/services/AutomationLifecycleService', () => ({
  AutomationLifecycleService: { listTasks: mocks.listTasks },
}));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));
vi.mock('../../src/services/OperatorAuthorityService', () => ({
  OperatorAuthorityService: {
    request: mocks.requestCommand,
    approve: mocks.approveCommand,
    reject: mocks.rejectCommand,
    listPending: mocks.listPendingCommands,
    listHistory: mocks.listCommandHistory,
  },
}));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { webOpsRouter } from '../../src/routers/web/ops';

const HUSTLER_ID = '11111111-1111-4111-8111-111111111111';

function caller(isAdmin = true) {
  return webOpsRouter.createCaller({
    user: {
      id: '22222222-2222-4222-8222-222222222222',
      is_admin: isAdmin,
      is_banned: false,
      account_status: 'ACTIVE',
      default_mode: 'poster',
    },
    firebaseUid: 'named-firebase-operator',
    identityAssurance: {
      authenticatedAtSeconds: Math.floor(Date.now() / 1000),
      tokenExpiresAtSeconds: Math.floor(Date.now() / 1000) + 3_600,
      signInProvider: 'password',
      secondFactor: 'phone',
      mfaVerified: true,
    },
    ip: '127.0.0.1',
  } as any);
}

function anonymousCaller() {
  return webOpsRouter.createCaller({ user: null, firebaseUid: null, ip: '127.0.0.1' });
}

function authorizeOperations(granted = true) {
  mocks.query.mockResolvedValueOnce({
    rows: [{ role: 'support', capability_granted: granted }], rowCount: 1,
  });
}

function hustler(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Ready Hustler',
    phone: '+12065550100',
    email: 'worker@example.com',
    home_zip: '98004',
    radius_miles: 15,
    vehicle: 'truck',
    max_lift_lbs: 100,
    status: 'approved',
    available: true,
    availability_note: 'Weekends',
    notes: 'Verified',
    skills: ['yard_cleanup'],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReset();
  mocks.requestCommand.mockResolvedValue({
    commandId: '33333333-3333-4333-8333-333333333333',
    status: 'PENDING',
    version: 1,
    idempotencyReplayed: false,
  });
});

describe('web ops edge contracts', () => {
  it.each([
    ['INVALID_CURSOR', 'BAD_REQUEST'],
    ['DB_ERROR', 'INTERNAL_SERVER_ERROR'],
  ])('maps lifecycle read failure %s to %s', async (serviceCode, trpcCode) => {
    authorizeOperations();
    mocks.listTasks.mockResolvedValueOnce({ success: false, error: { code: serviceCode, message: 'blocked' } });
    await expect(caller().listEngineTasks({ limit: 20 }))
      .rejects.toMatchObject({ code: trpcCode });
  });

  it('holds a fully characterized hustler insert without writing', async () => {
    authorizeOperations();
    await expect(caller().upsertHustler(hustler()))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.query.mock.calls[0][0])).not.toMatch(/INSERT\s+INTO\s+leads/i);
  });

  it('holds an existing hustler update without mutating identity', async () => {
    authorizeOperations();
    await expect(caller().upsertHustler(hustler({ id: HUSTLER_ID, available: false })))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.query.mock.calls[0][0])).not.toMatch(/UPDATE\s+leads/i);
  });

  it('filters the roster by both status and availability', async () => {
    authorizeOperations();
    mocks.query.mockResolvedValueOnce({ rows: [{ id: HUSTLER_ID }], rowCount: 1 });
    await expect(caller().listHustlers({ status: 'approved', available: false }))
      .resolves.toEqual({ ok: true, hustlers: [{ id: HUSTLER_ID }] });
    expect(mocks.query.mock.calls[1][1]).toEqual(['approved', false]);
    expect(String(mocks.query.mock.calls[1][0])).toContain('status = $1');
    expect(String(mocks.query.mock.calls[1][0])).toContain('available = $2');
  });

  it('rejects anonymous and ordinary authenticated callers before legacy writes', async () => {
    await expect(anonymousCaller().upsertHustler(hustler()))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller(false).upsertHustler(hustler()))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects staff without can_manage_operations', async () => {
    authorizeOperations(false);
    await expect(caller().listHustlers({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('routes only feature-flag disablement through the stepped-up two-person rail', async () => {
    authorizeOperations();
    const idempotencyKey = '44444444-4444-4444-8444-444444444444';
    await expect(caller().updateFlag({
      key: 'legacy_intake_surface',
      enabled: false,
      expectedVersion: 9,
      idempotencyKey,
      reason: 'Contain the stale intake surface during review.',
    })).resolves.toMatchObject({ status: 'PENDING' });
    expect(mocks.requestCommand).toHaveBeenCalledWith(expect.anything(), {
      operationType: 'DISABLE_FEATURE_FLAG',
      targetId: 'legacy_intake_surface',
      targetExpectedVersion: 9,
      reason: 'Contain the stale intake surface during review.',
      idempotencyKey,
    });
    expect(String(mocks.query.mock.calls[0][0])).not.toMatch(/UPDATE\s+feature_flags/i);
  });

  it('lists exact versioned flag targets and immutable command history only after Operations step-up', async () => {
    authorizeOperations();
    mocks.query.mockResolvedValueOnce({
      rows: [{ key: 'legacy_intake_surface', enabled: true, version: 9 }], rowCount: 1,
    });
    await expect(caller().listFeatureFlagTargets({})).resolves.toEqual({
      flags: [{ key: 'legacy_intake_surface', enabled: true, version: 9 }],
    });
    expect(String(mocks.query.mock.calls[1][0])).toContain('SELECT name AS key, enabled, version');

    authorizeOperations();
    mocks.listCommandHistory.mockResolvedValueOnce({ commands: [] });
    await expect(caller().listCommandHistory({ limit: 25 })).resolves.toEqual({ commands: [] });
    expect(mocks.listCommandHistory).toHaveBeenCalledWith(expect.anything(), 25);
  });
});
