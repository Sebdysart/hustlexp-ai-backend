import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryFn } from '../../src/db.js';
import {
  submitUniversalV1TaskDraft,
  type TaskDraftIngressDependencies,
  type TaskDraftIngressInput,
} from '../../src/routers/web/taskDrafts.js';
import { taskDraftCardTokenHash } from '../../src/services/UniversalV1TaskDraftIngress.js';

const enabled = process.env.HX_ALLOW_TASK_DRAFT_INGRESS_PG === '1';
const describePg = enabled ? describe : describe.skip;
const databaseUrl = process.env.LOCAL_TEST_DB_URL ?? '';
const now = 1_800_000_000_000;

interface DraftFixture {
  input: TaskDraftIngressInput;
  dependencies: Partial<TaskDraftIngressDependencies>;
}

function assertDisposableDatabase(value: string): void {
  const parsed = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '5432' ||
    parsed.username !== 'hx_ci_runner' ||
    parsed.pathname !== '/hx_ci_system_test' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'TaskDraft ingress concurrency may run only on the exact disposable system database'
    );
  }
}

function completeFurnitureAnswers(item: string): Record<string, string | string[] | boolean> {
  return {
    item,
    new_in_box: true,
    timing: 'Flexible weekday afternoon',
    scope_confirmed_at: new Date(now).toISOString(),
    risk_level: 'green',
    preferred_window: 'flexible',
    included_work: ['Assemble the listed furniture'],
    excluded_work: ['Wall anchoring and electrical work'],
    safety_restrictions: [],
    required_tools: ['Basic hand tools'],
    required_vehicle: 'none',
    scope_policy_version: 'task_scope_v1',
  };
}

