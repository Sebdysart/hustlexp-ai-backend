import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/db', () => ({ db: { query: mocks.query } }));

import {
  openUniversalV1Dispute,
  proposeUniversalV1Recovery,
  recordUniversalV1RecoveryApproval,
} from '../../src/services/UniversalV1DisputeRecoveryService.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222';
const DISPUTE_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '44444444-4444-4444-8444-444444444444';
const WORK_ORDER_ID = '55555555-5555-4555-8555-555555555555';
const COMPLETION_ID = '66666666-6666-4666-8666-666666666666';
const RECOVERY_ID = '77777777-7777-4777-8777-777777777777';
const DIGEST = 'a'.repeat(64);

function context(userId: string, steppedUp = false) {
  const now = Math.floor(Date.now() / 1000);
  return {
    user: {
      id: userId,
      full_name: 'Named actor',
      email: 'actor@example.test',
      is_admin: userId === OPERATOR_ID,
      is_banned: false,
      is_minor: false,
      account_status: 'ACTIVE',
      default_mode: 'poster',
    },
    firebaseUid: `firebase-${userId}`,
    identityAssurance: steppedUp ? {
      authenticatedAtSeconds: now - 30,
      tokenExpiresAtSeconds: now + 3_600,
      signInProvider: 'password',
      secondFactor: 'phone',
      mfaVerified: true,
    } : undefined,
    ip: '127.0.0.1',
  } as any;
}

beforeEach(() => vi.clearAllMocks());

describe('UniversalV1DisputeRecoveryService', () => {
  it.each([
    ['paused', { account_status: 'PAUSED' }],
    ['minor', { is_minor: true }],
    ['unknown adult', { is_minor: undefined }],
  ])('rejects a %s participant before database access', async (_label, override) => {
    const inactive = context(CUSTOMER_ID);
    Object.assign(inactive.user, override);
    await expect(openUniversalV1Dispute(inactive, {
      taskId: TASK_ID,
      expectedTaskVersion: 9,
      workOrderId: WORK_ORDER_ID,
      expectedWorkOrderVersion: 1,
      completionFactId: COMPLETION_ID,
      expectedCompletionVersion: 1,
      expectedExecutionVersion: 7,
      incidentKind: 'QUALITY',
      evidenceDigest: DIGEST,
      idempotencyKey: 'dispute-open-unit-inactive-1',
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('opens through one exact database command and never issues application-side writes', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{
        dispute_id: DISPUTE_ID,
        dispute_state: 'OPEN',
        dispute_version: '1',
        idempotency_replayed: false,
      }],
      rowCount: 1,
    });
    await expect(openUniversalV1Dispute(context(CUSTOMER_ID), {
      taskId: TASK_ID,
      expectedTaskVersion: 9,
      workOrderId: WORK_ORDER_ID,
      expectedWorkOrderVersion: 1,
      completionFactId: COMPLETION_ID,
      expectedCompletionVersion: 1,
      expectedExecutionVersion: 7,
      incidentKind: 'QUALITY',
      evidenceDigest: DIGEST,
      idempotencyKey: 'dispute-open-unit-0001',
    })).resolves.toMatchObject({
      disputeId: DISPUTE_ID,
      state: 'OPEN',
      version: 1,
      actorAuthority: {
        databaseCallerIdentityAttested: false,
        providerOrMoneyEffects: 'NONE',
      },
    });
    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain('open_universal_v1_dispute_v1');
    expect(String(sql)).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/iu);
    expect(params).toEqual([
      TASK_ID, 9, WORK_ORDER_ID, 1, COMPLETION_ID, 1, 7,
      'QUALITY', DIGEST, CUSTOMER_ID, 'dispute-open-unit-0001',
    ]);
  });

  it('requires fresh named operator MFA before proposal database access', async () => {
    await expect(proposeUniversalV1Recovery(context(OPERATOR_ID), {
      disputeId: DISPUTE_ID,
      expectedDisputeVersion: 2,
      recoveryKind: 'REWORK',
      evidenceDigest: DIGEST,
      idempotencyKey: 'dispute-proposal-unit-1',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('returns recovery and independent approval as held no-effect facts', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{
          recovery_intent_id: RECOVERY_ID,
          dispute_state: 'RESOLUTION_PROPOSED',
          dispute_version: 3,
          authority_state: 'HELD_TWO_PERSON_DATABASE_CALLER_UNATTESTED',
          idempotency_replayed: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          approval_fact_id: '88888888-8888-4888-8888-888888888888',
          dispute_state: 'RESOLUTION_PROPOSED',
          dispute_version: 4,
          authority_state: 'HELD_TWO_PERSON_DATABASE_CALLER_UNATTESTED',
          idempotency_replayed: false,
        }],
      });
    await expect(proposeUniversalV1Recovery(context(OPERATOR_ID, true), {
      disputeId: DISPUTE_ID,
      expectedDisputeVersion: 2,
      recoveryKind: 'REFUND',
      evidenceDigest: DIGEST,
      idempotencyKey: 'dispute-proposal-unit-2',
    })).resolves.toMatchObject({
      recoveryIntentId: RECOVERY_ID,
      authorityState: 'HELD_TWO_PERSON_DATABASE_CALLER_UNATTESTED',
      effectCreated: false,
    });
    await expect(recordUniversalV1RecoveryApproval(context(OPERATOR_ID, true), {
      recoveryIntentId: RECOVERY_ID,
      expectedDisputeVersion: 3,
      evidenceDigest: DIGEST,
      idempotencyKey: 'dispute-approval-unit-2',
    })).resolves.toMatchObject({
      state: 'RESOLUTION_PROPOSED',
      terminalTransitionCreated: false,
      effectCreated: false,
    });
  });

  it('maps exact-version conflicts without exposing raw database details', async () => {
    mocks.query.mockRejectedValueOnce(
      new Error('HXUDR3: dispute expected version changed secret-row=customer-address'),
    );
    await expect(openUniversalV1Dispute(context(CUSTOMER_ID), {
      taskId: TASK_ID,
      expectedTaskVersion: 9,
      workOrderId: WORK_ORDER_ID,
      expectedWorkOrderVersion: 1,
      completionFactId: COMPLETION_ID,
      expectedCompletionVersion: 1,
      expectedExecutionVersion: 7,
      incidentKind: 'QUALITY',
      evidenceDigest: DIGEST,
      idempotencyKey: 'dispute-open-unit-0002',
    })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The dispute or its exact authority version changed.',
    });
  });
});
