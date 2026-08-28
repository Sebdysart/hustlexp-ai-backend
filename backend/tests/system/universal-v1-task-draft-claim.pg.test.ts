import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryFn } from '../../src/db.js';
import {
  submitUniversalV1TaskDraft,
  type TaskDraftIngressDependencies,
  type TaskDraftIngressInput,
} from '../../src/routers/web/taskDrafts.js';
import {
  claimUniversalV1TaskDraft,
  UniversalV1TaskDraftClaimSchema,
  type UniversalV1TaskDraftClaimDependencies,
  type UniversalV1TaskDraftClaimInput,
} from '../../src/services/UniversalV1TaskDraftClaim.js';
import { taskDraftCardTokenHash } from '../../src/services/UniversalV1TaskDraftIngress.js';

const enabled = process.env.HX_ALLOW_TASK_DRAFT_INGRESS_PG === '1';
const describePg = enabled ? describe : describe.skip;
const databaseUrl = process.env.LOCAL_TEST_DB_URL ?? '';
const now = 1_800_000_000_000;

function assertDisposableDatabase(value: string): void {
  const parsed = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || parsed.hostname !== '127.0.0.1'
    || parsed.port !== '5432'
    || parsed.username !== 'hx_ci_runner'
    || parsed.pathname !== '/hx_ci_system_test'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('TaskDraft claim proof may run only on the exact disposable system database');
  }
}

