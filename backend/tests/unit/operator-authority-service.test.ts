import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));

vi.mock('../../src/db', () => ({
  db: { query: mocks.query, transaction: mocks.transaction },
}));

import {
  approveOperatorCommand,
  getOperatorSession,
  listOperatorCommandHistory,
  rejectOperatorCommand,
  requestOperatorCommand,
} from '../../src/services/OperatorAuthorityService';

const REQUESTER_ID = '11111111-1111-4111-8111-111111111111';
const APPROVER_ID = '22222222-2222-4222-8222-222222222222';
const LINK_ID = '33333333-3333-4333-8333-333333333333';
const COMMAND_ID = '44444444-4444-4444-8444-444444444444';
const REQUEST_KEY = '55555555-5555-4555-8555-555555555555';
const APPROVAL_KEY = '66666666-6666-4666-8666-666666666666';

function context(userId = REQUESTER_ID, assurance = true) {
  const now = Math.floor(Date.now() / 1000);
  return {
    user: {
      id: userId,
      full_name: userId === REQUESTER_ID ? 'Requesting Operator' : 'Approving Operator',
      email: 'operator@example.com',
      is_admin: true,
      is_banned: false,
      account_status: 'ACTIVE',
      default_mode: 'poster',
    },
    firebaseUid: `firebase-${userId}`,
    identityAssurance: assurance ? {
      authenticatedAtSeconds: now - 30,
      tokenExpiresAtSeconds: now + 3_600,
      signInProvider: 'password',
      secondFactor: 'phone',
      mfaVerified: true,
    } : undefined,
    ip: '127.0.0.1',
  } as any;
}

function role(roleName = 'support', granted = true) {
  return { rows: [{ role: roleName, can_manage_operations: granted }], rowCount: 1 };
}

function pendingCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMAND_ID,
    operation_type: 'EXPIRE_ACTION_LINK',
    authority_scope: 'ACTION_LINK_STATUS',
    target_kind: 'ACTION_LINK',
    target_id: LINK_ID,
    target_expected_version: 3,
    command_payload: { status: 'expired' },
    status: 'PENDING',
    requested_by: REQUESTER_ID,
    approved_by: null,
    decision_idempotency_key: null,
    request_hash: 'a'.repeat(64),
    execution_result: null,
    version: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (callback: (query: typeof mocks.query) => unknown) => callback(mocks.query));
});

