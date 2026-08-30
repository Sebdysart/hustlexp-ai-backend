import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../src/db', () => ({
  db: { transaction: mocks.transaction, query: mocks.query },
}));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import { webTaskDraftsRouter } from '../../src/routers/web/taskDrafts';
import {
  claimUniversalV1TaskDraft,
  UniversalV1TaskDraftClaimSchema,
  universalTaskDraftClaimRequestHash,
} from '../../src/services/UniversalV1TaskDraftClaim';
import { taskDraftCardTokenHash } from '../../src/services/UniversalV1TaskDraftIngress';
import type { User } from '../../src/types';

const NOW = Date.parse('2026-09-03T00:00:00.000Z');
const SUBMISSION = '11111111-2222-4333-8444-555555555555';
const DRAFT = '22222222-3333-4444-8555-666666666666';
const LEAD = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const USER = '33333333-4444-4555-8666-777777777777';
const OTHER_USER = '44444444-5555-4666-8777-888888888888';
const EVENT = '55555555-6666-4777-8888-999999999999';
const CORRELATION = '66666666-7777-4888-8999-000000000000';
const TOKEN = 'c0136ae07479454a856ad30e56e23ec89eafdcac3e16fd1b3205c5df6a9d08d9';

const COMPLETE_POSTER: User = {
  id: USER,
  email: 'claim@example.invalid',
  full_name: 'Claim Test',
  default_mode: 'poster',
  is_minor: false,
  role_was_overridden: false,
  trust_tier: 0,
  trust_hold: false,
  xp_total: 0,
  current_level: 1,
  current_streak: 0,
  is_verified: false,
  student_id_verified: false,
  plan: 'free',
  live_mode_state: 'OFF',
  live_mode_total_tasks: 0,
  daily_active_minutes: 0,
  consecutive_active_days: 0,
  account_status: 'ACTIVE',
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    submission_id: SUBMISSION,
    card_token: TOKEN,
    expected_version: 0 as const,
    idempotency_key: 'claim:device:0001',
    client_ts: NOW,
    ...overrides,
  };
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT,
    submission_id: SUBMISSION,
    card_token_hash: taskDraftCardTokenHash(TOKEN),
    status: 'contact_captured',
    lead_id: LEAD,
    poster_user_id: null,
    ingress_origin: 'BACKEND_POSTGRESQL',
    ...overrides,
  };
}

function event(requestHash: string, overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT,
    task_draft_id: DRAFT,
    actor_user_id: USER,
    event_version: 1,
    expected_version: 0,
    idempotency_key: 'claim:device:0001',
    request_sha256: requestHash,
    status_after: 'account_claimed',
    correlation_id: CORRELATION,
    ...overrides,
  };
}

function dependencies() {
  return {
    now: () => NOW,
    randomUuid: vi.fn()
      .mockReturnValueOnce(CORRELATION)
      .mockReturnValueOnce(EVENT),
    transaction: mocks.transaction,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (
    callback: (query: typeof mocks.query) => Promise<unknown>,
  ) => callback(mocks.query));
});

