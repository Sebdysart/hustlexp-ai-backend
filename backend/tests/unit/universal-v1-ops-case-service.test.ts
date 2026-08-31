import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));

vi.mock('../../src/db', () => ({
  db: { query: mocks.query, transaction: mocks.transaction },
}));

import {
  acknowledgeUniversalV1OpsCase,
  decideUniversalV1OpsCaseTransition,
  getUniversalV1OpsCase,
  openUniversalV1OpsCase,
  requestUniversalV1OpsCaseTransition,
} from '../../src/services/UniversalV1OpsCaseService';

const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';
const APPROVER_ID = '22222222-2222-4222-8222-222222222222';
const OCCURRENCE_ID = '33333333-3333-4333-8333-333333333333';
const CASE_ID = '44444444-4444-4444-8444-444444444444';
const TRANSITION_ID = '55555555-5555-4555-8555-555555555555';
const IDEMPOTENCY_KEY = '66666666-6666-4666-8666-666666666666';
const DIGEST = 'a'.repeat(64);

function context(userId = OPERATOR_ID, steppedUp = true) {
  const now = Math.floor(Date.now() / 1000);
  return {
    user: {
      id: userId,
      full_name: 'Named Operator',
      email: 'operator@example.com',
      is_admin: true,
      is_banned: false,
      account_status: 'ACTIVE',
      default_mode: 'poster',
    },
    firebaseUid: `firebase-${userId}`,
    identityAssurance: steppedUp
      ? {
          authenticatedAtSeconds: now - 30,
          tokenExpiresAtSeconds: now + 3_600,
          signInProvider: 'password',
          secondFactor: 'phone',
          mfaVerified: true,
        }
      : undefined,
    ip: '127.0.0.1',
  } as any;
}

const openInput = {
  occurrenceId: OCCURRENCE_ID,
  occurrenceEventName: 'task.execution.failed',
  occurrenceVersion: 1,
  aggregateKind: 'task_draft',
  aggregateId: CASE_ID,
  aggregateVersion: 7,
  category: 'FULFILLMENT' as const,
  severity: 'HIGH' as const,
  reason: 'Execution occurrence requires bounded operator investigation.',
  evidenceDigest: DIGEST,
  idempotencyKey: IDEMPOTENCY_KEY,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (callback: (query: typeof mocks.query) => unknown) =>
    callback(mocks.query)
  );
});

