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

const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
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
});

describe('webOps named-session auth (listEngineTasks)', () => {
  it('accepts a named operator with can_manage_operations', async () => {
    grantOpsCapability();
    mocks.listTasks.mockResolvedValueOnce({ success: true, data: { tasks: [], nextCursor: null } });
    await expect(opsCaller().listEngineTasks({ limit: 25 }))
      .resolves.toEqual({ ok: true, tasks: [], nextCursor: null });
  });

  it('rejects an anonymous caller before reading lifecycle state', async () => {
    await expect(publicCaller().listEngineTasks({ limit: 20 }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
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

  it('freezes quote creation before any database or engine effect', async () => {
    grantOpsCapability();
    await expect(opsCaller().createQuote({
      task_draft_id: DRAFT_ID,
      customer_description: 'Haul junk',
      subtotal_cents: 4000,
    })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'HX_OPS_MUTATION_FROZEN:create_quote',
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('freezes quote send-ready before any database or engine effect', async () => {
    grantOpsCapability();
    await expect(opsCaller().markQuoteSendReady({ task_draft_id: DRAFT_ID }))
      .rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'HX_OPS_MUTATION_FROZEN:mark_quote_send_ready',
      });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('freezes feature flags and business claim links before effects', async () => {
    grantOpsCapability();
    await expect(opsCaller().updateFlag({ key: 'money_enabled', enabled: true }))
      .rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'HX_OPS_MUTATION_FROZEN:update_feature_flag',
      });
    expect(mocks.query).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    grantOpsCapability();
    await expect(opsCaller().createBusinessClaimLink({ task_draft_id: DRAFT_ID }))
      .rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'HX_OPS_MUTATION_FROZEN:create_business_claim_link',
      });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
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