describe('operator session authority', () => {
  it('returns the exact web session contract for a named, stepped-up admin', async () => {
    mocks.query.mockResolvedValueOnce(role('admin', false));
    const result = await getOperatorSession(context());
    expect(result).toMatchObject({
      subject: `firebase-${REQUESTER_ID}`,
      displayName: 'Requesting Operator',
      roles: ['operator_viewer', 'operator_responder', 'operator_admin'],
      stepUpVerified: true,
    });
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('fails before any database lookup without fresh MFA step-up', async () => {
    await expect(getOperatorSession(context(REQUESTER_ID, false)))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects a suspended named identity before role or command lookup', async () => {
    const suspended = context();
    suspended.user.account_status = 'SUSPENDED';
    await expect(getOperatorSession(suspended)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('fails closed when the current role no longer grants Operations scope', async () => {
    mocks.query.mockResolvedValueOnce(role('support', false));
    await expect(getOperatorSession(context())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('versioned two-person operator commands', () => {
  it('returns purpose-bounded immutable command history without exposing actor UUIDs', async () => {
    const historyRow = {
      id: COMMAND_ID,
      operation_type: 'DISABLE_FEATURE_FLAG',
      authority_scope: 'FEATURE_FLAGS',
      target_kind: 'FEATURE_FLAG',
      target_id: 'legacy_intake_surface',
      target_expected_version: 9,
      command_payload: { enabled: false },
      reason: 'Contain the stale intake surface during review.',
      status: 'EXECUTED',
      requested_at: '2026-08-28T00:00:00.000Z',
      decided_at: '2026-08-28T00:01:00.000Z',
      approval_reason: 'Independently verified the exact target version.',
      execution_result: { targetId: 'legacy_intake_surface', enabled: false, version: 10 },
      version: 2,
      requester_display_name: 'Requesting Operator',
      approver_display_name: 'Approving Operator',
      requested_by_current_operator: true,
      approved_by_current_operator: false,
      events: [
        { eventType: 'REQUESTED', commandVersion: 1, actorDisplayName: 'Requesting Operator' },
        { eventType: 'APPROVED_AND_EXECUTED', commandVersion: 2, actorDisplayName: 'Approving Operator' },
      ],
    };
    mocks.query
      .mockResolvedValueOnce(role())
      .mockResolvedValueOnce({ rows: [historyRow], rowCount: 1 });

    await expect(listOperatorCommandHistory(context(), 50)).resolves.toEqual({
      commands: [historyRow],
    });
    const [sql, values] = mocks.query.mock.calls[1];
    expect(String(sql)).toContain('FROM operator_command_requests command');
    expect(String(sql)).toContain('FROM operator_command_audit event');
    expect(String(sql)).toContain('requested_by_current_operator');
    expect(String(sql)).toContain('approved_by_current_operator');
    expect(values).toEqual([50, REQUESTER_ID]);
    expect(historyRow).not.toHaveProperty('requested_by');
    expect(historyRow).not.toHaveProperty('approved_by');
  });

  it('requests action-link containment and writes its audit in one transaction', async () => {
    mocks.query
      .mockResolvedValueOnce(role())
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ version: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: COMMAND_ID, status: 'PENDING', version: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(requestOperatorCommand(context(), {
      operationType: 'EXPIRE_ACTION_LINK',
      targetId: LINK_ID,
      targetExpectedVersion: 3,
      reason: 'Contain an obsolete public action link.',
      idempotencyKey: REQUEST_KEY,
    })).resolves.toEqual({
      commandId: COMMAND_ID,
      status: 'PENDING',
      version: 1,
      idempotencyReplayed: false,
    });

    expect(mocks.transaction).toHaveBeenCalledOnce();
    const sql = mocks.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('SELECT version FROM action_links');
    expect(sql).toContain('INSERT INTO operator_command_requests');
    expect(sql).toContain('INSERT INTO operator_command_audit');
    expect(sql).not.toMatch(/UPDATE\s+action_links/i);
  });

  it('rejects a stale target version before creating command evidence', async () => {
    mocks.query
      .mockResolvedValueOnce(role())
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ version: 4 }], rowCount: 1 });

    await expect(requestOperatorCommand(context(), {
      operationType: 'EXPIRE_ACTION_LINK',
      targetId: LINK_ID,
      targetExpectedVersion: 3,
      reason: 'Contain an obsolete public action link.',
      idempotencyKey: REQUEST_KEY,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.query.mock.calls.map(([statement]) => String(statement)).join('\n'))
      .not.toContain('INSERT INTO operator_command_requests');
  });

  it('prevents self-approval before touching the target', async () => {
    mocks.query
      .mockResolvedValueOnce(role('admin', false))
      .mockResolvedValueOnce({ rows: [pendingCommand()], rowCount: 1 });

    await expect(approveOperatorCommand(context(), {
      commandId: COMMAND_ID,
      expectedCommandVersion: 1,
      reason: 'Independently verify this containment request.',
      idempotencyKey: APPROVAL_KEY,
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const sql = mocks.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).not.toMatch(/UPDATE\s+action_links/i);
    expect(sql).not.toContain('APPROVED_AND_EXECUTED');
  });

  it('requires operator-admin scope for the independent approver', async () => {
    mocks.query.mockResolvedValueOnce(role('support', true));
    await expect(approveOperatorCommand(context(APPROVER_ID), {
      commandId: COMMAND_ID,
      expectedCommandVersion: 1,
      reason: 'Independently verify this containment request.',
      idempotencyKey: APPROVAL_KEY,
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it('executes only after a distinct admin rechecks both exact versions', async () => {
    mocks.query
      .mockResolvedValueOnce(role('admin', false))
      .mockResolvedValueOnce({ rows: [pendingCommand()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ version: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: LINK_ID, status: 'expired', version: 4 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: COMMAND_ID, status: 'EXECUTED', version: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await approveOperatorCommand(context(APPROVER_ID), {
      commandId: COMMAND_ID,
      expectedCommandVersion: 1,
      reason: 'Independently verified target and containment purpose.',
      idempotencyKey: APPROVAL_KEY,
    });

    expect(result).toEqual({
      commandId: COMMAND_ID,
      status: 'EXECUTED',
      version: 2,
      executionResult: { targetId: LINK_ID, status: 'expired', version: 4 },
      idempotencyReplayed: false,
    });
    const sql = mocks.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toMatch(/WHERE id = \$1 AND version = \$2/);
    expect(sql).toContain("status = 'EXECUTED'");
    expect(sql).toContain('APPROVED_AND_EXECUTED');
  });

  it('replays an exact completed approval without executing twice', async () => {
    const executionResult = { targetId: LINK_ID, status: 'expired', version: 4 };
    mocks.query
      .mockResolvedValueOnce(role('admin', false))
      .mockResolvedValueOnce({ rows: [pendingCommand({
        status: 'EXECUTED',
        approved_by: APPROVER_ID,
        decision_idempotency_key: APPROVAL_KEY,
        execution_result: executionResult,
        version: 2,
      })], rowCount: 1 });

    await expect(approveOperatorCommand(context(APPROVER_ID), {
      commandId: COMMAND_ID,
      expectedCommandVersion: 1,
      reason: 'Independently verified target and containment purpose.',
      idempotencyKey: APPROVAL_KEY,
    })).resolves.toMatchObject({
      status: 'EXECUTED',
      executionResult,
      idempotencyReplayed: true,
    });
    const sql = mocks.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).not.toMatch(/UPDATE\s+action_links/i);
  });

  it('lets a distinct admin reject a pending command without touching its target', async () => {
    mocks.query
      .mockResolvedValueOnce(role('founder', false))
      .mockResolvedValueOnce({ rows: [pendingCommand()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: COMMAND_ID, status: 'REJECTED', version: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(rejectOperatorCommand(context(APPROVER_ID), {
      commandId: COMMAND_ID,
      expectedCommandVersion: 1,
      reason: 'Reject because the containment target was misidentified.',
      idempotencyKey: APPROVAL_KEY,
    })).resolves.toEqual({
      commandId: COMMAND_ID,
      status: 'REJECTED',
      version: 2,
      idempotencyReplayed: false,
    });
    const sql = mocks.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain("status = 'REJECTED'");
    expect(sql).toContain("'REJECTED'");
    expect(sql).not.toMatch(/UPDATE\s+(?:action_links|feature_flags)/i);
  });
});