describe('UniversalV1OpsCaseService authority', () => {
  it('fails before database access without a named fresh MFA identity', async () => {
    await expect(
      openUniversalV1OpsCase(context(OPERATOR_ID, false), openInput)
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('opens only through the exact occurrence-bound database function', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          case_id: CASE_ID,
          case_status: 'OPEN',
          case_version: '1',
          idempotency_replayed: false,
        },
      ],
      rowCount: 1,
    });

    await expect(openUniversalV1OpsCase(context(), openInput)).resolves.toEqual({
      caseId: CASE_ID,
      status: 'OPEN',
      version: 1,
      idempotencyReplayed: false,
      actorAuthority: expect.objectContaining({
        databaseCallerIdentityAttested: false,
        directFunctionInvocation: 'HELD_PENDING_DEDICATED_COMMAND_ROLE',
      }),
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('open_universal_v1_ops_case_v1'),
      [
        OCCURRENCE_ID,
        'task.execution.failed',
        1,
        'task_draft',
        CASE_ID,
        7,
        'FULFILLMENT',
        'HIGH',
        openInput.reason,
        DIGEST,
        OPERATOR_ID,
        IDEMPOTENCY_KEY,
      ]
    );
    const sql = String(mocks.query.mock.calls[0][0]);
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
  });

  it('acknowledges through an expected-version command', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          case_id: CASE_ID,
          case_status: 'ACKNOWLEDGED',
          case_version: 2,
          idempotency_replayed: false,
        },
      ],
      rowCount: 1,
    });
    await expect(
      acknowledgeUniversalV1OpsCase(context(), {
        caseId: CASE_ID,
        expectedVersion: 1,
        reason: 'Acknowledge the exact occurrence and begin investigation.',
        evidenceDigest: DIGEST,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
    ).resolves.toMatchObject({ status: 'ACKNOWLEDGED', version: 2 });
    expect(mocks.query.mock.calls[0][1]).toEqual([
      CASE_ID,
      1,
      'Acknowledge the exact occurrence and begin investigation.',
      DIGEST,
      OPERATOR_ID,
      IDEMPOTENCY_KEY,
    ]);
  });

  it('separates transition request from independent decision', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            transition_request_id: TRANSITION_ID,
            request_status: 'PENDING',
            request_version: 1,
            case_version: 2,
            idempotency_replayed: false,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            case_id: CASE_ID,
            case_status: 'CONTAINED',
            case_version: 3,
            request_status: 'APPROVED',
            request_version: 2,
            idempotency_replayed: false,
          },
        ],
        rowCount: 1,
      });

    await expect(
      requestUniversalV1OpsCaseTransition(context(), {
        caseId: CASE_ID,
        expectedCaseVersion: 2,
        transitionKind: 'CONTAIN',
        reason: 'Request evidence-only containment of the operational case.',
        evidenceDigest: DIGEST,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
    ).resolves.toMatchObject({
      transitionRequestId: TRANSITION_ID,
      status: 'PENDING',
      version: 1,
      caseVersion: 2,
    });
    await expect(
      decideUniversalV1OpsCaseTransition(context(APPROVER_ID), {
        transitionRequestId: TRANSITION_ID,
        expectedRequestVersion: 1,
        expectedCaseVersion: 2,
        decision: 'APPROVE',
        reason: 'Independently verified the exact case and containment evidence.',
        evidenceDigest: DIGEST,
        idempotencyKey: '77777777-7777-4777-8777-777777777777',
      })
    ).resolves.toMatchObject({
      status: 'CONTAINED',
      version: 3,
      requestStatus: 'APPROVED',
      requestVersion: 2,
    });
    expect(String(mocks.query.mock.calls[0][0])).toContain(
      'request_universal_v1_ops_case_transition_v1'
    );
    expect(String(mocks.query.mock.calls[1][0])).toContain(
      'decide_universal_v1_ops_case_transition_v1'
    );
  });

  it('maps database self-approval denial to a fail-closed authority error', async () => {
    mocks.query.mockRejectedValueOnce(
      new Error('HXUOC16: a transition requester cannot approve or reject their own request')
    );
    await expect(
      decideUniversalV1OpsCaseTransition(context(), {
        transitionRequestId: TRANSITION_ID,
        expectedRequestVersion: 1,
        expectedCaseVersion: 2,
        decision: 'APPROVE',
        reason: 'Attempt to approve the exact requested transition.',
        evidenceDigest: DIGEST,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('purpose-audits detail observation without lifecycle, money, or assignment SQL', async () => {
    const now = '2026-09-30T12:00:00.000Z';
    mocks.query
      .mockResolvedValueOnce({ rows: [{ assert_universal_v1_ops_case_operator_v1: 'support' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: CASE_ID,
            occurrence_id: OCCURRENCE_ID,
            occurrence_event_name: 'task.execution.failed',
            occurrence_version: 1,
            aggregate_kind: 'task_draft',
            aggregate_id: CASE_ID,
            aggregate_version: 7,
            category: 'FULFILLMENT',
            severity: 'HIGH',
            opening_reason: openInput.reason,
            opening_evidence_digest: DIGEST,
            status: 'OPEN',
            opened_at: now,
            acknowledged_at: null,
            contained_at: null,
            resolved_at: null,
            last_transition_at: now,
            version: 1,
            opened_by_display_name: 'Named Operator',
            acknowledged_by_display_name: null,
            contained_by_display_name: null,
            resolved_by_display_name: null,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(
      getUniversalV1OpsCase(context(), {
        caseId: CASE_ID,
        purpose: 'Review exact immutable evidence for operational response.',
      })
    ).resolves.toMatchObject({
      id: CASE_ID,
      status: 'OPEN',
      version: 1,
      operators: { openedBy: 'Named Operator' },
    });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    const sql = mocks.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('INSERT INTO public.universal_v1_ops_case_access_audit');
    expect(sql).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:tasks|task_drafts|task_work_orders|escrows|task_financial_operations)/i
    );
  });
});
