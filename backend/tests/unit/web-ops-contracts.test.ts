import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  listTasks: vi.fn(),
  getLiquidity: vi.fn(),
}));

vi.mock('../../src/db', () => ({
  db: { query: mocks.query, transaction: mocks.transaction },
}));
vi.mock('../../src/services/AutomationLifecycleService', () => ({
  AutomationLifecycleService: { listTasks: mocks.listTasks },
}));
vi.mock('../../src/services/OpsLiquidityService', () => ({
  getOpsLiquidityPayload: mocks.getLiquidity,
}));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { webOpsRouter } from '../../src/routers/web/ops';

const SERVICE_KEY = 'engine-ops-admin-key!!'; // 22 chars
const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const QUOTE_ID = '22222222-2222-4222-8222-222222222222';
const VERSION_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

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

function publicCaller() {
  return webOpsRouter.createCaller({ user: null, firebaseUid: null, ip: '127.0.0.1' } as any);
}

function grantOpsCapability() {
  mocks.query.mockResolvedValueOnce({
    rows: [{ role: 'admin', capability_granted: true }],
    rowCount: 1,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReset();
  mocks.transaction.mockReset();
  mocks.listTasks.mockReset();
  mocks.getLiquidity.mockReset();
  process.env.ENGINE_OPS_ADMIN_KEY = SERVICE_KEY;
  process.env.OPS_ADMIN_KEY = SERVICE_KEY;
});

describe('webOps service-key auth (listEngineTasks)', () => {
  it('accepts a timing-safe ENGINE_OPS_ADMIN_KEY of sufficient length', async () => {
    mocks.listTasks.mockResolvedValueOnce({ success: true, data: { tasks: [], nextCursor: null } });
    await expect(publicCaller().listEngineTasks({ adminKey: SERVICE_KEY, limit: 25 }))
      .resolves.toEqual({ ok: true, tasks: [], nextCursor: null });
  });

  it('rejects short or mismatched service keys before reading lifecycle state', async () => {
    await expect(publicCaller().listEngineTasks({ adminKey: 'short', limit: 20 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(publicCaller().listEngineTasks({ adminKey: 'x'.repeat(22), limit: 20 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.listTasks).not.toHaveBeenCalled();
  });
});

describe('webOps operationsAdminProcedure gates', () => {
  it('rejects unauthenticated draft reads', async () => {
    await expect(publicCaller().listTaskDrafts({ limit: 10 }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('returns display-safe getTaskDraft columns without secret hashes', async () => {
    grantOpsCapability();
    mocks.query.mockResolvedValueOnce({
      rows: [{
        id: DRAFT_ID,
        title: 'Yard cleanup',
        status: 'quote_ready',
        card_token_hash: 'SHOULD_NOT_APPEAR',
        ip_hash: 'SHOULD_NOT_APPEAR',
        quote_status: 'draft',
        total_cents: 5000,
      }],
      rowCount: 1,
    });
    const result = await opsCaller().getTaskDraft({ id: DRAFT_ID });
    expect(result.ok).toBe(true);
    expect(result.draft).not.toHaveProperty('card_token_hash');
    expect(result.draft).not.toHaveProperty('ip_hash');
    expect(String(mocks.query.mock.calls.at(-1)?.[0])).toContain('d.id');
    expect(String(mocks.query.mock.calls.at(-1)?.[0])).not.toContain('card_token_hash');
  });

  it('redacts hustler phone and email from listHustlers', async () => {
    grantOpsCapability();
    mocks.query.mockResolvedValueOnce({
      rows: [{ id: DRAFT_ID, name_initial: 'R.', home_zip: '98004', hustler_available: true }],
      rowCount: 1,
    });
    const result = await opsCaller().listHustlers({});
    expect(result.ok).toBe(true);
    expect(String(mocks.query.mock.calls.at(-1)?.[0])).not.toMatch(/\bphone\b/);
    expect(String(mocks.query.mock.calls.at(-1)?.[0])).not.toMatch(/\bemail\b/);
  });

  it('creates quotes atomically and rejects already-linked drafts', async () => {
    grantOpsCapability();
    mocks.transaction.mockImplementationOnce(async (fn: (q: typeof mocks.query) => Promise<unknown>) => {
      const tx = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: DRAFT_ID, title: 'Move', quote_id: QUOTE_ID, status: 'quote_ready' }], rowCount: 1 });
      return fn(tx as any);
    });
    await expect(opsCaller().createQuote({
      task_draft_id: DRAFT_ID,
      customer_description: 'Haul junk',
      subtotal_cents: 4000,
    })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('already_linked') });
  });

  it('creates a quote inside a transaction when eligible', async () => {
    grantOpsCapability();
    mocks.transaction.mockImplementationOnce(async (fn: (q: typeof mocks.query) => Promise<unknown>) => {
      const tx = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: DRAFT_ID, title: 'Move', quote_id: null, status: 'contact_captured' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: QUOTE_ID }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: VERSION_ID }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });
      return fn(tx as any);
    });
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // audit
    await expect(opsCaller().createQuote({
      task_draft_id: DRAFT_ID,
      customer_description: 'Haul junk',
      subtotal_cents: 4000,
      service_fee_cents: 500,
    })).resolves.toMatchObject({
      ok: true,
      quote_id: QUOTE_ID,
      version_id: VERSION_ID,
      total_cents: 4500,
      status: 'quote_ready',
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('returns liquidity snapshot for ops admins', async () => {
    grantOpsCapability();
    mocks.getLiquidity.mockResolvedValueOnce({
      snapshot: {
        betaTesters: 3,
        activeTasks: 1,
        escrowHeldCents: 1000,
        payoutsPendingCents: 500,
        updatedAt: '2026-08-19T00:00:00.000Z',
      },
      series: [],
    });
    await expect(opsCaller().getLiquidity({})).resolves.toMatchObject({
      ok: true,
      snapshot: { betaTesters: 3, activeTasks: 1 },
    });
  });

  it('exposes feature flags as key (not name) on the public contract', async () => {
    mocks.query
      .mockRejectedValueOnce(new Error('column key does not exist'))
      .mockResolvedValueOnce({ rows: [{ key: 'native_survey', enabled: true }], rowCount: 1 });
    await expect(publicCaller().getPublicFlags({})).resolves.toEqual([
      { key: 'native_survey', enabled: true },
    ]);
  });
});
