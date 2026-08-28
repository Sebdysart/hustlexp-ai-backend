import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), info: vi.fn(), warn: vi.fn(), requestCommand: vi.fn(),
}));

vi.mock('../../src/db', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({
      info: mocks.info,
      warn: mocks.warn,
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));
vi.mock('../../src/services/OperatorAuthorityService', () => ({
  OperatorAuthorityService: {
    request: mocks.requestCommand,
    approve: vi.fn(),
    listPending: vi.fn(),
  },
}));

import {
  handleActionLinkGet,
  handleActionLinkPost,
  webActionLinksRouter,
} from '../../src/routers/web/actionLinks';

const LINK_ID = '11111111-1111-4111-8111-111111111111';
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222';

function operatorCaller(isAdmin = true) {
  return webActionLinksRouter.createCaller({
    user: {
      id: OPERATOR_ID,
      is_admin: isAdmin,
      is_banned: false,
      account_status: 'ACTIVE',
      default_mode: 'poster',
    },
    firebaseUid: 'named-firebase-operator',
    identityAssurance: {
      authenticatedAtSeconds: Math.floor(Date.now() / 1000),
      tokenExpiresAtSeconds: Math.floor(Date.now() / 1000) + 3600,
      signInProvider: 'password',
      secondFactor: 'phone',
      mfaVerified: true,
    },
    ip: '127.0.0.1',
  } as any);
}

function authorizeOperations(granted = true) {
  mocks.query.mockResolvedValueOnce({
    rows: [{ role: 'support', capability_granted: granted }], rowCount: 1,
  });
}

function actionLinkRow() {
  return {
    id: LINK_ID,
    link_type: 'poster_scope',
    role: 'poster',
    status: 'link_sent',
    expires_at: new Date(Date.now() + 60_000),
    allowed_actions: ['confirm_scope', 'pay', 'ask_question'],
    metadata: {
      title: 'Review estimate',
      next_step: 'Pay now',
      pay_url: 'https://processor.invalid/pay/live-secret',
    },
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

describe('web action-link named-operator authority', () => {
  it('capability-gates the admin read and suppresses legacy payment surfaces', async () => {
    authorizeOperations();
    mocks.query.mockResolvedValueOnce({ rows: [actionLinkRow()], rowCount: 1 });

    const result = await operatorCaller().list({ status: 'link_sent' });

    expect(result.links[0].allowed_actions).toEqual(['confirm_scope', 'ask_question']);
    expect(result.links[0].metadata).not.toHaveProperty('pay_url');
    expect(String(mocks.query.mock.calls[0][0])).toContain('can_manage_operations');
    expect(String(mocks.query.mock.calls[1][0])).toContain("array_remove(allowed_actions, 'pay')");
    expect(String(mocks.query.mock.calls[1][0])).toContain("metadata - 'pay_url'");
  });

  it('holds legacy creation after operator authorization without performing a write', async () => {
    authorizeOperations();
    await expect(operatorCaller().create({ link_type: 'poster_scope' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.query.mock.calls[0][0])).not.toMatch(/INSERT\s+INTO\s+action_links/i);
  });

  it('turns expiry into a stepped-up, versioned command instead of a direct write', async () => {
    authorizeOperations();
    const idempotencyKey = '44444444-4444-4444-8444-444444444444';
    await expect(operatorCaller().updateStatus({
      id: LINK_ID,
      status: 'expired',
      expectedVersion: 7,
      idempotencyKey,
      reason: 'Contain this stale public action link.',
    })).resolves.toMatchObject({ status: 'PENDING' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.query.mock.calls[0][0])).not.toMatch(/UPDATE\s+action_links/i);
    expect(mocks.requestCommand).toHaveBeenCalledWith(expect.objectContaining({
      user: expect.objectContaining({ id: OPERATOR_ID }),
    }), {
      operationType: 'EXPIRE_ACTION_LINK',
      targetId: LINK_ID,
      targetExpectedVersion: 7,
      reason: 'Contain this stale public action link.',
      idempotencyKey,
    });
  });

  it('rejects an ordinary authenticated caller before admin reads', async () => {
    await expect(operatorCaller(false).list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe('public action-link frozen-money boundary', () => {
  it('returns scope actions without a pay action or pay URL', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [actionLinkRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await handleActionLinkGet('public-token');
    const link = result.link as {
      allowed_actions: string[];
      display: Record<string, unknown>;
    };

    expect(result.ok).toBe(true);
    expect(link.allowed_actions).toEqual(['confirm_scope', 'ask_question']);
    expect(link.display).not.toHaveProperty('pay_url');
    expect(link.display.payment_status_label).toBe('Payment creation unavailable');
    expect(link.display.next_step).toMatch(/payment creation is currently unavailable/i);
  });

  it('rejects a legacy pay action without recording an event or changing link state', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [actionLinkRow()], rowCount: 1 });

    await expect(handleActionLinkPost('public-token', 'Pay')).resolves.toEqual({
      ok: false,
      code: 'payment_creation_frozen',
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it('preserves a permitted non-money action', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [actionLinkRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(handleActionLinkPost('public-token', 'confirm_scope')).resolves.toEqual({
      ok: true,
      status: 'action_taken',
    });
    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(mocks.query.mock.calls[1][1]).toEqual([
      LINK_ID,
      'confirm_scope',
      JSON.stringify({ action: 'confirm_scope' }),
    ]);
  });

  it('preserves a bounded clarification note only on the ask-question action', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [actionLinkRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(handleActionLinkPost('public-token', 'ask_question', '  Saturday morning  '))
      .resolves.toEqual({ ok: true, status: 'action_taken' });
    expect(mocks.query.mock.calls[1][1]).toEqual([
      LINK_ID,
      'ask_question',
      JSON.stringify({ action: 'ask_question', note: 'Saturday morning' }),
    ]);
  });

  it('rejects missing, oversized, or cross-action notes before recording an event', async () => {
    for (const [action, note, code] of [
      ['ask_question', '   ', 'invalid_note'],
      ['ask_question', 'x'.repeat(2001), 'invalid_note'],
      ['confirm_scope', 'unexpected note', 'note_not_allowed'],
    ] as const) {
      mocks.query.mockResolvedValueOnce({ rows: [actionLinkRow()], rowCount: 1 });
      await expect(handleActionLinkPost('public-token', action, note)).resolves.toEqual({
        ok: false,
        code,
      });
    }
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });
});
