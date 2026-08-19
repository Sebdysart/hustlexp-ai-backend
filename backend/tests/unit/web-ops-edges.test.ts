import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), listTasks: vi.fn() }));

vi.mock('../../src/db', () => ({ db: { query: mocks.query, transaction: vi.fn() } }));
vi.mock('../../src/services/AutomationLifecycleService', () => ({
  AutomationLifecycleService: { listTasks: mocks.listTasks },
}));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { webOpsRouter } from '../../src/routers/web/ops';

const HUSTLER_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_KEY = 'ops-admin-service-key'; // 20 chars
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function publicCaller() {
  return webOpsRouter.createCaller({ user: null, firebaseUid: null, ip: '127.0.0.1' });
}

function opsCaller() {
  return webOpsRouter.createCaller({
    user: {
      id: USER_ID,
      email: 'ops@example.com',
      full_name: 'Ops',
      firebase_uid: 'ops-firebase',
      is_admin: true,
      account_status: 'ACTIVE',
      is_banned: false,
    },
  } as any);
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

function grantOps() {
  mocks.query.mockResolvedValueOnce({
    rows: [{ role: 'admin', capability_granted: true }],
    rowCount: 1,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReset();
  process.env.ENGINE_OPS_ADMIN_KEY = SERVICE_KEY;
  process.env.OPS_ADMIN_KEY = SERVICE_KEY;
});

describe('web ops edge contracts', () => {
  it.each([
    ['INVALID_CURSOR', 'BAD_REQUEST'],
    ['DB_ERROR', 'INTERNAL_SERVER_ERROR'],
  ])('maps lifecycle read failure %s to %s', async (serviceCode, trpcCode) => {
    mocks.listTasks.mockResolvedValueOnce({ success: false, error: { code: serviceCode, message: 'blocked' } });
    await expect(publicCaller().listEngineTasks({ adminKey: SERVICE_KEY, limit: 20 }))
      .rejects.toMatchObject({ code: trpcCode });
  });

  it('inserts a fully characterized hustler for ops admins', async () => {
    grantOps();
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: HUSTLER_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // audit
    await expect(opsCaller().upsertHustler(hustler())).resolves.toEqual({ ok: true, id: HUSTLER_ID });
    const params = mocks.query.mock.calls[1][1] as unknown[];
    expect(params).toEqual([
      'Ready Hustler', '+12065550100', 'worker@example.com', '98004', 15, 'truck', 100,
      'approved', true, 'Weekends', 'Verified', ['yard_cleanup'],
    ]);
  });

  it('updates an existing hustler without duplicating identity', async () => {
    grantOps();
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await expect(opsCaller().upsertHustler(hustler({ id: HUSTLER_ID, available: false })))
      .resolves.toEqual({ ok: true, id: HUSTLER_ID });
    expect(String(mocks.query.mock.calls[1][0])).toContain("WHERE id=$13 AND lead_type='hustler'");
    expect(mocks.query.mock.calls[1][1][12]).toBe(HUSTLER_ID);
  });

  it('filters the roster by both status and availability', async () => {
    grantOps();
    mocks.query.mockResolvedValueOnce({ rows: [{ id: HUSTLER_ID }], rowCount: 1 });
    await expect(opsCaller().listHustlers({ status: 'approved', available: false }))
      .resolves.toMatchObject({ ok: true, hustlers: [{ id: HUSTLER_ID }] });
    expect(mocks.query.mock.calls[1][1]).toEqual(['approved', false]);
    expect(String(mocks.query.mock.calls[1][0])).toContain('status = $1');
    expect(String(mocks.query.mock.calls[1][0])).toContain('available = $2');
  });

  it('rejects upsert without operations capability', async () => {
    await expect(publicCaller().upsertHustler(hustler()))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