describePg('Universal V1 TaskDraft account-claim PostgreSQL authority', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    await pool.query('SELECT 1');
  });

  afterAll(async () => {
    await pool.end();
  });

  const transaction: UniversalV1TaskDraftClaimDependencies['transaction'] = async (callback) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const query: QueryFn = async <Row = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) => {
        const result = await client.query(sql, params);
        return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
      };
      const value = await callback(query);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  const ingressDependencies: Partial<TaskDraftIngressDependencies> = {
    env: {
      NODE_ENV: 'test',
      HX_ENVIRONMENT: 'test',
      HX_HUMAN_VERIFICATION_MODE: 'synthetic',
      HX_HUMAN_VERIFICATION_URL: 'http://127.0.0.1:8080/v1/human-verification/verify',
      HX_HUMAN_VERIFICATION_SECRET: 'required-test-human-verification-secret-v1',
      PUBLIC_INGRESS_IP_HASH_SALT: 'required-test-task-draft-ip-salt-v1',
      TASK_DRAFT_RATE_LIMIT_PER_IP_HOUR: '1000',
      ALLOWED_ORIGINS: 'http://localhost:5173',
    },
    fetch: async () => new Response(JSON.stringify({
      success: true,
      action: 'task',
      hostname: 'synthetic.invalid',
      metadata: { result_with_testing_key: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    now: () => now,
    randomUuid: randomUUID,
    transaction,
  };

  async function contactCapturedFixture() {
    const submissionId = randomUUID();
    const cardToken = randomBytes(32).toString('hex');
    const create: TaskDraftIngressInput = {
      action: 'create',
      submission_id: submissionId,
      expected_version: 0,
      card_token: cardToken,
      raw_input: 'Assemble a sealed-box dresser with ordinary hand tools',
      category: 'furniture_assembly',
      answers: {
        item: 'Dresser',
        new_in_box: true,
        timing: 'Flexible weekday afternoon',
        scope_confirmed_at: new Date(now).toISOString(),
      },
      zip: '98052',
      region: 'Eastside',
      photo_count: 0,
      consent_version: 'v1',
      turnstile_token: `synthetic-task-${randomUUID()}`,
      client_ts: now,
    };
    const created = await submitUniversalV1TaskDraft(
      create,
      { ip: '203.0.113.57' },
      ingressDependencies,
    );
    if (!created.ok) throw new Error('synthetic TaskDraft was rejected');

    const leadSubmissionId = randomUUID();
    await pool.query(
      `INSERT INTO leads(submission_id, lead_type, email, name, answers, source)
       VALUES ($1, 'poster', $2, 'Claim Test',
               jsonb_build_object('task_draft_submission_id', $3::text),
               'required_test')`,
      [leadSubmissionId, `${leadSubmissionId}@example.invalid`, submissionId],
    );
    const linked = await submitUniversalV1TaskDraft({
      ...create,
      action: 'link_contact',
      expected_version: created.version,
      raw_input: 'contact link',
      lead_submission_id: leadSubmissionId,
      turnstile_token: undefined,
    }, { ip: '203.0.113.57' }, ingressDependencies);
    if (!linked.ok) throw new Error('synthetic TaskDraft contact link was rejected');
    return { submissionId, cardToken, draftId: linked.draft_id };
  }

  async function userFixture(): Promise<string> {
    const actorUserId = randomUUID();
    await pool.query(
      `INSERT INTO users(
         id, firebase_uid, email, full_name, default_mode, date_of_birth, is_minor
       ) VALUES ($1, $2, $3, 'Claim Test', 'poster', DATE '1990-01-01', false)`,
      [actorUserId, `firebase-${actorUserId}`, `${actorUserId}@example.invalid`],
    );
    return actorUserId;
  }

  function claimDependencies(
    serverNow = now,
  ): Partial<UniversalV1TaskDraftClaimDependencies> {
    return {
      now: () => serverNow,
      randomUuid: randomUUID,
      transaction,
    };
  }

  async function consequentialStateSnapshot() {
    const result = await pool.query<{
      express_interests: number;
      reservations: number;
      payment_eligibility_decisions: number;
      private_data_releases: number;
      financial_operations: number;
      financial_security_events: number;
      work_orders: number;
      reconciliation_facts: number;
      tasks: number;
      escrows: number;
      quote_payments: number;
      stripe_events: number;
    }>(`
      SELECT
        (SELECT COUNT(*)::integer FROM task_applications) AS express_interests,
        (SELECT COUNT(*)::integer FROM task_reservations) AS reservations,
        (SELECT COUNT(*)::integer FROM task_provider_eligibility_decisions)
          AS payment_eligibility_decisions,
        (SELECT COUNT(*)::integer FROM task_location_access_log) AS private_data_releases,
        (SELECT COUNT(*)::integer FROM task_financial_operations) AS financial_operations,
        (SELECT COUNT(*)::integer FROM task_financial_security_events)
          AS financial_security_events,
        (SELECT COUNT(*)::integer FROM task_work_orders) AS work_orders,
        (SELECT COUNT(*)::integer FROM task_reconciliation_facts) AS reconciliation_facts,
        (SELECT COUNT(*)::integer FROM tasks) AS tasks,
        (SELECT COUNT(*)::integer FROM escrows) AS escrows,
        (SELECT COUNT(*)::integer FROM quote_payments) AS quote_payments,
        (SELECT COUNT(*)::integer FROM stripe_events) AS stripe_events
    `);
    return result.rows[0];
  }

  it('serializes concurrent exact claims into one event and no money or assignment state', async () => {
    const fixture = await contactCapturedFixture();
    const actorUserId = await userFixture();
    const command: UniversalV1TaskDraftClaimInput = {
      submission_id: fixture.submissionId,
      card_token: fixture.cardToken,
      expected_version: 0,
      idempotency_key: `claim:${fixture.submissionId}`,
      client_ts: now,
    };
    const dependencies = claimDependencies();

    const results = await Promise.all(Array.from({ length: 8 }, () =>
      claimUniversalV1TaskDraft(command, actorUserId, dependencies)));
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(7);
    expect(new Set(results.map((result) => result.claim_event_id)).size).toBe(1);
    expect(new Set(results.map((result) => result.correlation_id)).size).toBe(1);

    const exactLateReplay = await claimUniversalV1TaskDraft(
      command,
      actorUserId,
      claimDependencies(now + 24 * 60 * 60 * 1_000),
    );
    expect(exactLateReplay).toMatchObject({
      replayed: true,
      claim_event_id: results[0]?.claim_event_id,
      correlation_id: results[0]?.correlation_id,
    });
    await expect(claimUniversalV1TaskDraft({
      ...command,
      client_ts: command.client_ts + 1,
    }, actorUserId, dependencies)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(claimUniversalV1TaskDraft({
      ...command,
      idempotency_key: `claim:replacement:${fixture.submissionId}`,
    }, actorUserId, dependencies)).resolves.toMatchObject({
      replayed: true,
      claim_event_id: results[0]?.claim_event_id,
      correlation_id: results[0]?.correlation_id,
    });

    const authority = await pool.query<{
      status: string;
      poster_user_id: string;
      claimed_at: Date;
      claim_events: number;
      operations: number;
      financial_events: number;
      work_orders: number;
      tasks: number;
    }>(
      `SELECT draft.status, draft.poster_user_id, draft.claimed_at,
              (SELECT COUNT(*)::integer FROM task_draft_account_claim_events event
                WHERE event.task_draft_id = draft.id) AS claim_events,
              (SELECT COUNT(*)::integer FROM task_financial_operations operation
                WHERE operation.task_draft_id = draft.id) AS operations,
              (SELECT COUNT(*)::integer FROM task_financial_security_events event
                WHERE event.task_draft_id = draft.id) AS financial_events,
              (SELECT COUNT(*)::integer FROM task_work_orders work_order
                WHERE work_order.task_draft_id = draft.id) AS work_orders,
              (SELECT COUNT(*)::integer FROM tasks task
                WHERE task.id = draft.task_id) AS tasks
         FROM task_drafts draft
        WHERE draft.id = $1`,
      [fixture.draftId],
    );
    expect(authority.rows[0]).toMatchObject({
      status: 'account_claimed',
      poster_user_id: actorUserId,
      claim_events: 1,
      operations: 0,
      financial_events: 0,
      work_orders: 0,
      tasks: 0,
    });
    expect(authority.rows[0]?.claimed_at).toBeInstanceOf(Date);
  });

  it('rejects an invalid capability without a claim event or aggregate mutation', async () => {
    const fixture = await contactCapturedFixture();
    const actorUserId = await userFixture();
    await expect(claimUniversalV1TaskDraft({
      submission_id: fixture.submissionId,
      card_token: randomBytes(32).toString('hex'),
      expected_version: 0,
      idempotency_key: `claim:${fixture.submissionId}`,
      client_ts: now,
    }, actorUserId, claimDependencies()))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });

    const result = await pool.query<{ status: string; poster_user_id: string | null; events: number }>(
      `SELECT draft.status, draft.poster_user_id,
              (SELECT COUNT(*)::integer FROM task_draft_account_claim_events event
                WHERE event.task_draft_id = draft.id) AS events
         FROM task_drafts draft
        WHERE draft.id = $1`,
      [fixture.draftId],
    );
    expect(result.rows[0]).toEqual({
      status: 'contact_captured',
      poster_user_id: null,
      events: 0,
    });
  });

  it('rejects raw aggregate claims and preserves append-only event evidence', async () => {
    const fixture = await contactCapturedFixture();
    const actorUserId = await userFixture();

    await expect(pool.query(
      `UPDATE task_drafts
          SET poster_user_id = $2,
              claimed_at = clock_timestamp(),
              status = 'account_claimed'
        WHERE id = $1`,
      [fixture.draftId, actorUserId],
    )).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('requires exact canonical event evidence'),
    });

    await expect(pool.query(
      `INSERT INTO task_drafts(
         id, submission_id, card_token_hash, category, raw_input,
         status, poster_user_id, claimed_at
       ) VALUES ($1, $2, $3, 'other', 'Raw claimed insert',
                 'account_claimed', $4, clock_timestamp())`,
      [randomUUID(), randomUUID(), randomBytes(32).toString('hex'), actorUserId],
    )).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('requires exact canonical event evidence'),
    });

    const claimed = await claimUniversalV1TaskDraft({
      submission_id: fixture.submissionId,
      card_token: fixture.cardToken,
      expected_version: 0,
      idempotency_key: `claim:immutable:${fixture.submissionId}`,
      client_ts: now,
    }, actorUserId, claimDependencies());
    const otherActor = await userFixture();

    for (const [sql, params] of [
      [
        'UPDATE task_drafts SET poster_user_id = $2 WHERE id = $1',
        [fixture.draftId, otherActor],
      ],
      [
        'UPDATE task_drafts SET claimed_at = NULL WHERE id = $1',
        [fixture.draftId],
      ],
      [
        "UPDATE task_drafts SET status = 'contact_captured' WHERE id = $1",
        [fixture.draftId],
      ],
    ] as const) {
      await expect(pool.query(sql, [...params])).rejects.toMatchObject({ code: 'P0001' });
    }

    await expect(pool.query(
      'UPDATE task_draft_account_claim_events SET request_sha256 = $2 WHERE id = $1',
      [claimed.claim_event_id, '0'.repeat(64)],
    )).rejects.toMatchObject({ code: 'P0001' });
    await expect(pool.query(
      'DELETE FROM task_draft_account_claim_events WHERE id = $1',
      [claimed.claim_event_id],
    )).rejects.toMatchObject({ code: 'P0001' });
    await expect(pool.query('TRUNCATE task_draft_account_claim_events'))
      .rejects.toMatchObject({ code: 'P0001' });

    const preserved = await pool.query<{
      status: string;
      poster_user_id: string;
      events: number;
    }>(
      `SELECT draft.status, draft.poster_user_id,
              (SELECT COUNT(*)::integer FROM task_draft_account_claim_events event
                WHERE event.task_draft_id = draft.id) AS events
         FROM task_drafts draft
        WHERE draft.id = $1`,
      [fixture.draftId],
    );
    expect(preserved.rows[0]).toEqual({
      status: 'account_claimed',
      poster_user_id: actorUserId,
      events: 1,
    });
  });

  it('serializes cross-draft idempotency and cross-actor ownership races', async () => {
    const first = await contactCapturedFixture();
    const second = await contactCapturedFixture();
    const actor = await userFixture();
    const sharedKey = `claim:shared:${randomUUID()}`;
    const crossDraft = await Promise.allSettled([
      claimUniversalV1TaskDraft({
        submission_id: first.submissionId,
        card_token: first.cardToken,
        expected_version: 0,
        idempotency_key: sharedKey,
        client_ts: now,
      }, actor, claimDependencies()),
      claimUniversalV1TaskDraft({
        submission_id: second.submissionId,
        card_token: second.cardToken,
        expected_version: 0,
        idempotency_key: sharedKey,
        client_ts: now,
      }, actor, claimDependencies()),
    ]);
    expect(crossDraft.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const crossDraftFailure = crossDraft.find((result) => result.status === 'rejected');
    expect(crossDraftFailure).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'CONFLICT' }),
    });

    const third = await contactCapturedFixture();
    const firstActor = await userFixture();
    const secondActor = await userFixture();
    const crossActor = await Promise.allSettled([
      claimUniversalV1TaskDraft({
        submission_id: third.submissionId,
        card_token: third.cardToken,
        expected_version: 0,
        idempotency_key: `claim:actor-a:${third.submissionId}`,
        client_ts: now,
      }, firstActor, claimDependencies()),
      claimUniversalV1TaskDraft({
        submission_id: third.submissionId,
        card_token: third.cardToken,
        expected_version: 0,
        idempotency_key: `claim:actor-b:${third.submissionId}`,
        client_ts: now,
      }, secondActor, claimDependencies()),
    ]);
    expect(crossActor.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(crossActor.find((result) => result.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'FORBIDDEN' }),
    });

    const raceEvidence = await pool.query<{
      total_events: number;
      claimed_drafts: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::integer
            FROM task_draft_account_claim_events event
           WHERE event.task_draft_id = ANY($1::uuid[])) AS total_events,
         (SELECT COUNT(*)::integer
            FROM task_drafts draft
           WHERE draft.id = ANY($1::uuid[])
             AND draft.status = 'account_claimed') AS claimed_drafts`,
      [[first.draftId, second.draftId, third.draftId]],
    );
    expect(raceEvidence.rows[0]).toEqual({ total_events: 2, claimed_drafts: 2 });
  });

  it('preserves a post-contract claimed legacy import as observation-only and nonclaimable', async () => {
    const consequentialBefore = await consequentialStateSnapshot();
    const actorUserId = await userFixture();
    const preparerId = await userFixture();
    const reviewerId = await userFixture();
    const legacyPosterAuthUserId = randomUUID();
    const batchId = randomUUID();
    const draftId = randomUUID();
    const submissionId = randomUUID();
    const receiptId = randomUUID();
    const sourceManifestHash = randomBytes(32).toString('hex');
    const sourceRowHash = randomBytes(32).toString('hex');
    const targetRowHash = randomBytes(32).toString('hex');
    const legacyRawToken = randomBytes(32).toString('hex');
    const legacyTokenHash = taskDraftCardTokenHash(legacyRawToken);
    const legacyClaimedAt = new Date(now - 60_000);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO task_draft_legacy_import_batches(
           id, source_system, source_environment, source_manifest_sha256,
           source_row_count, rate_continuity_mode, prepared_by, reviewed_by,
           prepared_at, reviewed_at
         ) VALUES (
           $1, 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC', $2, $3,
           1, 'FAIL_CLOSED', $4, $5, clock_timestamp(), clock_timestamp()
         )`,
        [batchId, `system-test-${batchId}`, sourceManifestHash, preparerId, reviewerId],
      );
      await client.query(
        `INSERT INTO task_drafts(
           id, submission_id, card_token_hash, category, raw_input, structured,
           status, source, utm, claimed_at, universal_contract_version,
           ingress_contract_version, ingress_origin, card_token_contract_version,
           legacy_poster_auth_user_id, legacy_import_batch_id,
           legacy_source_row_sha256, legacy_import_disposition
         ) VALUES (
           $1, $2, $3, 'other', 'Post-contract claimed legacy import', '{}'::jsonb,
           'account_claimed', 'legacy_supabase_task_draft_public', '{}'::jsonb,
           $4, 0, 0, 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC', 0,
           $5, $6, $7, 'IMPORTED_READ_ONLY'
         )`,
        [
          draftId,
          submissionId,
          legacyTokenHash,
          legacyClaimedAt,
          legacyPosterAuthUserId,
          batchId,
          sourceRowHash,
        ],
      );
      await client.query(
        `INSERT INTO task_draft_legacy_import_receipts(
           id, import_batch_id, source_row_sha256, target_row_sha256,
           source_submission_id, source_card_token_hash, target_card_token_hash,
           legacy_poster_auth_user_id, target_task_draft_id,
           import_disposition, lead_disposition, token_disposition,
           route_disposition, reason_codes, recorded_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $6, $7, $8,
           'IMPORTED_READ_ONLY', 'UNRESOLVED', 'HASH_ONLY_READ_ONLY',
           'NO_SYNTHETIC_ROUTE', ARRAY['POSTCONTRACT_CLAIM_IMPORT_TEST'], $9
         )`,
        [
          receiptId,
          batchId,
          sourceRowHash,
          targetRowHash,
          submissionId,
          legacyTokenHash,
          legacyPosterAuthUserId,
          draftId,
          reviewerId,
        ],
      );
      await client.query(
        'SET CONSTRAINTS task_draft_legacy_import_receipt_presence_guard IMMEDIATE',
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    expect(UniversalV1TaskDraftClaimSchema.safeParse({
      submission_id: submissionId,
      card_token: randomBytes(12).toString('hex'),
      expected_version: 0,
      idempotency_key: `claim:legacy-short:${submissionId}`,
      client_ts: now,
    }).success).toBe(false);

    await expect(claimUniversalV1TaskDraft({
      submission_id: submissionId,
      card_token: legacyRawToken,
      expected_version: 0,
      idempotency_key: `claim:legacy-origin:${submissionId}`,
      client_ts: now,
    }, actorUserId, claimDependencies())).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(pool.query(
      `UPDATE task_drafts SET raw_input = 'Attempted post-contract legacy mutation'
       WHERE id = $1`,
      [draftId],
    )).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('read-only pending an explicit adoption contract'),
    });

    const preserved = await pool.query<{
      status: string;
      poster_user_id: string | null;
      legacy_poster_auth_user_id: string;
      claimed_at: Date;
      observation_status: string;
      observation_poster_user_id: string | null;
      observation_claimed_at: Date;
      observation_classification: string;
      canonical_events: number;
      inferred_users: number;
      eligibility_decisions: number;
      financial_operations: number;
      financial_security_events: number;
      work_orders: number;
      routing_decisions: number;
    }>(
      `SELECT draft.status, draft.poster_user_id,
              draft.legacy_poster_auth_user_id, draft.claimed_at,
              observation.observed_status AS observation_status,
              observation.observed_poster_user_id AS observation_poster_user_id,
              observation.observed_claimed_at AS observation_claimed_at,
              observation.classification AS observation_classification,
              (SELECT COUNT(*)::integer
                 FROM task_draft_account_claim_events event
                WHERE event.task_draft_id = draft.id) AS canonical_events,
              (SELECT COUNT(*)::integer FROM users
                WHERE id = draft.legacy_poster_auth_user_id) AS inferred_users,
              (SELECT COUNT(*)::integer
                 FROM task_provider_eligibility_decisions eligibility
                WHERE eligibility.task_draft_id = draft.id) AS eligibility_decisions,
              (SELECT COUNT(*)::integer
                 FROM task_financial_operations operation
                WHERE operation.task_draft_id = draft.id) AS financial_operations,
              (SELECT COUNT(*)::integer
                 FROM task_financial_security_events event
                WHERE event.task_draft_id = draft.id) AS financial_security_events,
              (SELECT COUNT(*)::integer
                 FROM task_work_orders work_order
                WHERE work_order.task_draft_id = draft.id) AS work_orders,
              (SELECT COUNT(*)::integer
                 FROM task_routing_decisions route
                WHERE route.task_draft_id = draft.id) AS routing_decisions
         FROM task_drafts draft
         JOIN task_draft_precontract_claim_observations observation
           ON observation.task_draft_id = draft.id
        WHERE draft.id = $1`,
      [draftId],
    );
    expect(preserved.rows[0]).toMatchObject({
      status: 'account_claimed',
      poster_user_id: null,
      legacy_poster_auth_user_id: legacyPosterAuthUserId,
      observation_status: 'account_claimed',
      observation_poster_user_id: null,
      observation_classification: 'PRECONTRACT_UNVERIFIED_NO_CANONICAL_EVENT',
      canonical_events: 0,
      inferred_users: 0,
      eligibility_decisions: 0,
      financial_operations: 0,
      financial_security_events: 0,
      work_orders: 0,
      routing_decisions: 0,
    });
    expect(preserved.rows[0]?.claimed_at).toEqual(legacyClaimedAt);
    expect(preserved.rows[0]?.observation_claimed_at).toEqual(legacyClaimedAt);
    expect(await consequentialStateSnapshot()).toEqual(consequentialBefore);
  });

  it('enforces canonical email identity for every database writer', async () => {
    const firstUserId = randomUUID();
    const secondUserId = randomUUID();
    const email = `canonical-${randomUUID()}@example.invalid`;
    await pool.query(
      `INSERT INTO users(id, firebase_uid, email, full_name, default_mode)
       VALUES ($1, $2, $3, 'Canonical Email A', 'poster')`,
      [firstUserId, `firebase-${firstUserId}`, email],
    );
    await expect(pool.query(
      `INSERT INTO users(id, firebase_uid, email, full_name, default_mode)
       VALUES ($1, $2, $3, 'Canonical Email B', 'poster')`,
      [secondUserId, `firebase-${secondUserId}`, email.toUpperCase()],
    )).rejects.toMatchObject({ code: '23505' });
  });
});