describePg('Universal V1 TaskDraft public ingress PostgreSQL concurrency', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    await pool.query('SELECT 1');
  });

  afterAll(async () => {
    await pool.end();
  });

  const transaction: TaskDraftIngressDependencies['transaction'] = async (callback) => {
    const client = await pool.connect();
    try {
      // Match the canonical db.transaction runtime rather than proving a
      // stronger isolation level that production ingress does not use.
      await client.query('BEGIN');
      const transactionQuery: QueryFn = async <Row = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
      ) => {
        const result = await client.query(sql, params);
        return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
      };
      const value = await callback(transactionQuery);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  function fixture(): DraftFixture {
    const submissionId = randomUUID();
    const input: TaskDraftIngressInput = {
      action: 'create',
      submission_id: submissionId,
      expected_version: 0,
      card_token: randomBytes(32).toString('hex'),
      raw_input: 'Assemble a six drawer dresser from sealed boxes',
      category: 'furniture_assembly',
      answers: completeFurnitureAnswers('Six drawer dresser'),
      zip: '98052',
      region: 'Eastside',
      photo_count: 0,
      consent_version: 'v1',
      turnstile_token: `synthetic-task-${randomUUID()}`,
      client_ts: now,
    };
    const dependencies: Partial<TaskDraftIngressDependencies> = {
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
      fetch: async () =>
        new Response(
          JSON.stringify({
            success: true,
            action: 'task',
            hostname: 'synthetic.invalid',
            metadata: { result_with_testing_key: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      now: () => now,
      randomUuid: randomUUID,
      transaction,
    };
    return { input, dependencies };
  }

  async function createOne(draft: DraftFixture): Promise<void> {
    const result = await submitUniversalV1TaskDraft(
      draft.input,
      { ip: '203.0.113.42' },
      draft.dependencies
    );
    expect(result).toMatchObject({ ok: true, replayed: false, version: 1 });
  }

  it('publishes one active version-one route across concurrent identical creates', async () => {
    const draft = fixture();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        submitUniversalV1TaskDraft(draft.input, { ip: '203.0.113.42' }, draft.dependencies)
      )
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.replayed)).toHaveLength(7);
    expect(results.every((result) => result.ok && result.version === 1)).toBe(true);

    const authority = await pool.query<{
      id: string;
      card_token_hash: string;
      universal_contract_version: number;
      structured: Record<string, unknown>;
      active_routing_decision_id: string;
      routing_id: string;
      decision_version: number;
      routes: number;
    }>(
      `SELECT draft.id, draft.card_token_hash, draft.universal_contract_version,
              draft.structured, draft.active_routing_decision_id,
              route.id AS routing_id, route.decision_version,
              (SELECT COUNT(*)::integer FROM task_routing_decisions all_routes
                WHERE all_routes.task_draft_id = draft.id) AS routes
         FROM task_drafts draft
         JOIN task_routing_decisions route
           ON route.id = draft.active_routing_decision_id
        WHERE draft.submission_id = $1`,
      [draft.input.submission_id]
    );
    expect(authority.rows).toHaveLength(1);
    expect(authority.rows[0]).toMatchObject({
      card_token_hash: taskDraftCardTokenHash(draft.input.card_token),
      universal_contract_version: 1,
      decision_version: 1,
      routes: 1,
    });
    expect(authority.rows[0]?.active_routing_decision_id).toBe(authority.rows[0]?.routing_id);
    expect(authority.rows[0]?.card_token_hash).not.toBe(draft.input.card_token);
    expect(authority.rows[0]?.structured).toMatchObject({
      estimate_display_only: true,
      missing_questions: [],
      risk_flags: [],
      financial_effects: 'FROZEN',
    });

    const sideEffects = await pool.query<{
      operations: number;
      financial_events: number;
      work_orders: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::integer FROM task_financial_operations
           WHERE task_draft_id = $1) AS operations,
         (SELECT COUNT(*)::integer FROM task_financial_security_events
           WHERE task_draft_id = $1) AS financial_events,
         (SELECT COUNT(*)::integer FROM task_work_orders
           WHERE task_draft_id = $1) AS work_orders`,
      [authority.rows[0]!.id]
    );
    expect(sideEffects.rows[0]).toEqual({ operations: 0, financial_events: 0, work_orders: 0 });
  });

  it('persists one version-two route across concurrent identical updates', async () => {
    const draft = fixture();
    await createOne(draft);
    const update: TaskDraftIngressInput = {
      ...draft.input,
      action: 'update',
      expected_version: 1,
      raw_input: 'Assemble a six drawer dresser and matching nightstand from sealed boxes',
      answers: completeFurnitureAnswers('Six drawer dresser and matching nightstand'),
      turnstile_token: undefined,
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        submitUniversalV1TaskDraft(update, { ip: '203.0.113.42' }, draft.dependencies)
      )
    );
    expect(results.every((result) => result.ok && result.version === 2)).toBe(true);
    expect(results.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.replayed)).toHaveLength(7);

    const routes = await pool.query<{
      decision_version: number;
      supersedes_decision_id: string | null;
      active: boolean;
    }>(
      `SELECT route.decision_version, route.supersedes_decision_id,
              route.id = draft.active_routing_decision_id AS active
         FROM task_drafts draft
         JOIN task_routing_decisions route ON route.task_draft_id = draft.id
        WHERE draft.submission_id = $1
        ORDER BY route.decision_version`,
      [draft.input.submission_id]
    );
    expect(routes.rows).toEqual([
      { decision_version: 1, supersedes_decision_id: null, active: false },
      {
        decision_version: 2,
        supersedes_decision_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        active: true,
      },
    ]);
  });

  it('accepts exactly one conflicting same-version update and rejects the other', async () => {
    const draft = fixture();
    await createOne(draft);
    const baseUpdate: TaskDraftIngressInput = {
      ...draft.input,
      action: 'update',
      expected_version: 1,
      turnstile_token: undefined,
    };
    const candidates: TaskDraftIngressInput[] = [
      {
        ...baseUpdate,
        raw_input: 'Assemble only the six drawer dresser from sealed boxes',
        answers: completeFurnitureAnswers('Six drawer dresser only'),
      },
      {
        ...baseUpdate,
        raw_input: 'Assemble only the matching nightstand from sealed boxes',
        answers: completeFurnitureAnswers('Matching nightstand only'),
      },
    ];

    const results = await Promise.allSettled(
      candidates.map((candidate) =>
        submitUniversalV1TaskDraft(candidate, { ip: '203.0.113.42' }, draft.dependencies)
      )
    );
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]).toMatchObject({ value: { ok: true, replayed: false, version: 2 } });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { code: 'CONFLICT' } });

    const authority = await pool.query<{ active_version: number; routes: number }>(
      `SELECT active_route.decision_version AS active_version,
              COUNT(all_routes.id)::integer AS routes
         FROM task_drafts draft
         JOIN task_routing_decisions active_route
           ON active_route.id = draft.active_routing_decision_id
         JOIN task_routing_decisions all_routes ON all_routes.task_draft_id = draft.id
        WHERE draft.submission_id = $1
        GROUP BY active_route.decision_version`,
      [draft.input.submission_id]
    );
    expect(authority.rows).toEqual([{ active_version: 2, routes: 2 }]);
  });

  it('denies a wrong card token without advancing routing authority', async () => {
    const draft = fixture();
    await createOne(draft);
    let wrongToken = randomBytes(32).toString('hex');
    while (wrongToken === draft.input.card_token) wrongToken = randomBytes(32).toString('hex');
    const update: TaskDraftIngressInput = {
      ...draft.input,
      action: 'update',
      expected_version: 1,
      card_token: wrongToken,
      raw_input: 'Assemble the six drawer dresser and add the supplied handles',
      answers: completeFurnitureAnswers('Six drawer dresser with supplied handles'),
      turnstile_token: undefined,
    };

    await expect(
      submitUniversalV1TaskDraft(update, { ip: '203.0.113.42' }, draft.dependencies)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const authority = await pool.query<{ active_version: number; routes: number }>(
      `SELECT active_route.decision_version AS active_version,
              COUNT(all_routes.id)::integer AS routes
         FROM task_drafts draft
         JOIN task_routing_decisions active_route
           ON active_route.id = draft.active_routing_decision_id
         JOIN task_routing_decisions all_routes ON all_routes.task_draft_id = draft.id
        WHERE draft.submission_id = $1
        GROUP BY active_route.decision_version`,
      [draft.input.submission_id]
    );
    expect(authority.rows).toEqual([{ active_version: 1, routes: 1 }]);
  });
});