describe('Universal V1 canonical TaskDraft claim', () => {
  it('requires authenticated backend identity at the router boundary', async () => {
    const caller = webTaskDraftsRouter.createCaller({
      user: null,
      firebaseUid: null,
      ip: '203.0.113.12',
    });
    await expect(caller.claim(input())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('requires a completed adult Poster profile at the router boundary', async () => {
    for (const user of [
      { ...COMPLETE_POSTER, is_minor: true },
      { ...COMPLETE_POSTER, is_minor: undefined },
      { ...COMPLETE_POSTER, default_mode: 'worker' as const },
      { ...COMPLETE_POSTER, account_status: 'PAUSED' as const },
    ]) {
      const caller = webTaskDraftsRouter.createCaller({
        user,
        firebaseUid: 'firebase-claim-test',
        ip: '203.0.113.12',
      });
      await expect(caller.claim(input())).rejects.toMatchObject({
        code: expect.stringMatching(/^(?:FORBIDDEN|PRECONDITION_FAILED)$/u),
      });
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects unknown fields before opening a transaction', async () => {
    expect(UniversalV1TaskDraftClaimSchema.safeParse(input({ actor_user_id: USER })).success)
      .toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects a stale new command after locked replay lookup and before writes', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [draft()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(claimUniversalV1TaskDraft(
      input({ client_ts: NOW - 10 * 60 * 1_000 - 1 }),
      USER,
      dependencies(),
    )).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.query.mock.calls.map(([sql]) => String(sql)).join('\n'))
      .not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE)\b/imu);
  });

  it('records one immutable versioned claim and no task, assignment, or money write', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [draft()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: DRAFT }], rowCount: 1 });

    await expect(claimUniversalV1TaskDraft(input(), USER, dependencies()))
      .resolves.toMatchObject({
        ok: true,
        draft_id: DRAFT,
        status: 'account_claimed',
        claim_version: 1,
        claim_event_id: EVENT,
        replayed: false,
        payment_creation_frozen: true,
        hard_assignment_created: false,
      });

    const sql = mocks.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('INSERT INTO task_draft_account_claim_events');
    expect(sql).toContain("status = 'account_claimed'");
    expect(sql).not.toMatch(/INSERT INTO (?:tasks|work_orders|financial_|escrows|payments)/iu);
    expect(sql).not.toMatch(/UPDATE (?:tasks|work_orders|financial_|escrows|payments)/iu);
  });

  it('returns an exact idempotent replay without a second write', async () => {
    const request = input({ client_ts: NOW - 24 * 60 * 60 * 1_000 });
    const requestHash = universalTaskDraftClaimRequestHash(request, USER);
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [draft({ status: 'account_claimed', poster_user_id: USER })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [event(requestHash)], rowCount: 1 });

    await expect(claimUniversalV1TaskDraft(request, USER, dependencies()))
      .resolves.toMatchObject({
        replayed: true,
        claim_event_id: EVENT,
        correlation_id: CORRELATION,
      });
    expect(mocks.query).toHaveBeenCalledTimes(4);
  });

  it('rejects reuse of an idempotency key for a different command', async () => {
    const request = input();
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [draft({ status: 'account_claimed', poster_user_id: USER })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [event('0'.repeat(64))], rowCount: 1 });

    await expect(claimUniversalV1TaskDraft(request, USER, dependencies()))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('fails closed for an invalid capability, imported draft, or another owner', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [draft()], rowCount: 1 });
    await expect(claimUniversalV1TaskDraft(
      input({ card_token: 'd'.repeat(64) }),
      USER,
      dependencies(),
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });

    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [draft({ ingress_origin: 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC' })],
        rowCount: 1,
      });
    await expect(claimUniversalV1TaskDraft(input(), USER, dependencies()))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });

    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [draft({ status: 'account_claimed', poster_user_id: OTHER_USER })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(claimUniversalV1TaskDraft(input(), USER, dependencies()))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('recovers an already claimed draft after browser idempotency-key loss without writing', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [draft({ status: 'account_claimed', poster_user_id: USER })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [event('f'.repeat(64), { idempotency_key: 'claim:device:original' })],
        rowCount: 1,
      });

    await expect(claimUniversalV1TaskDraft(
      input({ idempotency_key: 'claim:device:replacement' }),
      USER,
      dependencies(),
    )).resolves.toMatchObject({
      replayed: true,
      claim_event_id: EVENT,
      correlation_id: CORRELATION,
    });
    expect(mocks.query).toHaveBeenCalledTimes(5);
    expect(mocks.query.mock.calls.map(([sql]) => String(sql)).join('\n'))
      .not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE)\b/imu);
  });
});

describe('TaskDraft claim migration contract', () => {
  const sql = readFileSync(resolve(
    __dirname,
    '../../database/migrations/20260903_universal_v1_task_draft_account_claim.sql',
  ), 'utf8');
  const repairSql = readFileSync(resolve(
    __dirname,
    '../../database/migrations/20260905_universal_v1_task_draft_legacy_claim_import_repair.sql',
  ), 'utf8');

  it('is the exact account-claim segment after the public TaskDraft port', () => {
    const claimIndex = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260903_universal_v1_task_draft_account_claim',
    );

    expect(REQUIRED_MIGRATION_FILES).toHaveLength(128);
    expect(claimIndex).toBeGreaterThan(0);
    expect(REQUIRED_MIGRATION_FILES.slice(claimIndex - 1)).toEqual([
      {
        name: '20260902_universal_v1_task_draft_public_port',
        fileName: '20260902_universal_v1_task_draft_public_port.sql',
      },
      {
        name: '20260903_universal_v1_task_draft_account_claim',
        fileName: '20260903_universal_v1_task_draft_account_claim.sql',
      },
      {
        name: '20260904_canonical_user_email_identity',
        fileName: '20260904_canonical_user_email_identity.sql',
      },
      {
        name: '20260905_universal_v1_task_draft_legacy_claim_import_repair',
        fileName: '20260905_universal_v1_task_draft_legacy_claim_import_repair.sql',
      },
      {
        name: '20260906_universal_v1_estimate_acceptance_materialization',
        fileName: '20260906_universal_v1_estimate_acceptance_materialization.sql',
      },
      {
        name: '20260907_universal_v1_provider_estimate_invitation',
        fileName: '20260907_universal_v1_provider_estimate_invitation.sql',
      },
      {
        name: '20260908_universal_v1_provider_work_order_authority',
        fileName: '20260908_universal_v1_provider_work_order_authority.sql',
      },
      {
        name: '20260909_universal_v1_reconciliation_alias_repair',
        fileName: '20260909_universal_v1_reconciliation_alias_repair.sql',
      },
      {
        name: '20260911_universal_v1_change_order_application',
        fileName: '20260911_universal_v1_change_order_application.sql',
      },
      {
        name: '20260912_universal_v1_work_order_execution_facts',
        fileName: '20260912_universal_v1_work_order_execution_facts.sql',
      },
      {
        name: '20260913_universal_v1_completion_delivery_receipt',
        fileName: '20260913_universal_v1_completion_delivery_receipt.sql',
      },
      {
        name: '20260914_notification_provider_in_flight',
        fileName: '20260914_notification_provider_in_flight.sql',
      },
      {
        name: '20260915_ai_spend_attempt_ledger',
        fileName: '20260915_ai_spend_attempt_ledger.sql',
      },
      {
        name: '20260916_provider_event_inbox_v1',
        fileName: '20260916_provider_event_inbox_v1.sql',
      },
      {
        name: '20260917_financial_provider_command_journal_v1',
        fileName: '20260917_financial_provider_command_journal_v1.sql',
      },
      {
        name: '20260918_universal_v1_prepared_financial_command_v1',
        fileName: '20260918_universal_v1_prepared_financial_command_v1.sql',
      },
      {
        name: '20260919_provider_event_processing_v1',
        fileName: '20260919_provider_event_processing_v1.sql',
      },
      {
        name: '20260920_financial_provider_command_recovery_v1',
        fileName: '20260920_financial_provider_command_recovery_v1.sql',
      },
    ]);
  });

  it('makes claim evidence append-only and binds aggregate transition both ways', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.task_draft_account_claim_events');
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS public.task_draft_precontract_claim_observations',
    );
    expect(sql).toContain('PRECONTRACT_UNVERIFIED_NO_CANONICAL_EVENT');
    expect(sql).toContain(
      'canonical precontract claim-like state requires reviewed adoption evidence',
    );
    expect(sql).toContain('UNIQUE (task_draft_id)');
    expect(sql).toContain('task_draft_account_claim_events_immutable');
    expect(sql).toContain('task_draft_account_claim_events_no_truncate');
    expect(sql).toContain('task_draft_account_claim_transition_guard');
    expect(sql).toContain('task_draft_account_claim_event_state_guard');
    expect(sql).toContain('task_draft_account_claim_presence_guard');
    expect(sql).toContain('BEFORE INSERT OR UPDATE ON public.task_drafts');
    expect(sql).toMatch(
      /CREATE CONSTRAINT TRIGGER task_draft_account_claim_presence_guard[\s\S]*?DEFERRABLE INITIALLY DEFERRED/u,
    );
    expect(sql).toContain("OLD.ingress_origin <> 'BACKEND_POSTGRESQL'");
    expect(sql).toContain('REVOKE ALL ON TABLE public.task_draft_account_claim_events FROM PUBLIC');
  });

  it('does not grant assignment or financial authority', () => {
    const consequentialTable = /(?:tasks|task_work_orders|task_financial_operations|task_financial_security_events|escrows|payments|stripe_events|hxos_fake_financial_)/iu;
    expect(sql).not.toMatch(new RegExp(`INSERT INTO ${consequentialTable.source}`, 'iu'));
    expect(sql).not.toMatch(new RegExp(`UPDATE ${consequentialTable.source}`, 'iu'));
    expect(sql).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE)/iu);
  });

  it('repairs only receipt-backed legacy claim imports and closes noncanonical insert gaps', () => {
    expect(repairSql).toContain(
      "NEW.ingress_origin = 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC'",
    );
    expect(repairSql).toContain('20260902 deferred receipt guard proves the exact receipt');
    expect(repairSql).toContain('OR NEW.poster_user_id IS NOT NULL');
    expect(repairSql).toContain('record_legacy_task_draft_claim_observation');
    expect(repairSql).toContain('CREATE TRIGGER task_draft_legacy_claim_observation');
    expect(repairSql).toContain('AFTER INSERT ON public.task_drafts');
    expect(repairSql).toContain('ON CONFLICT (task_draft_id) DO NOTHING');
    expect(repairSql).toContain('HXUV1-TD-CLAIM-6');
    expect(repairSql).toContain('HXUV1-TD-CLAIM-7');
    expect(repairSql).toContain('provider "claim" is only EXPRESS_INTEREST');
    expect(repairSql).not.toMatch(
      /INSERT INTO public\.task_draft_account_claim_events/iu,
    );
    const consequentialTable = [
      'task_applications',
      'task_reservations',
      'task_provider_eligibility_decisions',
      'task_location_access_log',
      'task_financial_operations',
      'task_financial_security_events',
      'task_work_orders',
      'task_reconciliation_facts',
      'tasks',
      'escrows',
      'quote_payments',
      'stripe_events',
    ].join('|');
    expect(repairSql).not.toMatch(new RegExp(
      `(?:INSERT\\s+INTO|UPDATE)\\s+(?:public\\.)?(?:${consequentialTable})\\b`,
      'iu',
    ));
    expect(repairSql).not.toMatch(/\b(?:DELETE|TRUNCATE)\b/iu);
    expect(repairSql).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE)/iu);
  });
});
