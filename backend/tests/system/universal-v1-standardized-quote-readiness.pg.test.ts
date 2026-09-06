import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { QueryFn } from '../../src/db.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import {
  productionMigrationRuntime,
  runEngineAutomationMigration,
} from '../../src/jobs/engine-automation-migration.js';
import {
  submitUniversalV1TaskDraft,
  type TaskDraftIngressDependencies,
  type TaskDraftIngressInput,
} from '../../src/routers/web/taskDrafts.js';
import {
  UniversalV1StandardizedQuoteApplication,
} from '../../src/services/UniversalV1StandardizedQuoteApplication.js';
import type {
  UniversalV1StandardizedQuoteRuntimeEvidence,
} from '../../src/services/UniversalV1StandardizedQuoteContracts.js';
import {
  UniversalV1StandardizedQuotePostgresRepository,
} from '../../src/services/UniversalV1StandardizedQuotePostgresRepository.js';
import {
  UniversalV1TaskOpportunityService,
} from '../../src/services/UniversalV1TaskOpportunityService.js';
import {
  claimUniversalV1TaskDraft,
  type UniversalV1TaskDraftClaimDependencies,
} from '../../src/services/UniversalV1TaskDraftClaim.js';
import type { Context } from '../../src/trpc-context.js';
import {
  ensureUniversalV1SyntheticServiceCell,
  SYNTHETIC_SERVICE_CELL_AUTHORITY_ID,
  SYNTHETIC_SERVICE_CELL_POSTAL_CODE,
  SYNTHETIC_SERVICE_CELL_REGION_CODE,
} from '../helpers/universal-v1-service-cell-authority.js';

const enabled = process.env.HX_ALLOW_TASK_DRAFT_INGRESS_PG === '1';
const describePg = enabled ? describe : describe.skip;
const databaseUrl = process.env.LOCAL_TEST_DB_URL ?? '';
const ingressNow = 1_800_000_000_000;
const migrationName = '20261009_universal_v1_standardized_quote_readiness_v1';
const migrationFileName = `${migrationName}.sql`;
const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', migrationFileName),
  'utf8'
);

const heldRelations = [
  'task_work_order_command_requests',
  'task_provider_eligibility_decisions',
  'task_work_orders',
  'task_work_order_execution_facts',
  'task_reservations',
  'task_applications',
] as const;

const excludedFreeFormAnswerKeys = [
  'item',
  'timing',
  'item_dimensions',
  'assembly_options',
  'access',
] as const;
const excludedMutableCarrierKeys = [
  'required_skills',
  'required_tools',
  'labor_label',
] as const;

type HeldRelation = (typeof heldRelations)[number];
type ExcludedFreeFormAnswerKey = (typeof excludedFreeFormAnswerKeys)[number];
type ExcludedMutableCarrierKey = (typeof excludedMutableCarrierKeys)[number];

interface ClaimedFurnitureAssemblyFixture {
  taskDraftId: string;
  posterUserId: string;
  routingDecisionId: string;
  routingDecisionVersion: number;
  rawScopeSecret: string;
  accessSecret: string;
  excludedFreeFormMarkers: Record<ExcludedFreeFormAnswerKey, string>;
  excludedMutableCarrierMarkers: Record<ExcludedMutableCarrierKey, string>;
}

interface ClaimedMovingFixture {
  taskDraftId: string;
  posterUserId: string;
  routingDecisionId: string;
  routingDecisionVersion: number;
}

interface LifecycleCounts {
  quotes: number;
  acceptances: number;
  readiness: number;
}

interface HeldCounts {
  task_work_order_command_requests: number;
  task_provider_eligibility_decisions: number;
  task_work_orders: number;
  task_work_order_execution_facts: number;
  task_reservations: number;
  task_applications: number;
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
      'Standardized quote proof may run only on the exact disposable system database'
    );
  }
}

function heldRelationIn(sql: string): HeldRelation | null {
  return (
    heldRelations.find((relation) =>
      new RegExp(`\\b(?:public\\s*\\.\\s*)?${relation}\\b`, 'iu').test(sql)
    ) ?? null
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function providerContext(userId: string): Context {
  return {
    user: {
      id: userId,
      is_banned: false,
      account_status: 'ACTIVE',
      default_mode: 'worker',
    },
    firebaseUid: `firebase-${userId}`,
  } as unknown as Context;
}

function runtimeEvidence(seed: string): UniversalV1StandardizedQuoteRuntimeEvidence {
  return {
    environment: 'local',
    buildCommitSha: seed.repeat(40),
    releaseManifestDigest: `sha256:${seed.repeat(64)}`,
    capabilityPolicyDigest: `sha256:${seed.repeat(64)}`,
  };
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
}

describePg('Universal V1 standardized quote readiness PostgreSQL authority', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 20 });

  const transaction = async <T>(callback: (query: QueryFn) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const query: QueryFn = async <Row = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
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

  function guardedQuery(touches: HeldRelation[]): QueryFn {
    return async <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const heldRelation = heldRelationIn(sql);
      if (heldRelation) {
        touches.push(heldRelation);
        throw new Error(`HELD_RELATION_ACCESSED:${heldRelation}`);
      }
      const result = await pool.query(sql, params);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    };
  }

  async function guardedTransaction<T>(
    touches: HeldRelation[],
    callback: (query: QueryFn) => Promise<T>,
    serializable = false
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(serializable ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN');
      const query: QueryFn = async <Row = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
      ) => {
        const heldRelation = heldRelationIn(sql);
        if (heldRelation) {
          touches.push(heldRelation);
          throw new Error(`HELD_RELATION_ACCESSED:${heldRelation}`);
        }
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
  }

  function standardizedQuoteApplication(
    evidence: UniversalV1StandardizedQuoteRuntimeEvidence,
    touches: HeldRelation[]
  ): UniversalV1StandardizedQuoteApplication {
    const repository = new UniversalV1StandardizedQuotePostgresRepository({
      query: guardedQuery(touches),
      serializableTransaction: (callback) => guardedTransaction(touches, callback, true),
    });
    return new UniversalV1StandardizedQuoteApplication(repository, {
      now: Date.now,
      runtimeEvidence: () => evidence,
    });
  }

  function opportunityService(touches: HeldRelation[]): UniversalV1TaskOpportunityService {
    return new UniversalV1TaskOpportunityService({
      query: guardedQuery(touches),
      transaction: (callback) => guardedTransaction(touches, callback),
    });
  }

  const ingressDependencies: Partial<TaskDraftIngressDependencies> = {
    env: {
      NODE_ENV: 'test',
      HX_ENVIRONMENT: 'test',
      HX_HUMAN_VERIFICATION_MODE: 'synthetic',
      HX_HUMAN_VERIFICATION_URL:
        'http://127.0.0.1:8080/v1/human-verification/verify',
      HX_HUMAN_VERIFICATION_SECRET: 'required-test-standardized-quote-human-secret-v1',
      PUBLIC_INGRESS_IP_HASH_SALT: 'required-test-standardized-quote-ip-salt-v1',
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
    now: () => ingressNow,
    randomUuid: randomUUID,
    transaction,
  };

  const claimDependencies: Partial<UniversalV1TaskDraftClaimDependencies> = {
    now: () => ingressNow,
    randomUuid: randomUUID,
    transaction,
  };

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    expect(process.env.HX_PAYMENT_CREATION_MODE).toBe('frozen');
    await pool.query('SELECT 1');
    await ensureUniversalV1SyntheticServiceCell(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  async function userFixture(mode: 'poster' | 'worker'): Promise<string> {
    const userId = randomUUID();
    await pool.query(
      `INSERT INTO public.users(
         id, firebase_uid, email, full_name, default_mode, date_of_birth,
         is_minor, is_banned, account_status
       ) VALUES (
         $1, $2, $3, 'Standardized Quote System Test', $4, DATE '1990-01-01',
         FALSE, FALSE, 'ACTIVE'
       )`,
      [
        userId,
        `firebase-${userId}`,
        `${userId}@standardized-quote.example.invalid`,
        mode,
      ]
    );
    return userId;
  }

  async function claimedFurnitureAssemblyFixture(
    label: string
  ): Promise<ClaimedFurnitureAssemblyFixture> {
    const submissionId = randomUUID();
    const cardToken = randomBytes(32).toString('hex');
    const rawScopeSecret = `private-scope-${label}-${randomUUID()}`;
    const excludedFreeFormMarkers = Object.fromEntries(
      excludedFreeFormAnswerKeys.map((key) => [
        key,
        `pii-${key}-${label}-${randomUUID()}`,
      ])
    ) as Record<ExcludedFreeFormAnswerKey, string>;
    const accessSecret = excludedFreeFormMarkers.access;
    const excludedMutableCarrierMarkers = Object.fromEntries(
      excludedMutableCarrierKeys.map((key) => [
        key,
        `pii-${key}-${label}-${randomUUID()}`,
      ])
    ) as Record<ExcludedMutableCarrierKey, string>;
    const create: TaskDraftIngressInput = {
      action: 'create',
      submission_id: submissionId,
      expected_version: 0,
      card_token: cardToken,
      raw_input: `Assemble a sealed-box dresser with ordinary hand tools ${rawScopeSecret}`,
      category: 'furniture_assembly',
      answers: {
        assembly_scope_class: 'STANDARD_SINGLE_FLAT_PACK_ITEM_V1',
        item_count_class: 'one',
        item: excludedFreeFormMarkers.item,
        item_dimensions: excludedFreeFormMarkers.item_dimensions,
        new_in_box: true,
        tools_included: true,
        old_item_removal: false,
        assembly_options: excludedFreeFormMarkers.assembly_options,
        timing: excludedFreeFormMarkers.timing,
        access: excludedFreeFormMarkers.access,
        scope_confirmed_at: new Date(ingressNow).toISOString(),
      },
      zip: SYNTHETIC_SERVICE_CELL_POSTAL_CODE,
      region: 'untrusted-client-location-hint',
      photo_count: 0,
      consent_version: 'v1',
      turnstile_token: `synthetic-standardized-quote-${randomUUID()}`,
      client_ts: ingressNow,
    };
    const created = await submitUniversalV1TaskDraft(
      create,
      { ip: '203.0.113.143' },
      ingressDependencies
    );
    if (!created.ok) throw new Error('Synthetic furniture-assembly TaskDraft was rejected.');

    const leadSubmissionId = randomUUID();
    await pool.query(
      `INSERT INTO public.leads(submission_id, lead_type, email, name, answers, source)
       VALUES (
         $1, 'poster', $2, 'Standardized Quote Customer',
         jsonb_build_object('task_draft_submission_id', $3::TEXT),
         'required_test'
       )`,
      [
        leadSubmissionId,
        `${leadSubmissionId}@standardized-quote-contact.example.invalid`,
        submissionId,
      ]
    );
    const linked = await submitUniversalV1TaskDraft(
      {
        ...create,
        action: 'link_contact',
        expected_version: created.version,
        raw_input: 'contact link',
        lead_submission_id: leadSubmissionId,
        turnstile_token: undefined,
      },
      { ip: '203.0.113.143' },
      ingressDependencies
    );
    if (!linked.ok) throw new Error('Synthetic furniture-assembly contact link was rejected.');

    const posterUserId = await userFixture('poster');
    await claimUniversalV1TaskDraft(
      {
        submission_id: submissionId,
        card_token: cardToken,
        expected_version: 0,
        idempotency_key: `claim-standardized:${submissionId}`,
        client_ts: ingressNow,
      },
      posterUserId,
      claimDependencies
    );

    // Model a legacy or concurrently mutable parser projection. Quote/provider
    // scope must not trust these string carriers merely because they sit at a
    // server-shaped top-level key in the TaskDraft JSON document.
    await pool.query(
      `UPDATE public.task_drafts
          SET structured = structured || jsonb_build_object(
            'required_skills', jsonb_build_array($2::TEXT),
            'required_tools', jsonb_build_array($3::TEXT),
            'labor_label', $4::TEXT
          )
        WHERE id = $1::UUID`,
      [
        linked.draft_id,
        excludedMutableCarrierMarkers.required_skills,
        excludedMutableCarrierMarkers.required_tools,
        excludedMutableCarrierMarkers.labor_label,
      ]
    );

    const route = await pool.query<{
      routing_decision_id: string;
      routing_decision_version: number;
      routing_outcome: string;
      work_category_code: string;
      service_cell_authority_id: string;
      region_code: string;
    }>(
      `SELECT route.id AS routing_decision_id,
              route.decision_version AS routing_decision_version,
              route.outcome AS routing_outcome,
              route.category_snapshot AS work_category_code,
              route.service_cell_authority_id,
              route.service_cell_snapshot AS region_code
         FROM public.task_drafts draft
         JOIN public.task_routing_decisions route
           ON route.id = draft.active_routing_decision_id
          AND route.task_draft_id = draft.id
        WHERE draft.id = $1::UUID`,
      [linked.draft_id]
    );
    expect(route.rows[0]).toMatchObject({
      routing_outcome: 'FULFILLMENT_CANDIDATE',
      work_category_code: 'furniture_assembly',
      service_cell_authority_id: SYNTHETIC_SERVICE_CELL_AUTHORITY_ID,
      region_code: SYNTHETIC_SERVICE_CELL_REGION_CODE,
    });
    const currentRoute = route.rows[0];
    if (!currentRoute) throw new Error('Synthetic TaskDraft has no exact active route.');
    return {
      taskDraftId: linked.draft_id,
      posterUserId,
      routingDecisionId: currentRoute.routing_decision_id,
      routingDecisionVersion: currentRoute.routing_decision_version,
      rawScopeSecret,
      accessSecret,
      excludedFreeFormMarkers,
      excludedMutableCarrierMarkers,
    };
  }

  async function claimedMovingFixture(label: string): Promise<ClaimedMovingFixture> {
    const submissionId = randomUUID();
    const cardToken = randomBytes(32).toString('hex');
    const create: TaskDraftIngressInput = {
      action: 'create',
      submission_id: submissionId,
      expected_version: 0,
      card_token: cardToken,
      raw_input: `Move one light non-fragile item on the same property ${label}`,
      category: 'moving',
      answers: {
        size_weight: 'light',
        access: 'ground',
        move_type: 'same',
        workers_needed: 'one',
        fragile: false,
        timing: 'flexible',
        scope_confirmed_at: new Date(ingressNow).toISOString(),
      },
      zip: SYNTHETIC_SERVICE_CELL_POSTAL_CODE,
      region: 'untrusted-client-location-hint',
      photo_count: 0,
      consent_version: 'v1',
      turnstile_token: `synthetic-standardized-moving-${randomUUID()}`,
      client_ts: ingressNow,
    };
    const created = await submitUniversalV1TaskDraft(
      create,
      { ip: '203.0.113.144' },
      ingressDependencies
    );
    if (!created.ok) throw new Error('Synthetic moving TaskDraft was rejected.');

    const leadSubmissionId = randomUUID();
    await pool.query(
      `INSERT INTO public.leads(submission_id, lead_type, email, name, answers, source)
       VALUES (
         $1, 'poster', $2, 'Standardized Moving Customer',
         jsonb_build_object('task_draft_submission_id', $3::TEXT),
         'required_test'
       )`,
      [
        leadSubmissionId,
        `${leadSubmissionId}@standardized-moving.example.invalid`,
        submissionId,
      ]
    );
    const linked = await submitUniversalV1TaskDraft(
      {
        ...create,
        action: 'link_contact',
        expected_version: created.version,
        raw_input: 'contact link',
        lead_submission_id: leadSubmissionId,
        turnstile_token: undefined,
      },
      { ip: '203.0.113.144' },
      ingressDependencies
    );
    if (!linked.ok) throw new Error('Synthetic moving contact link was rejected.');

    const posterUserId = await userFixture('poster');
    await claimUniversalV1TaskDraft(
      {
        submission_id: submissionId,
        card_token: cardToken,
        expected_version: 0,
        idempotency_key: `claim-standardized-moving:${submissionId}`,
        client_ts: ingressNow,
      },
      posterUserId,
      claimDependencies
    );
    const route = await pool.query<{
      routing_decision_id: string;
      routing_decision_version: number;
      routing_outcome: string;
      work_category_code: string;
    }>(
      `SELECT route.id AS routing_decision_id,
              route.decision_version AS routing_decision_version,
              route.outcome AS routing_outcome,
              route.category_snapshot AS work_category_code
         FROM public.task_drafts draft
         JOIN public.task_routing_decisions route
           ON route.id = draft.active_routing_decision_id
          AND route.task_draft_id = draft.id
        WHERE draft.id = $1::UUID`,
      [linked.draft_id]
    );
    expect(route.rows[0]).toMatchObject({
      routing_outcome: 'FULFILLMENT_CANDIDATE',
      work_category_code: 'moving',
    });
    const currentRoute = route.rows[0];
    if (!currentRoute) throw new Error('Synthetic moving TaskDraft has no active route.');
    return {
      taskDraftId: linked.draft_id,
      posterUserId,
      routingDecisionId: currentRoute.routing_decision_id,
      routingDecisionVersion: currentRoute.routing_decision_version,
    };
  }

  async function generalProviderFixture(): Promise<string> {
    const providerUserId = await userFixture('worker');
    await pool.query(
      `INSERT INTO public.capability_profiles(user_id, trust_tier, provider_class)
       VALUES ($1::UUID, 1, 'GENERAL_SERVICE_PROVIDER')`,
      [providerUserId]
    );
    return providerUserId;
  }

  async function advanceSyntheticRouteForReview(
    taskDraftId: string
  ): Promise<{ routingDecisionId: string; routingDecisionVersion: number }> {
    const correlationId = randomUUID();
    const result = await pool.query<{
      id: string;
      decision_version: number;
    }>(
      `INSERT INTO public.task_routing_decisions(
         task_draft_id, decision_version, supersedes_decision_id, outcome,
         reason_codes, policy_version, category_snapshot, service_cell_snapshot,
         service_cell_authority_id, decision_authority, evidence, idempotency_key
       )
       SELECT route.task_draft_id,
              route.decision_version + 1,
              route.id,
              route.outcome,
              route.reason_codes,
              route.policy_version,
              route.category_snapshot,
              route.service_cell_snapshot,
              route.service_cell_authority_id,
              'DETERMINISTIC_POLICY',
              jsonb_set(
                route.evidence,
                '{ingress_action}',
                to_jsonb('update'::TEXT),
                TRUE
              ) || jsonb_build_object(
                'correlation_id', $2::TEXT,
                'request_sha256', repeat('d', 64)
              ),
              $3
         FROM public.task_drafts draft
         JOIN public.task_routing_decisions route
           ON route.id = draft.active_routing_decision_id
          AND route.task_draft_id = draft.id
        WHERE draft.id = $1::UUID
       RETURNING id, decision_version`,
      [taskDraftId, correlationId, `standardized-route-drift:${randomUUID()}`]
    );
    const route = result.rows[0];
    if (!route) throw new Error('Synthetic route-review revision was not recorded.');
    return {
      routingDecisionId: route.id,
      routingDecisionVersion: route.decision_version,
    };
  }

  async function advanceRelationshipOriginForReview(
    taskDraftId: string
  ): Promise<{ relationshipOriginId: string; relationshipOriginVersion: number }> {
    const result = await pool.query<{ id: string; origin_version: number }>(
      `INSERT INTO public.universal_v1_relationship_origins(
         task_draft_id, policy_version, origin_kind, origin_version,
         supersedes_origin_id, initiator_identity_observation_id,
         customer_identity_observation_id, customer_consent_observation_id,
         provider_link_observation_id, provider_consent_observation_id
       )
       SELECT origin.task_draft_id, origin.policy_version, origin.origin_kind,
              origin.origin_version + 1, origin.id,
              origin.initiator_identity_observation_id,
              origin.customer_identity_observation_id,
              origin.customer_consent_observation_id,
              origin.provider_link_observation_id,
              origin.provider_consent_observation_id
         FROM public.universal_v1_relationship_origins origin
        WHERE origin.task_draft_id = $1::UUID
          AND NOT EXISTS (
            SELECT 1 FROM public.universal_v1_relationship_origins successor
            WHERE successor.supersedes_origin_id = origin.id
          )
        ORDER BY origin.origin_version DESC
        LIMIT 1
       RETURNING id, origin_version`,
      [taskDraftId]
    );
    const origin = result.rows[0];
    if (!origin) throw new Error('Synthetic RelationshipOrigin revision was not recorded.');
    return {
      relationshipOriginId: origin.id,
      relationshipOriginVersion: origin.origin_version,
    };
  }

  async function lifecycleCounts(taskDraftId: string): Promise<LifecycleCounts> {
    const result = await pool.query<LifecycleCounts>(
      `SELECT
         (SELECT COUNT(*)::INTEGER
            FROM public.task_draft_standardized_quote_versions
           WHERE task_draft_id = $1::UUID) AS quotes,
         (SELECT COUNT(*)::INTEGER
            FROM public.task_draft_standardized_quote_acceptance_facts
           WHERE task_draft_id = $1::UUID) AS acceptances,
         (SELECT COUNT(*)::INTEGER
            FROM public.task_draft_payment_method_readiness_facts
           WHERE task_draft_id = $1::UUID) AS readiness`,
      [taskDraftId]
    );
    return result.rows[0]!;
  }

  async function heldCounts(): Promise<HeldCounts> {
    const result = await pool.query<HeldCounts>(`
      SELECT
        (SELECT COUNT(*)::INTEGER FROM public.task_work_order_command_requests)
          AS task_work_order_command_requests,
        (SELECT COUNT(*)::INTEGER FROM public.task_provider_eligibility_decisions)
          AS task_provider_eligibility_decisions,
        (SELECT COUNT(*)::INTEGER FROM public.task_work_orders)
          AS task_work_orders,
        (SELECT COUNT(*)::INTEGER FROM public.task_work_order_execution_facts)
          AS task_work_order_execution_facts,
        (SELECT COUNT(*)::INTEGER FROM public.task_reservations)
          AS task_reservations,
        (SELECT COUNT(*)::INTEGER FROM public.task_applications)
          AS task_applications
    `);
    return result.rows[0]!;
  }

  it('keeps migration 143 at its exact ordinal and replays both its SQL and the exact applied chain', async () => {
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(146);
    expect(REQUIRED_MIGRATION_FILES[142]).toEqual({
      name: migrationName,
      fileName: migrationFileName,
    });
    const migrationSha256 = createHash('sha256').update(migration, 'utf8').digest('hex');
    const before = await pool.query<{
      name: string;
      sha256: string;
      applied_at: Date;
    }>(
      `SELECT name, btrim(sha256) AS sha256, applied_at
         FROM public.applied_migrations
        WHERE name = $1`,
      [migrationName]
    );
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]).toMatchObject({ name: migrationName, sha256: migrationSha256 });
    const canonicalOrder = await pool.query<{
      canonical_count: number;
      applied_after_v143: number;
    }>(
      `WITH canonical AS (
         SELECT name, applied_at
           FROM public.applied_migrations
          WHERE name = ANY($1::TEXT[])
       ), target AS (
         SELECT applied_at
           FROM canonical
          WHERE name = $2
       )
       SELECT COUNT(*)::INTEGER AS canonical_count,
              COUNT(*) FILTER (
                WHERE canonical.applied_at > target.applied_at
              )::INTEGER AS applied_after_v143
         FROM canonical
         CROSS JOIN target
        GROUP BY target.applied_at`,
      [REQUIRED_MIGRATION_FILES.map(({ name }) => name), migrationName]
    );
    expect(canonicalOrder.rows).toEqual([
      { canonical_count: 146, applied_after_v143: 3 },
    ]);

    // The exact SQL is independently replayable for clean-install/recovery
    // verification; trigger replacement must converge on every execution.
    await pool.query(migration);
    await pool.query(migration);

    const installedTriggers = await pool.query<{
      trigger_name: string;
      relation_name: string;
    }>(`
      SELECT trigger.tgname AS trigger_name, relation.relname AS relation_name
        FROM pg_catalog.pg_trigger trigger
        JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND NOT trigger.tgisinternal
         AND trigger.tgname IN (
           'task_draft_standardized_quote_versions_insert_guard',
           'task_draft_standardized_quote_acceptance_insert_guard',
           'task_draft_payment_method_readiness_insert_guard',
           'task_draft_standardized_quote_versions_immutable',
           'task_draft_standardized_quote_versions_no_truncate',
           'task_draft_standardized_quote_acceptance_immutable',
           'task_draft_standardized_quote_acceptance_no_truncate',
           'task_draft_payment_method_readiness_immutable',
           'task_draft_payment_method_readiness_no_truncate',
           'universal_v1_service_cell_price_book_mappings_immutable',
           'universal_v1_service_cell_price_book_mappings_no_truncate'
         )
       ORDER BY trigger.tgname
    `);
    expect(installedTriggers.rows).toEqual([
      {
        trigger_name: 'task_draft_payment_method_readiness_immutable',
        relation_name: 'task_draft_payment_method_readiness_facts',
      },
      {
        trigger_name: 'task_draft_payment_method_readiness_insert_guard',
        relation_name: 'task_draft_payment_method_readiness_facts',
      },
      {
        trigger_name: 'task_draft_payment_method_readiness_no_truncate',
        relation_name: 'task_draft_payment_method_readiness_facts',
      },
      {
        trigger_name: 'task_draft_standardized_quote_acceptance_immutable',
        relation_name: 'task_draft_standardized_quote_acceptance_facts',
      },
      {
        trigger_name: 'task_draft_standardized_quote_acceptance_insert_guard',
        relation_name: 'task_draft_standardized_quote_acceptance_facts',
      },
      {
        trigger_name: 'task_draft_standardized_quote_acceptance_no_truncate',
        relation_name: 'task_draft_standardized_quote_acceptance_facts',
      },
      {
        trigger_name: 'task_draft_standardized_quote_versions_immutable',
        relation_name: 'task_draft_standardized_quote_versions',
      },
      {
        trigger_name: 'task_draft_standardized_quote_versions_insert_guard',
        relation_name: 'task_draft_standardized_quote_versions',
      },
      {
        trigger_name: 'task_draft_standardized_quote_versions_no_truncate',
        relation_name: 'task_draft_standardized_quote_versions',
      },
      {
        trigger_name: 'universal_v1_service_cell_price_book_mappings_immutable',
        relation_name: 'universal_v1_service_cell_price_book_mappings',
      },
      {
        trigger_name: 'universal_v1_service_cell_price_book_mappings_no_truncate',
        relation_name: 'universal_v1_service_cell_price_book_mappings',
      },
    ]);

    const priceBookCategoryAuthority = await pool.query<{ present: boolean }>(`
      SELECT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_constraint constraint_row
          JOIN pg_catalog.pg_class relation
            ON relation.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'price_book'
           AND constraint_row.contype = 'u'
           AND (
             SELECT array_agg(attribute.attname::TEXT ORDER BY key_column.ordinality)
               FROM unnest(constraint_row.conkey) WITH ORDINALITY
                 AS key_column(attnum, ordinality)
               JOIN pg_catalog.pg_attribute attribute
                 ON attribute.attrelid = constraint_row.conrelid
                AND attribute.attnum = key_column.attnum
           ) = ARRAY['category']::TEXT[]
      ) AS present
    `);
    expect(priceBookCategoryAuthority.rows).toEqual([{ present: true }]);

    const mapping = await pool.query<{ id: string }>(
      `SELECT id FROM public.universal_v1_service_cell_price_book_mappings
        ORDER BY created_at, id
        LIMIT 1`
    );
    const mappingId = mapping.rows[0]?.id;
    if (!mappingId) throw new Error('Synthetic Price Book mapping fixture was not found.');
    await expect(
      pool.query(
        `INSERT INTO public.universal_v1_service_cell_price_book_mappings (
           service_cell_authority_id,
           service_cell_authority_version,
           price_book_id,
           price_book_policy_version,
           environment_class,
           mapping_version,
           evidence,
           evidence_sha256
         )
         SELECT service_cell_authority_id,
                service_cell_authority_version,
                price_book_id,
                price_book_policy_version,
                environment_class,
                mapping_version,
                evidence,
                evidence_sha256
           FROM public.universal_v1_service_cell_price_book_mappings
          WHERE id = $1::UUID`,
        [mappingId]
      )
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query(
        `UPDATE public.universal_v1_service_cell_price_book_mappings
            SET evidence = evidence || '{"mutated":true}'::JSONB
          WHERE id = $1::UUID`,
        [mappingId]
      )
    ).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining(
        'standardized pricing mappings, quotes, acceptances, and readiness facts are append-only'
      ),
    });
    await expect(
      pool.query(
        'TRUNCATE TABLE public.universal_v1_service_cell_price_book_mappings CASCADE'
      )
    ).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining(
        'standardized pricing mappings, quotes, acceptances, and readiness facts are append-only'
      ),
    });

    // Canonical runner replay is separately checksum-bound: every exact
    // ledger entry remains already-applied, in registered dependency order.
    const runtime = productionMigrationRuntime();
    runtime.databaseUrl = databaseUrl;
    const replay = await runEngineAutomationMigration(runtime);
    expect(replay).toHaveLength(146);
    expect(replay.every((outcome) => outcome.status === 'already_applied')).toBe(true);
    expect(replay[142]).toMatchObject({
      status: 'already_applied',
      migration: migrationName,
      sha256: migrationSha256,
    });

    const after = await pool.query<{
      name: string;
      sha256: string;
      applied_at: Date;
    }>(
      `SELECT name, btrim(sha256) AS sha256, applied_at
         FROM public.applied_migrations
        WHERE name = $1`,
      [migrationName]
    );
    expect(after.rows).toEqual(before.rows);

    const installedDefinitions = await pool.query<{ name: string; definition: string }>(`
      SELECT procedure.proname AS name, pg_get_functiondef(procedure.oid) AS definition
        FROM pg_catalog.pg_proc procedure
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure.proname IN (
           'universal_v1_standardized_quote_request_sha256',
           'universal_v1_standardized_quote_acceptance_request_sha256',
           'universal_v1_fake_payment_readiness_request_sha256',
           'enforce_universal_v1_standardized_quote_v1',
           'enforce_universal_v1_standardized_quote_acceptance_v1',
           'enforce_universal_v1_fake_payment_readiness_v1',
           'prevent_universal_v1_standardized_quote_fact_mutation_v1'
         )
      UNION ALL
      SELECT 'current_universal_v1_task_opportunities_v1' AS name,
             pg_get_viewdef('public.current_universal_v1_task_opportunities_v1'::REGCLASS, TRUE)
               AS definition
    `);
    expect(installedDefinitions.rows).toHaveLength(8);
    for (const installed of installedDefinitions.rows) {
      for (const heldRelation of heldRelations) {
        expect(
          installed.definition,
          `${installed.name} must not acquire ${heldRelation}`
        ).not.toMatch(new RegExp(`\\b${heldRelation}\\b`, 'iu'));
      }
    }
  }, 120_000);

  it('fails quote insertion when a retained answer has the wrong type or domain', async () => {
    const invalidCases: Array<{
      label: string;
      answerKey: string;
      answerValue: unknown;
      evidenceSeed: string;
    }> = [
      {
        label: 'wrong-scope-class',
        answerKey: 'assembly_scope_class',
        answerValue: 'MULTIPLE_OR_CUSTOM_ITEMS',
        evidenceSeed: '1',
      },
      {
        label: 'wrong-item-count-class',
        answerKey: 'item_count_class',
        answerValue: 'two',
        evidenceSeed: '2',
      },
      {
        label: 'string-boolean',
        answerKey: 'tools_included',
        answerValue: 'yes',
        evidenceSeed: '3',
      },
      {
        label: 'tools-not-included',
        answerKey: 'tools_included',
        answerValue: false,
        evidenceSeed: '4',
      },
    ];

    for (const invalidCase of invalidCases) {
      const fixture = await claimedFurnitureAssemblyFixture(
        `typed-answer-${invalidCase.label}`
      );
      await pool.query(
        `UPDATE public.task_drafts
            SET structured = jsonb_set(
              structured,
              ARRAY['answers', $2::TEXT],
              $3::JSONB,
              FALSE
            )
          WHERE id = $1::UUID`,
        [
          fixture.taskDraftId,
          invalidCase.answerKey,
          JSON.stringify(invalidCase.answerValue),
        ]
      );
      const touches: HeldRelation[] = [];
      const application = standardizedQuoteApplication(
        runtimeEvidence(invalidCase.evidenceSeed),
        touches
      );
      const beforeRejectedQuote = await lifecycleCounts(fixture.taskDraftId);
      await expect(
        application.prepareQuote(fixture.posterUserId, {
          taskDraftId: fixture.taskDraftId,
          expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
          expectedQuoteVersion: 0,
          idempotencyKey: `invalid-typed-answer:${randomUUID()}`,
          clientTs: Date.now(),
        })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(await lifecycleCounts(fixture.taskDraftId)).toEqual(beforeRejectedQuote);
      expect(touches).toEqual([]);
    }
  }, 120_000);

  it('fails quote insertion when required typed scope is deleted after routing', async () => {
    const fixture = await claimedFurnitureAssemblyFixture('post-route-scope-deletion');
    await pool.query(
      `UPDATE public.task_drafts
          SET structured = jsonb_set(
            structured,
            '{answers}',
            (structured -> 'answers') - 'assembly_scope_class',
            FALSE
          )
        WHERE id = $1::UUID`,
      [fixture.taskDraftId]
    );
    const touches: HeldRelation[] = [];
    const application = standardizedQuoteApplication(runtimeEvidence('4'), touches);
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual({
      quotes: 0,
      acceptances: 0,
      readiness: 0,
    });
    await expect(
      application.prepareQuote(fixture.posterUserId, {
        taskDraftId: fixture.taskDraftId,
        expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
        expectedQuoteVersion: 0,
        idempotencyKey: `deleted-typed-answer:${randomUUID()}`,
        clientTs: Date.now(),
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual({
      quotes: 0,
      acceptances: 0,
      readiness: 0,
    });
    expect(touches).toEqual([]);
  }, 60_000);

  it('refuses an active but unreviewed Price Book policy version', async () => {
    const fixture = await claimedFurnitureAssemblyFixture('unreviewed-price-policy');
    const policy = await pool.query<{ policy_version: string }>(
      `SELECT policy_version FROM public.price_book
        WHERE category = 'furniture_assembly'`
    );
    const originalPolicyVersion = policy.rows[0]?.policy_version;
    if (!originalPolicyVersion) throw new Error('Furniture Price Book policy was not found.');
    await pool.query(
      `UPDATE public.price_book
          SET policy_version = 'hxos-price-book-v2'
        WHERE category = 'furniture_assembly'`
    );
    try {
      const touches: HeldRelation[] = [];
      const application = standardizedQuoteApplication(runtimeEvidence('6'), touches);
      await expect(
        application.prepareQuote(fixture.posterUserId, {
          taskDraftId: fixture.taskDraftId,
          expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
          expectedQuoteVersion: 0,
          idempotencyKey: `unreviewed-price-policy:${randomUUID()}`,
          clientTs: Date.now(),
        })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(await lifecycleCounts(fixture.taskDraftId)).toEqual({
        quotes: 0,
        acceptances: 0,
        readiness: 0,
      });
      expect(touches).toEqual([]);
    } finally {
      await pool.query(
        `UPDATE public.price_book SET policy_version = $1
          WHERE category = 'furniture_assembly'`,
        [originalPolicyVersion]
      );
    }
  }, 60_000);

  it('computes the margin floor without PostgreSQL INTEGER overflow', async () => {
    const fixture = await claimedFurnitureAssemblyFixture('large-price-arithmetic');
    const original = await pool.query<{
      base_price_cents: number;
      price_min_cents: number;
      price_max_cents: number;
      price_cap_cents: number;
      min_hustler_payout_cents: number;
      platform_margin_floor_pct: string;
    }>(
      `SELECT base_price_cents, price_min_cents, price_max_cents,
              price_cap_cents, min_hustler_payout_cents,
              platform_margin_floor_pct::TEXT AS platform_margin_floor_pct
         FROM public.price_book
        WHERE category = 'furniture_assembly'`
    );
    const originalPrice = original.rows[0];
    if (!originalPrice) throw new Error('Furniture Price Book row was not found.');
    await pool.query(
      `UPDATE public.price_book
          SET base_price_cents = 1000000,
              price_min_cents = 1000000,
              price_max_cents = 1000000,
              price_cap_cents = 1000000,
              min_hustler_payout_cents = 700000,
              platform_margin_floor_pct = 25
        WHERE category = 'furniture_assembly'`
    );
    try {
      const touches: HeldRelation[] = [];
      const application = standardizedQuoteApplication(runtimeEvidence('e'), touches);
      const quoted = await application.prepareQuote(fixture.posterUserId, {
        taskDraftId: fixture.taskDraftId,
        expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
        expectedQuoteVersion: 0,
        idempotencyKey: `large-price-arithmetic:${randomUUID()}`,
        clientTs: Date.now(),
      });
      expect(quoted.quote).toMatchObject({
        customerTotalCents: 1_000_000,
        providerPayoutCents: 750_000,
        platformMarginCents: 250_000,
        pricingSnapshot: {
          platformMarginFloorBps: 2_500,
        },
      });
      expect(touches).toEqual([]);
    } finally {
      await pool.query(
        `UPDATE public.price_book
            SET base_price_cents = $1,
                price_min_cents = $2,
                price_max_cents = $3,
                price_cap_cents = $4,
                min_hustler_payout_cents = $5,
                platform_margin_floor_pct = $6
          WHERE category = 'furniture_assembly'`,
        [
          originalPrice.base_price_cents,
          originalPrice.price_min_cents,
          originalPrice.price_max_cents,
          originalPrice.price_cap_cents,
          originalPrice.min_hustler_payout_cents,
          originalPrice.platform_margin_floor_pct,
        ]
      );
    }
  }, 60_000);

  it('fails quote insertion when an unowned canonical pricing key appears after routing', async () => {
    const fixture = await claimedFurnitureAssemblyFixture('post-route-pricing-modifier');
    await pool.query(
      `UPDATE public.task_drafts
          SET structured = jsonb_set(
            structured,
            '{answers,preferred_window}',
            to_jsonb('today_or_tomorrow'::TEXT),
            TRUE
          )
        WHERE id = $1::UUID`,
      [fixture.taskDraftId]
    );
    const touches: HeldRelation[] = [];
    const application = standardizedQuoteApplication(runtimeEvidence('5'), touches);
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual({
      quotes: 0,
      acceptances: 0,
      readiness: 0,
    });
    await expect(
      application.prepareQuote(fixture.posterUserId, {
        taskDraftId: fixture.taskDraftId,
        expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
        expectedQuoteVersion: 0,
        idempotencyKey: `modifier-bearing-scope:${randomUUID()}`,
        clientTs: Date.now(),
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual({
      quotes: 0,
      acceptances: 0,
      readiness: 0,
    });
    expect(touches).toEqual([]);
  }, 60_000);

  it('runs the exact moving scope through quote, acceptance, fake readiness, and provider view', async () => {
    const fixture = await claimedMovingFixture('moving-lifecycle');
    const touches: HeldRelation[] = [];
    const quoteApplication = standardizedQuoteApplication(runtimeEvidence('a'), touches);
    const quoted = await quoteApplication.prepareQuote(fixture.posterUserId, {
      taskDraftId: fixture.taskDraftId,
      expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
      expectedQuoteVersion: 0,
      idempotencyKey: `moving-quote:${randomUUID()}`,
      clientTs: Date.now(),
    });
    expect(quoted).toMatchObject({
      state: 'QUOTED',
      quote: {
        taskDraftId: fixture.taskDraftId,
        routingDecisionId: fixture.routingDecisionId,
        routingDecisionVersion: fixture.routingDecisionVersion,
        workCategoryCode: 'moving',
        priceBookMappingId: expect.any(String),
        paymentPosture: 'PAYMENT_CREATION_FROZEN',
      },
      paymentCreationFrozen: true,
      taskCreated: false,
      assignmentCreated: false,
      workOrderCreated: false,
    });
    expect(asRecord(quoted.quote.scopeSnapshot.answers)).toEqual({
      size_weight: 'light',
      access: 'ground',
      move_type: 'same',
      workers_needed: 'one',
      fragile: false,
    });
    const priceBook = await pool.query<{
      base_price_cents: number;
      policy_version: string;
    }>(
      `SELECT base_price_cents, policy_version
         FROM public.price_book
        WHERE id = $1::UUID`,
      [quoted.quote.priceBookId]
    );
    const movingPriceBook = priceBook.rows[0];
    if (!movingPriceBook) throw new Error('Exact moving Price Book row was not found.');
    expect(quoted.quote).toMatchObject({
      customerTotalCents: movingPriceBook.base_price_cents,
      pricingPolicyVersion:
        `${movingPriceBook.policy_version}:hxuv1-standardized-base-v1`,
      pricingSnapshot: {
        sourcePriceBookPolicyVersion: 'hxos-price-book-v1',
        pricingMode: 'BASE_PRICE_NO_MODIFIERS',
        scopeModifierCount: 0,
        priceBookMappingId: quoted.quote.priceBookMappingId,
        mappedServiceCellAuthorityId: SYNTHETIC_SERVICE_CELL_AUTHORITY_ID,
        mappedServiceCellAuthorityVersion: 1,
        mappedEnvironmentClass: 'local',
      },
    });

    const acceptanceApplication = standardizedQuoteApplication(runtimeEvidence('b'), touches);
    const accepted = await acceptanceApplication.acceptQuote(fixture.posterUserId, {
      taskDraftId: fixture.taskDraftId,
      quoteVersionId: quoted.quote.quoteVersionId,
      expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
      expectedQuoteVersion: 1,
      expectedAcceptanceVersion: 0,
      idempotencyKey: `moving-acceptance:${randomUUID()}`,
      clientTs: Date.now(),
    });
    const readinessApplication = standardizedQuoteApplication(runtimeEvidence('c'), touches);
    const readiness = await readinessApplication.prepareFakePaymentMethod(
      fixture.posterUserId,
      {
        taskDraftId: fixture.taskDraftId,
        acceptanceFactId: accepted.acceptance.acceptanceFactId,
        expectedQuoteVersion: 1,
        expectedReadinessVersion: 0,
        idempotencyKey: `moving-readiness:${randomUUID()}`,
        clientTs: Date.now(),
      }
    );
    expect(readiness).toMatchObject({
      state: 'FAKE_PAYMENT_METHOD_READY',
      providerKind: 'FAKE',
      networkCalled: false,
      customerMoneyCreated: false,
      authorizationCreated: false,
      assignmentCreated: false,
      workOrderCreated: false,
      settlementCreated: false,
      payoutCreated: false,
    });
    const opportunity = await pool.query<{
      public_scope: unknown;
      standardized_quote_id: string;
      fake_payment_method_ready: boolean;
    }>(
      `SELECT public_scope, standardized_quote_id, fake_payment_method_ready
         FROM public.current_universal_v1_task_opportunities_v1
        WHERE task_draft_id = $1::UUID`,
      [fixture.taskDraftId]
    );
    expect(opportunity.rows).toHaveLength(1);
    expect(opportunity.rows[0]).toMatchObject({
      standardized_quote_id: quoted.quote.quoteVersionId,
      fake_payment_method_ready: true,
    });
    expect(asRecord(asRecord(opportunity.rows[0]?.public_scope)?.answers)).toEqual({
      size_weight: 'light',
      access: 'ground',
      move_type: 'same',
      workers_needed: 'one',
      fragile: false,
    });
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual({
      quotes: 1,
      acceptances: 1,
      readiness: 1,
    });
    expect(touches).toEqual([]);
  }, 60_000);

  it('rejects a moving price modifier added after its fulfillment route', async () => {
    const fixture = await claimedMovingFixture('moving-post-route-modifier');
    await pool.query(
      `UPDATE public.task_drafts
          SET structured = jsonb_set(
            structured,
            '{answers,size_weight}',
            to_jsonb('medium'::TEXT),
            FALSE
          )
        WHERE id = $1::UUID`,
      [fixture.taskDraftId]
    );
    const touches: HeldRelation[] = [];
    const application = standardizedQuoteApplication(runtimeEvidence('d'), touches);
    await expect(
      application.prepareQuote(fixture.posterUserId, {
        taskDraftId: fixture.taskDraftId,
        expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
        expectedQuoteVersion: 0,
        idempotencyKey: `moving-modifier:${randomUUID()}`,
        clientTs: Date.now(),
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual({
      quotes: 0,
      acceptances: 0,
      readiness: 0,
    });
    expect(touches).toEqual([]);
  }, 60_000);

  it('rejects moving access drift and malformed access added after its fulfillment route', async () => {
    const fixture = await claimedMovingFixture('moving-post-route-access-drift');
    const touches: HeldRelation[] = [];
    const application = standardizedQuoteApplication(runtimeEvidence('e'), touches);

    for (const access of ['stairs', ['ground'], 0] as const) {
      await pool.query(
        `UPDATE public.task_drafts
            SET structured = jsonb_set(
              structured,
              '{answers,access}',
              $2::JSONB,
              FALSE
            )
          WHERE id = $1::UUID`,
        [fixture.taskDraftId, JSON.stringify(access)]
      );
      await expect(
        application.prepareQuote(fixture.posterUserId, {
          taskDraftId: fixture.taskDraftId,
          expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
          expectedQuoteVersion: 0,
          idempotencyKey: `moving-access-drift:${randomUUID()}`,
          clientTs: Date.now(),
        })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    }

    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual({
      quotes: 0,
      acceptances: 0,
      readiness: 0,
    });
    expect(touches).toEqual([]);
  }, 60_000);

  it('runs furniture assembly through quote, acceptance, readiness v1 and v2 without HOLD access', async () => {
    const fixture = await claimedFurnitureAssemblyFixture('renewable-readiness');
    const heldBefore = await heldCounts();
    const quoteTouches: HeldRelation[] = [];
    const quoteInput = {
      taskDraftId: fixture.taskDraftId,
      expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
      expectedQuoteVersion: 0,
      idempotencyKey: `standardized-quote:${randomUUID()}`,
      clientTs: Date.now(),
    };
    const quoteApplication = standardizedQuoteApplication(runtimeEvidence('1'), quoteTouches);
    const quoted = await quoteApplication.prepareQuote(fixture.posterUserId, quoteInput);
    expect(quoted).toMatchObject({
      state: 'QUOTED',
      quote: {
        taskDraftId: fixture.taskDraftId,
        routingDecisionId: fixture.routingDecisionId,
        routingDecisionVersion: fixture.routingDecisionVersion,
        quoteVersion: 1,
        workCategoryCode: 'furniture_assembly',
        priceBookMappingId: expect.any(String),
        currency: 'usd',
        paymentPosture: 'PAYMENT_CREATION_FROZEN',
        issuanceEvidence: runtimeEvidence('1'),
      },
      paymentCreationFrozen: true,
      taskCreated: false,
      assignmentCreated: false,
      workOrderCreated: false,
    });
    const sourceScope = await pool.query<{
      scope_summary: string;
      source_answers: unknown;
      source_structured: unknown;
    }>(
      `SELECT scope_summary,
              structured -> 'answers' AS source_answers,
              structured AS source_structured
         FROM public.task_drafts
        WHERE id = $1::UUID`,
      [fixture.taskDraftId]
    );
    const sourceAnswers = asRecord(sourceScope.rows[0]?.source_answers);
    expect(sourceAnswers).not.toBeNull();
    for (const [key, marker] of Object.entries(fixture.excludedFreeFormMarkers)) {
      expect(sourceAnswers?.[key]).toBe(marker);
    }
    const sourceStructured = asRecord(sourceScope.rows[0]?.source_structured);
    expect(sourceStructured).not.toBeNull();
    expect(sourceStructured?.required_skills).toEqual([
      fixture.excludedMutableCarrierMarkers.required_skills,
    ]);
    expect(sourceStructured?.required_tools).toEqual([
      fixture.excludedMutableCarrierMarkers.required_tools,
    ]);
    expect(sourceStructured?.labor_label).toBe(
      fixture.excludedMutableCarrierMarkers.labor_label
    );
    expect(sourceScope.rows[0]?.scope_summary).toContain(fixture.rawScopeSecret);
    const quoteScope = quoted.quote.scopeSnapshot;
    const quoteAnswers = asRecord(quoteScope.answers);
    expect(Object.hasOwn(quoteScope, 'scopeSummary')).toBe(false);
    expect(quoteAnswers).not.toBeNull();
    expect(Object.hasOwn(quoteAnswers!, 'access')).toBe(false);
    const serializedQuoteScope = JSON.stringify(quoteScope);
    expect(serializedQuoteScope).not.toContain(fixture.rawScopeSecret);
    for (const [key, marker] of Object.entries(fixture.excludedFreeFormMarkers)) {
      expect(Object.hasOwn(quoteAnswers!, key)).toBe(false);
      expect(serializedQuoteScope).not.toContain(marker);
    }
    for (const [key, marker] of Object.entries(fixture.excludedMutableCarrierMarkers)) {
      const providerKey = key === 'required_skills'
        ? 'requiredSkills'
        : key === 'required_tools'
          ? 'requiredTools'
          : 'laborLabel';
      expect(Object.hasOwn(quoteScope, providerKey)).toBe(false);
      expect(serializedQuoteScope).not.toContain(marker);
    }
    expect(quoteAnswers).toEqual({
      assembly_scope_class: 'STANDARD_SINGLE_FLAT_PACK_ITEM_V1',
      item_count_class: 'one',
      new_in_box: true,
      old_item_removal: false,
      tools_included: true,
    });

    const pricing = await pool.query<{
      base_price_cents: number;
      min_hustler_payout_cents: number;
      platform_margin_floor_pct: string;
      policy_version: string;
    }>(
      `SELECT base_price_cents, min_hustler_payout_cents,
              platform_margin_floor_pct::TEXT AS platform_margin_floor_pct,
              policy_version
         FROM public.price_book
        WHERE id = $1::UUID`,
      [quoted.quote.priceBookId]
    );
    const priceBook = pricing.rows[0];
    if (!priceBook) throw new Error('Exact standardized Price Book row was not found.');
    const marginFloorBps = Math.round(Number(priceBook.platform_margin_floor_pct) * 100);
    const computedProviderPayoutCents = Math.floor(
      (priceBook.base_price_cents * (10_000 - marginFloorBps)) / 10_000
    );
    expect(quoted.quote).toMatchObject({
      customerTotalCents: priceBook.base_price_cents,
      providerPayoutCents: computedProviderPayoutCents,
      platformMarginCents: priceBook.base_price_cents - computedProviderPayoutCents,
      pricingPolicyVersion:
        `${priceBook.policy_version}:hxuv1-standardized-base-v1`,
      pricingSnapshot: {
        policyVersion: `${priceBook.policy_version}:hxuv1-standardized-base-v1`,
        sourcePriceBookPolicyVersion: priceBook.policy_version,
        pricingMode: 'BASE_PRICE_NO_MODIFIERS',
        scopeModifierCount: 0,
        priceBookMappingId: quoted.quote.priceBookMappingId,
        mappedServiceCellAuthorityId: SYNTHETIC_SERVICE_CELL_AUTHORITY_ID,
        mappedServiceCellAuthorityVersion: 1,
        mappedEnvironmentClass: 'local',
        providerPayoutCents: computedProviderPayoutCents,
        platformMarginFloorBps: marginFloorBps,
      },
    });
    expect(computedProviderPayoutCents).toBeGreaterThan(
      priceBook.min_hustler_payout_cents
    );
    expect(
      (priceBook.base_price_cents - computedProviderPayoutCents) * 10_000
    ).toBeGreaterThanOrEqual(priceBook.base_price_cents * marginFloorBps);
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual({
      quotes: 1,
      acceptances: 0,
      readiness: 0,
    });
    await expect(
      pool.query(
        `SELECT 1 FROM public.current_universal_v1_task_opportunities_v1
          WHERE task_draft_id = $1::UUID`,
        [fixture.taskDraftId]
      )
    ).resolves.toMatchObject({ rowCount: 0 });

    const acceptanceInput = {
      taskDraftId: fixture.taskDraftId,
      quoteVersionId: quoted.quote.quoteVersionId,
      expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
      expectedQuoteVersion: 1,
      expectedAcceptanceVersion: 0 as const,
      idempotencyKey: `standardized-accept:${randomUUID()}`,
      clientTs: Date.now(),
    };
    const acceptanceApplication = standardizedQuoteApplication(runtimeEvidence('2'), quoteTouches);
    const accepted = await acceptanceApplication.acceptQuote(
      fixture.posterUserId,
      acceptanceInput
    );
    expect(accepted).toMatchObject({
      state: 'ACCEPTED',
      acceptance: {
        quoteVersionId: quoted.quote.quoteVersionId,
        quoteVersion: 1,
        pricingSha256: quoted.quote.pricingSha256,
        acceptedByUserId: fixture.posterUserId,
        commandEvidence: runtimeEvidence('2'),
      },
      paymentCreationCreated: false,
      financialSecurityEventCreated: false,
      assignmentCreated: false,
      workOrderCreated: false,
    });

    const readinessV1Input = {
      taskDraftId: fixture.taskDraftId,
      acceptanceFactId: accepted.acceptance.acceptanceFactId,
      expectedQuoteVersion: 1,
      expectedReadinessVersion: 0,
      idempotencyKey: `fake-readiness-v1:${randomUUID()}`,
      clientTs: Date.now(),
    };
    const readinessV1Application = standardizedQuoteApplication(runtimeEvidence('3'), quoteTouches);
    const readinessV1 = await readinessV1Application.prepareFakePaymentMethod(
      fixture.posterUserId,
      readinessV1Input
    );
    expect(readinessV1).toMatchObject({
      state: 'FAKE_PAYMENT_METHOD_READY',
      readiness: {
        readinessVersion: 1,
        quoteVersion: 1,
        providerKind: 'FAKE',
        commandEvidence: runtimeEvidence('3'),
      },
      providerKind: 'FAKE',
      networkCalled: false,
      externalValueCreated: false,
      customerMoneyCreated: false,
      authorizationCreated: false,
      financialSecurityEventCreated: false,
      captureCreated: false,
      assignmentCreated: false,
      workOrderCreated: false,
      settlementCreated: false,
      payoutCreated: false,
    });

    const readinessV2Input = {
      taskDraftId: fixture.taskDraftId,
      acceptanceFactId: accepted.acceptance.acceptanceFactId,
      expectedQuoteVersion: 1,
      expectedReadinessVersion: 1,
      idempotencyKey: `fake-readiness-v2:${randomUUID()}`,
      clientTs: Date.now(),
    };
    const readinessV2Application = standardizedQuoteApplication(runtimeEvidence('4'), quoteTouches);
    const readinessV2 = await readinessV2Application.prepareFakePaymentMethod(
      fixture.posterUserId,
      readinessV2Input
    );
    expect(readinessV2).toMatchObject({
      state: 'FAKE_PAYMENT_METHOD_READY',
      readiness: {
        readinessVersion: 2,
        commandEvidence: runtimeEvidence('4'),
      },
    });
    expect(readinessV2.fakePaymentMethodReference).not.toBe(
      readinessV1.fakePaymentMethodReference
    );
    expect(
      Date.parse(readinessV1.readiness.expiresAt) -
        Date.parse(readinessV1.readiness.createdAt)
    ).toBe(30 * 60 * 1000);
    expect(
      Date.parse(readinessV2.readiness.expiresAt) -
        Date.parse(readinessV2.readiness.createdAt)
    ).toBe(30 * 60 * 1000);

    const replayedV1 = await readinessV1Application.prepareFakePaymentMethod(
      fixture.posterUserId,
      readinessV1Input
    );
    expect(replayedV1).toMatchObject({
      idempotencyReplayed: true,
      readiness: {
        readinessFactId: readinessV1.readiness.readinessFactId,
        readinessVersion: 1,
        currentStatus: 'SUPERSEDED',
        isCurrent: false,
      },
      state: 'FAKE_PAYMENT_METHOD_SUPERSEDED',
      renewalRequired: false,
    });
    const replayedV2 = await readinessV2Application.prepareFakePaymentMethod(
      fixture.posterUserId,
      readinessV2Input
    );
    expect(replayedV2).toMatchObject({
      idempotencyReplayed: true,
      readiness: {
        readinessFactId: readinessV2.readiness.readinessFactId,
        readinessVersion: 2,
        currentStatus: 'CURRENT',
        isCurrent: true,
      },
    });
    const beforeDivergentReplay = await lifecycleCounts(fixture.taskDraftId);
    await expect(
      readinessV1Application.prepareFakePaymentMethod(fixture.posterUserId, {
        ...readinessV1Input,
        expectedReadinessVersion: 1,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual(beforeDivergentReplay);

    // The database owns the 30-minute expiry. A system test must not disable
    // append-only authority to forge wall-clock expiry, so prove both the exact
    // TTL/current-head replay semantics and that expiry itself cannot be edited.
    const beforeExpiryMutation = await lifecycleCounts(fixture.taskDraftId);
    await expect(
      pool.query(
        `UPDATE public.task_draft_payment_method_readiness_facts
            SET expires_at = clock_timestamp() - interval '1 second'
          WHERE id = $1::UUID`,
        [readinessV2.readiness.readinessFactId]
      )
    ).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining(
        'standardized pricing mappings, quotes, acceptances, and readiness facts are append-only'
      ),
    });
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual(beforeExpiryMutation);

    const current = await readinessV2Application.getCurrent(fixture.posterUserId, {
      taskDraftId: fixture.taskDraftId,
    });
    expect(current).toMatchObject({
      quote: {
        quoteVersionId: quoted.quote.quoteVersionId,
        quoteVersion: 1,
        issuanceEvidence: runtimeEvidence('1'),
      },
      acceptance: {
        acceptanceFactId: accepted.acceptance.acceptanceFactId,
        pricingSha256: quoted.quote.pricingSha256,
        commandEvidence: runtimeEvidence('2'),
      },
      readiness: {
        readinessFactId: readinessV2.readiness.readinessFactId,
        readinessVersion: 2,
        commandEvidence: runtimeEvidence('4'),
        isCurrent: true,
      },
      routingCurrent: true,
      acceptanceOpen: false,
      priceLocked: true,
      fakePaymentMethodReady: true,
      actionableState: 'READY_FOR_PROVIDER_DISCOVERY',
    });

    const predecessorChain = await pool.query<{
      id: string;
      readiness_version: number;
      supersedes_readiness_fact_id: string | null;
      is_chain_head: boolean;
    }>(
      `SELECT readiness.id, readiness.readiness_version,
              readiness.supersedes_readiness_fact_id,
              NOT EXISTS (
                SELECT 1
                  FROM public.task_draft_payment_method_readiness_facts successor
                 WHERE successor.supersedes_readiness_fact_id = readiness.id
              ) AS is_chain_head
         FROM public.task_draft_payment_method_readiness_facts readiness
        WHERE readiness.task_draft_id = $1::UUID
        ORDER BY readiness.readiness_version`,
      [fixture.taskDraftId]
    );
    expect(predecessorChain.rows).toEqual([
      {
        id: readinessV1.readiness.readinessFactId,
        readiness_version: 1,
        supersedes_readiness_fact_id: null,
        is_chain_head: false,
      },
      {
        id: readinessV2.readiness.readinessFactId,
        readiness_version: 2,
        supersedes_readiness_fact_id: readinessV1.readiness.readinessFactId,
        is_chain_head: true,
      },
    ]);
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual({
      quotes: 1,
      acceptances: 1,
      readiness: 2,
    });
    expect(quoteTouches).toEqual([]);

    const opportunity = await pool.query<{
      opportunity_id: string;
      opportunity_version: number;
      standardized_quote_id: string;
      standardized_quote_version: number;
      standardized_scope_artifact_id: string;
      fake_payment_method_ready: boolean;
      payment_method_readiness_posture: string;
    }>(
      `SELECT opportunity_id, opportunity_version, standardized_quote_id,
              standardized_quote_version, standardized_scope_artifact_id,
              fake_payment_method_ready, payment_method_readiness_posture
         FROM public.current_universal_v1_task_opportunities_v1
        WHERE task_draft_id = $1::UUID`,
      [fixture.taskDraftId]
    );
    expect(opportunity.rows).toHaveLength(1);
    expect(opportunity.rows[0]).toMatchObject({
      standardized_quote_id: quoted.quote.quoteVersionId,
      standardized_quote_version: 1,
      standardized_scope_artifact_id: quoted.quote.quoteVersionId,
      fake_payment_method_ready: true,
      payment_method_readiness_posture: 'FAKE_PAYMENT_METHOD_READY_NO_FINANCIAL_EFFECT',
    });

    const providerUserId = await generalProviderFixture();
    const providerTouches: HeldRelation[] = [];
    const providerService = opportunityService(providerTouches);
    const browse = await providerService.browse(providerContext(providerUserId), {
      serviceCellAuthorityId: SYNTHETIC_SERVICE_CELL_AUTHORITY_ID,
      workCategoryCode: 'furniture_assembly',
      limit: 100,
      offset: 0,
    });
    expect(browse).toMatchObject({ state: 'READY' });
    const providerArtifact = browse.opportunities.find(
      (candidate) => candidate.taskDraftId === fixture.taskDraftId
    );
    expect(providerArtifact).toBeDefined();
    const providerPublicScope = asRecord(providerArtifact?.publicScope);
    const providerPublicAnswers = asRecord(providerPublicScope?.answers);
    expect(providerPublicScope).not.toBeNull();
    expect(providerArtifact?.scopeArtifact).toEqual(
      providerArtifact?.standardizedQuote?.scopeArtifact
    );
    expect(providerArtifact?.interestScopeArtifact).toMatchObject({
      kind: 'TASK_DRAFT_ROUTE_CONTEXT_V1',
      id: fixture.routingDecisionId,
      version: fixture.routingDecisionVersion,
    });
    expect(providerArtifact?.privacyPosture).toBe('STANDARDIZED_SCOPE_ALLOWLIST_ONLY');
    expect(providerPublicScope).toMatchObject({
      scopeArtifactKind: providerArtifact?.scopeArtifact.kind,
      scopeArtifactId: providerArtifact?.scopeArtifact.id,
      scopeArtifactVersion: providerArtifact?.scopeArtifact.version,
    });
    expect(Object.hasOwn(providerPublicScope!, 'scopeSummary')).toBe(false);
    expect(providerPublicAnswers).not.toBeNull();
    expect(Object.hasOwn(providerPublicAnswers!, 'access')).toBe(false);
    const serializedProviderScope = JSON.stringify(providerPublicScope);
    expect(serializedProviderScope).not.toContain(fixture.rawScopeSecret);
    for (const [key, marker] of Object.entries(fixture.excludedFreeFormMarkers)) {
      expect(Object.hasOwn(providerPublicAnswers!, key)).toBe(false);
      expect(serializedProviderScope).not.toContain(marker);
    }
    for (const [key, marker] of Object.entries(fixture.excludedMutableCarrierMarkers)) {
      const providerKey = key === 'required_skills'
        ? 'requiredSkills'
        : key === 'required_tools'
          ? 'requiredTools'
          : 'laborLabel';
      expect(Object.hasOwn(providerPublicScope!, providerKey)).toBe(false);
      expect(serializedProviderScope).not.toContain(marker);
    }
    expect(providerPublicAnswers).toEqual({
      assembly_scope_class: 'STANDARD_SINGLE_FLAT_PACK_ITEM_V1',
      item_count_class: 'one',
      new_in_box: true,
      old_item_removal: false,
      tools_included: true,
    });

    // Provider visibility must track the same actionable-Poster boundary as
    // readiness authority. A later ban cannot leave an accepted and prepared
    // fulfillment opportunity visible through the provider view.
    await pool.query(
      `UPDATE public.users SET is_banned = TRUE WHERE id = $1::UUID`,
      [fixture.posterUserId]
    );
    try {
      await expect(
        pool.query(
          `SELECT 1 FROM public.current_universal_v1_task_opportunities_v1
            WHERE task_draft_id = $1::UUID`,
          [fixture.taskDraftId]
        )
      ).resolves.toMatchObject({ rowCount: 0 });
      const hiddenBrowse = await providerService.browse(providerContext(providerUserId), {
        serviceCellAuthorityId: SYNTHETIC_SERVICE_CELL_AUTHORITY_ID,
        workCategoryCode: 'furniture_assembly',
        limit: 100,
        offset: 0,
      });
      expect(
        hiddenBrowse.opportunities.some(
          (candidate) => candidate.taskDraftId === fixture.taskDraftId
        )
      ).toBe(false);
      await expect(
        readinessV2Application.prepareFakePaymentMethod(
          fixture.posterUserId,
          readinessV2Input
        )
      ).resolves.toMatchObject({
        idempotencyReplayed: true,
        state: 'FAKE_PAYMENT_METHOD_ROUTE_REVIEW_REQUIRED',
        readiness: {
          currentStatus: 'ROUTE_REVIEW_REQUIRED',
          isCurrent: false,
        },
        renewalRequired: false,
        routeReviewRequired: true,
      });
    } finally {
      await pool.query(
        `UPDATE public.users SET is_banned = FALSE WHERE id = $1::UUID`,
        [fixture.posterUserId]
      );
    }
    await expect(
      pool.query(
        `SELECT 1 FROM public.current_universal_v1_task_opportunities_v1
          WHERE task_draft_id = $1::UUID`,
        [fixture.taskDraftId]
      )
    ).resolves.toMatchObject({ rowCount: 1 });

    const heldBeforeInterest = await heldCounts();
    const providerInterestService = new UniversalV1TaskOpportunityService({
      query: async <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await pool.query(sql, params);
        return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
      },
      transaction,
    });
    await expect(
      providerInterestService.expressInterest(providerContext(providerUserId), {
        opportunityId: opportunity.rows[0]!.opportunity_id,
        expectedOpportunityVersion: opportunity.rows[0]!.opportunity_version,
        idempotencyKey: `general-interest-ready:${randomUUID()}`,
      })
    ).resolves.toMatchObject({
      routing: { outcome: 'FULFILLMENT_CANDIDATE' },
      reservationCreated: false,
      eligibilityDecisionCreated: false,
      assignmentCreated: false,
      addressContactAccessGranted: false,
      financialEventCreated: false,
      payableCreated: false,
      guaranteedEarning: false,
    });
    expect(providerTouches).toEqual([]);
    const heldAfterInterest = await heldCounts();
    expect(heldAfterInterest.task_applications).toBe(
      heldBeforeInterest.task_applications + 1
    );
    expect({ ...heldAfterInterest, task_applications: heldBeforeInterest.task_applications })
      .toEqual(heldBeforeInterest);
    expect({ ...heldAfterInterest, task_applications: heldBefore.task_applications })
      .toEqual(heldBefore);

    // The production fact remains immutable and owns a 30-minute TTL. In this
    // disposable hx_ci database only, install a one-row short-expiry fixture by
    // disabling user triggers transaction-locally, then prove real elapsed
    // clock time removes provider visibility and makes exact replay noncurrent.
    const expiryFixtureClient = await pool.connect();
    try {
      await expiryFixtureClient.query('BEGIN');
      await expiryFixtureClient.query("SET LOCAL session_replication_role = 'replica'");
      await expiryFixtureClient.query(
        `UPDATE public.task_draft_payment_method_readiness_facts
            SET expires_at = clock_timestamp() + interval '250 milliseconds'
          WHERE id = $1::UUID`,
        [readinessV2.readiness.readinessFactId]
      );
      await expiryFixtureClient.query('COMMIT');
    } catch (error) {
      await expiryFixtureClient.query('ROLLBACK');
      throw error;
    } finally {
      expiryFixtureClient.release();
    }
    await pool.query('SELECT pg_sleep(0.4)');
    await expect(
      quoteApplication.getCurrent(fixture.posterUserId, { taskDraftId: fixture.taskDraftId })
    ).resolves.toMatchObject({
      readiness: {
        readinessFactId: readinessV2.readiness.readinessFactId,
        currentStatus: 'EXPIRED',
        isCurrent: false,
      },
      fakePaymentMethodReady: false,
      actionableState: 'PREPARE_OR_RENEW_FAKE_PAYMENT_METHOD',
    });
    await expect(
      readinessV2Application.prepareFakePaymentMethod(
        fixture.posterUserId,
        readinessV2Input
      )
    ).resolves.toMatchObject({
      idempotencyReplayed: true,
      readiness: {
        readinessFactId: readinessV2.readiness.readinessFactId,
        currentStatus: 'EXPIRED',
        isCurrent: false,
      },
      renewalRequired: true,
      routeReviewRequired: false,
    });
    await expect(
      pool.query(
        `SELECT 1 FROM public.current_universal_v1_task_opportunities_v1
          WHERE task_draft_id = $1::UUID`,
        [fixture.taskDraftId]
      )
    ).resolves.toMatchObject({ rowCount: 0 });

    // A committed replay remains historical evidence after the owning draft
    // closes, but must not regain READY/renewal authority. This status change
    // is installed only in the disposable hx_ci database because production
    // lifecycle transitions are independently guarded.
    const closedDraftFixture = await pool.connect();
    try {
      await closedDraftFixture.query('BEGIN');
      await closedDraftFixture.query("SET LOCAL session_replication_role = 'replica'");
      await closedDraftFixture.query(
        `UPDATE public.task_drafts SET status = 'closed_system_test'
          WHERE id = $1::UUID`,
        [fixture.taskDraftId]
      );
      await closedDraftFixture.query('COMMIT');
    } catch (error) {
      await closedDraftFixture.query('ROLLBACK');
      throw error;
    } finally {
      closedDraftFixture.release();
    }
    await expect(
      readinessV2Application.prepareFakePaymentMethod(
        fixture.posterUserId,
        readinessV2Input
      )
    ).resolves.toMatchObject({
      state: 'FAKE_PAYMENT_METHOD_ROUTE_REVIEW_REQUIRED',
      readiness: {
        currentStatus: 'ROUTE_REVIEW_REQUIRED',
        isCurrent: false,
      },
      renewalRequired: false,
      routeReviewRequired: true,
    });
  }, 60_000);

  it('preserves exact quote predecessor and current-head semantics before acceptance', async () => {
    const fixture = await claimedFurnitureAssemblyFixture('quote-predecessor');
    const touches: HeldRelation[] = [];
    const application = standardizedQuoteApplication(runtimeEvidence('5'), touches);
    const quoteV1Input = {
      taskDraftId: fixture.taskDraftId,
      expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
      expectedQuoteVersion: 0,
      idempotencyKey: `quote-predecessor-v1:${randomUUID()}`,
      clientTs: Date.now(),
    };
    const quoteV1 = await application.prepareQuote(fixture.posterUserId, quoteV1Input);
    const quoteV2 = await application.prepareQuote(fixture.posterUserId, {
      ...quoteV1Input,
      expectedQuoteVersion: 1,
      idempotencyKey: `quote-predecessor-v2:${randomUUID()}`,
      clientTs: Date.now(),
    });
    const chain = await pool.query<{
      id: string;
      quote_version: number;
      supersedes_quote_version_id: string | null;
      is_chain_head: boolean;
    }>(
      `SELECT quote.id, quote.quote_version, quote.supersedes_quote_version_id,
              NOT EXISTS (
                SELECT 1
                  FROM public.task_draft_standardized_quote_versions successor
                 WHERE successor.supersedes_quote_version_id = quote.id
              ) AS is_chain_head
         FROM public.task_draft_standardized_quote_versions quote
        WHERE quote.task_draft_id = $1::UUID
        ORDER BY quote.quote_version`,
      [fixture.taskDraftId]
    );
    expect(chain.rows).toEqual([
      {
        id: quoteV1.quote.quoteVersionId,
        quote_version: 1,
        supersedes_quote_version_id: null,
        is_chain_head: false,
      },
      {
        id: quoteV2.quote.quoteVersionId,
        quote_version: 2,
        supersedes_quote_version_id: quoteV1.quote.quoteVersionId,
        is_chain_head: true,
      },
    ]);
    await expect(
      application.getCurrent(fixture.posterUserId, { taskDraftId: fixture.taskDraftId })
    ).resolves.toMatchObject({
      quote: { quoteVersionId: quoteV2.quote.quoteVersionId, quoteVersion: 2 },
      acceptance: null,
      readiness: null,
      routingCurrent: true,
      acceptanceOpen: true,
      priceLocked: false,
      fakePaymentMethodReady: false,
      actionableState: 'ACCEPT_QUOTE',
    });
    await expect(application.prepareQuote(fixture.posterUserId, quoteV1Input)).resolves.toMatchObject(
      {
        idempotencyReplayed: true,
        quote: { quoteVersionId: quoteV1.quote.quoteVersionId, quoteVersion: 1 },
      }
    );
    expect(touches).toEqual([]);
  }, 60_000);

  it('rejects acceptance after a real elapsed quote-expiry boundary', async () => {
    const fixture = await claimedFurnitureAssemblyFixture('elapsed-quote-expiry');
    const touches: HeldRelation[] = [];
    const application = standardizedQuoteApplication(runtimeEvidence('e'), touches);
    const quote = await application.prepareQuote(fixture.posterUserId, {
      taskDraftId: fixture.taskDraftId,
      expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
      expectedQuoteVersion: 0,
      idempotencyKey: `elapsed-expiry-quote:${randomUUID()}`,
      clientTs: Date.now(),
    });

    const expiryFixtureClient = await pool.connect();
    try {
      await expiryFixtureClient.query('BEGIN');
      await expiryFixtureClient.query("SET LOCAL session_replication_role = 'replica'");
      await expiryFixtureClient.query(
        `UPDATE public.task_draft_standardized_quote_versions
            SET valid_until = clock_timestamp() + interval '250 milliseconds'
          WHERE id = $1::UUID`,
        [quote.quote.quoteVersionId]
      );
      await expiryFixtureClient.query('COMMIT');
    } catch (error) {
      await expiryFixtureClient.query('ROLLBACK');
      throw error;
    } finally {
      expiryFixtureClient.release();
    }
    await pool.query('SELECT pg_sleep(0.4)');

    await expect(
      application.getCurrent(fixture.posterUserId, { taskDraftId: fixture.taskDraftId })
    ).resolves.toMatchObject({
      quote: { quoteVersionId: quote.quote.quoteVersionId },
      acceptance: null,
      acceptanceOpen: false,
      priceLocked: false,
      actionableState: 'REQUOTE_OR_REVIEW_ROUTE',
    });
    const beforeRejectedAcceptance = await lifecycleCounts(fixture.taskDraftId);
    await expect(
      application.acceptQuote(fixture.posterUserId, {
        taskDraftId: fixture.taskDraftId,
        quoteVersionId: quote.quote.quoteVersionId,
        expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
        expectedQuoteVersion: 1,
        expectedAcceptanceVersion: 0,
        idempotencyKey: `elapsed-expiry-accept:${randomUUID()}`,
        clientTs: Date.now(),
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual(beforeRejectedAcceptance);
    expect(touches).toEqual([]);
  }, 60_000);

  it('lets exactly one of quote supersession or acceptance win the lifecycle race', async () => {
    const fixture = await claimedFurnitureAssemblyFixture('supersede-accept-race');
    const touches: HeldRelation[] = [];
    const application = standardizedQuoteApplication(runtimeEvidence('6'), touches);
    const quoteV1 = await application.prepareQuote(fixture.posterUserId, {
      taskDraftId: fixture.taskDraftId,
      expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
      expectedQuoteVersion: 0,
      idempotencyKey: `race-quote-v1:${randomUUID()}`,
      clientTs: Date.now(),
    });
    const clientTs = Date.now();
    const raced = await Promise.allSettled([
      application.acceptQuote(fixture.posterUserId, {
        taskDraftId: fixture.taskDraftId,
        quoteVersionId: quoteV1.quote.quoteVersionId,
        expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
        expectedQuoteVersion: 1,
        expectedAcceptanceVersion: 0,
        idempotencyKey: `race-accept-v1:${randomUUID()}`,
        clientTs,
      }),
      application.prepareQuote(fixture.posterUserId, {
        taskDraftId: fixture.taskDraftId,
        expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
        expectedQuoteVersion: 1,
        idempotencyKey: `race-quote-v2:${randomUUID()}`,
        clientTs,
      }),
    ]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = raced.find((result) => result.status === 'rejected');
    if (!rejected || rejected.status !== 'rejected') {
      throw new Error('The supersede-versus-accept race returned no rejected contender.');
    }
    expect(['CONFLICT', 'PRECONDITION_FAILED']).toContain(errorCode(rejected.reason));

    const counts = await lifecycleCounts(fixture.taskDraftId);
    expect(counts.quotes + counts.acceptances).toBe(2);
    expect(counts.readiness).toBe(0);
    const current = await application.getCurrent(fixture.posterUserId, {
      taskDraftId: fixture.taskDraftId,
    });
    if (counts.acceptances === 1) {
      expect(counts.quotes).toBe(1);
      expect(current).toMatchObject({
        quote: { quoteVersionId: quoteV1.quote.quoteVersionId, quoteVersion: 1 },
        acceptance: { quoteVersionId: quoteV1.quote.quoteVersionId },
        priceLocked: true,
        acceptanceOpen: false,
        actionableState: 'PREPARE_OR_RENEW_FAKE_PAYMENT_METHOD',
      });
    } else {
      expect(counts).toMatchObject({ quotes: 2, acceptances: 0 });
      expect(current).toMatchObject({
        quote: { quoteVersion: 2 },
        acceptance: null,
        priceLocked: false,
        acceptanceOpen: true,
        actionableState: 'ACCEPT_QUOTE',
      });
    }
    expect(touches).toEqual([]);
  }, 60_000);

  it('rejects readiness after exact accepted-route drift without appending a fact', async () => {
    const fixture = await claimedFurnitureAssemblyFixture('post-accept-route-drift');
    const touches: HeldRelation[] = [];
    const application = standardizedQuoteApplication(runtimeEvidence('9'), touches);
    const quote = await application.prepareQuote(fixture.posterUserId, {
      taskDraftId: fixture.taskDraftId,
      expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
      expectedQuoteVersion: 0,
      idempotencyKey: `route-drift-quote:${randomUUID()}`,
      clientTs: Date.now(),
    });
    const accepted = await application.acceptQuote(fixture.posterUserId, {
      taskDraftId: fixture.taskDraftId,
      quoteVersionId: quote.quote.quoteVersionId,
      expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
      expectedQuoteVersion: 1,
      expectedAcceptanceVersion: 0,
      idempotencyKey: `route-drift-accept:${randomUUID()}`,
      clientTs: Date.now(),
    });
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual({
      quotes: 1,
      acceptances: 1,
      readiness: 0,
    });

    const revisedRoute = await advanceSyntheticRouteForReview(fixture.taskDraftId);
    expect(revisedRoute).toMatchObject({
      routingDecisionVersion: fixture.routingDecisionVersion + 1,
    });
    expect(revisedRoute.routingDecisionId).not.toBe(fixture.routingDecisionId);
    await expect(
      application.getCurrent(fixture.posterUserId, { taskDraftId: fixture.taskDraftId })
    ).resolves.toMatchObject({
      quote: { quoteVersionId: quote.quote.quoteVersionId, quoteVersion: 1 },
      acceptance: { acceptanceFactId: accepted.acceptance.acceptanceFactId },
      readiness: null,
      routingCurrent: false,
      acceptanceOpen: false,
      priceLocked: true,
      fakePaymentMethodReady: false,
      actionableState: 'ROUTE_REVIEW_REQUIRED_AFTER_ACCEPTANCE',
    });

    const beforeRejectedReadiness = await lifecycleCounts(fixture.taskDraftId);
    await expect(
      application.prepareFakePaymentMethod(fixture.posterUserId, {
        taskDraftId: fixture.taskDraftId,
        acceptanceFactId: accepted.acceptance.acceptanceFactId,
        expectedQuoteVersion: 1,
        expectedReadinessVersion: 0,
        idempotencyKey: `route-drift-readiness:${randomUUID()}`,
        clientTs: Date.now(),
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual(beforeRejectedReadiness);
    await expect(
      pool.query(
        `SELECT 1
           FROM public.current_universal_v1_task_opportunities_v1
          WHERE task_draft_id = $1::UUID`,
        [fixture.taskDraftId]
      )
    ).resolves.toMatchObject({ rowCount: 0 });
    expect(touches).toEqual([]);
  }, 60_000);

  it('rejects stale-origin acceptance, permits a clean requote, and hides accepted readiness after later origin succession', async () => {
    const fixture = await claimedFurnitureAssemblyFixture('relationship-origin-succession');
    const touches: HeldRelation[] = [];
    const application = standardizedQuoteApplication(runtimeEvidence('a'), touches);
    const quoteV1 = await application.prepareQuote(fixture.posterUserId, {
      taskDraftId: fixture.taskDraftId,
      expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
      expectedQuoteVersion: 0,
      idempotencyKey: `origin-quote-v1:${randomUUID()}`,
      clientTs: Date.now(),
    });
    const originV2 = await advanceRelationshipOriginForReview(fixture.taskDraftId);
    expect(originV2.relationshipOriginVersion).toBe(2);

    const beforeRejectedAcceptance = await lifecycleCounts(fixture.taskDraftId);
    await expect(
      application.acceptQuote(fixture.posterUserId, {
        taskDraftId: fixture.taskDraftId,
        quoteVersionId: quoteV1.quote.quoteVersionId,
        expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
        expectedQuoteVersion: 1,
        expectedAcceptanceVersion: 0,
        idempotencyKey: `origin-stale-accept:${randomUUID()}`,
        clientTs: Date.now(),
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual(beforeRejectedAcceptance);
    await expect(
      application.getCurrent(fixture.posterUserId, { taskDraftId: fixture.taskDraftId })
    ).resolves.toMatchObject({
      quote: { quoteVersion: 1 },
      acceptance: null,
      routingCurrent: false,
      acceptanceOpen: false,
      actionableState: 'REQUOTE_OR_REVIEW_ROUTE',
    });

    const quoteV2 = await standardizedQuoteApplication(
      runtimeEvidence('b'),
      touches
    ).prepareQuote(fixture.posterUserId, {
      taskDraftId: fixture.taskDraftId,
      expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
      expectedQuoteVersion: 1,
      idempotencyKey: `origin-quote-v2:${randomUUID()}`,
      clientTs: Date.now(),
    });
    const accepted = await standardizedQuoteApplication(
      runtimeEvidence('c'),
      touches
    ).acceptQuote(fixture.posterUserId, {
      taskDraftId: fixture.taskDraftId,
      quoteVersionId: quoteV2.quote.quoteVersionId,
      expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
      expectedQuoteVersion: 2,
      expectedAcceptanceVersion: 0,
      idempotencyKey: `origin-accept-v2:${randomUUID()}`,
      clientTs: Date.now(),
    });
    const readinessApplication = standardizedQuoteApplication(runtimeEvidence('d'), touches);
    const readinessInput = {
      taskDraftId: fixture.taskDraftId,
      acceptanceFactId: accepted.acceptance.acceptanceFactId,
      expectedQuoteVersion: 2,
      expectedReadinessVersion: 0,
      idempotencyKey: `origin-readiness-v2:${randomUUID()}`,
      clientTs: Date.now(),
    };
    await readinessApplication.prepareFakePaymentMethod(
      fixture.posterUserId,
      readinessInput
    );
    await expect(
      pool.query(
        `SELECT 1 FROM public.current_universal_v1_task_opportunities_v1
          WHERE task_draft_id = $1::UUID`,
        [fixture.taskDraftId]
      )
    ).resolves.toMatchObject({ rowCount: 1 });

    const originV3 = await advanceRelationshipOriginForReview(fixture.taskDraftId);
    expect(originV3.relationshipOriginVersion).toBe(3);
    await expect(
      pool.query(
        `SELECT 1 FROM public.current_universal_v1_task_opportunities_v1
          WHERE task_draft_id = $1::UUID`,
        [fixture.taskDraftId]
      )
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      application.getCurrent(fixture.posterUserId, { taskDraftId: fixture.taskDraftId })
    ).resolves.toMatchObject({
      quote: { quoteVersion: 2 },
      acceptance: { acceptanceFactId: accepted.acceptance.acceptanceFactId },
      routingCurrent: false,
      fakePaymentMethodReady: false,
      actionableState: 'ROUTE_REVIEW_REQUIRED_AFTER_ACCEPTANCE',
    });
    await expect(
      readinessApplication.prepareFakePaymentMethod(
        fixture.posterUserId,
        readinessInput
      )
    ).resolves.toMatchObject({
      state: 'FAKE_PAYMENT_METHOD_ROUTE_REVIEW_REQUIRED',
      readiness: {
        currentStatus: 'ROUTE_REVIEW_REQUIRED',
        isCurrent: false,
      },
      renewalRequired: false,
      routeReviewRequired: true,
    });
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual({
      quotes: 2,
      acceptances: 1,
      readiness: 1,
    });
    expect(touches).toEqual([]);
  }, 60_000);

  it('rejects mismatched actors without changing any quote, acceptance, or readiness count', async () => {
    const fixture = await claimedFurnitureAssemblyFixture('actor-mismatch');
    const touches: HeldRelation[] = [];
    const ownerApplication = standardizedQuoteApplication(runtimeEvidence('7'), touches);
    const ownerQuoteInput = {
      taskDraftId: fixture.taskDraftId,
      expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
      expectedQuoteVersion: 0,
      idempotencyKey: `actor-owner-quote:${randomUUID()}`,
      clientTs: Date.now(),
    };
    const quote = await ownerApplication.prepareQuote(fixture.posterUserId, ownerQuoteInput);
    const mismatchedPosterUserId = await userFixture('poster');
    const mismatchedApplication = standardizedQuoteApplication(runtimeEvidence('8'), touches);
    const beforeReadMismatch = await lifecycleCounts(fixture.taskDraftId);
    await expect(
      mismatchedApplication.getCurrent(mismatchedPosterUserId, {
        taskDraftId: fixture.taskDraftId,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      mismatchedApplication.prepareQuote(mismatchedPosterUserId, ownerQuoteInput)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual(beforeReadMismatch);
    const beforeAcceptanceMismatch = await lifecycleCounts(fixture.taskDraftId);
    await expect(
      mismatchedApplication.acceptQuote(mismatchedPosterUserId, {
        taskDraftId: fixture.taskDraftId,
        quoteVersionId: quote.quote.quoteVersionId,
        expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
        expectedQuoteVersion: 1,
        expectedAcceptanceVersion: 0,
        idempotencyKey: `actor-mismatch-accept:${randomUUID()}`,
        clientTs: Date.now(),
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual(beforeAcceptanceMismatch);

    const accepted = await ownerApplication.acceptQuote(fixture.posterUserId, {
      taskDraftId: fixture.taskDraftId,
      quoteVersionId: quote.quote.quoteVersionId,
      expectedRoutingDecisionVersion: fixture.routingDecisionVersion,
      expectedQuoteVersion: 1,
      expectedAcceptanceVersion: 0,
      idempotencyKey: `actor-owner-accept:${randomUUID()}`,
      clientTs: Date.now(),
    });
    const beforeReadinessMismatch = await lifecycleCounts(fixture.taskDraftId);
    await expect(
      mismatchedApplication.prepareFakePaymentMethod(mismatchedPosterUserId, {
        taskDraftId: fixture.taskDraftId,
        acceptanceFactId: accepted.acceptance.acceptanceFactId,
        expectedQuoteVersion: 1,
        expectedReadinessVersion: 0,
        idempotencyKey: `actor-mismatch-readiness:${randomUUID()}`,
        clientTs: Date.now(),
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await lifecycleCounts(fixture.taskDraftId)).toEqual(beforeReadinessMismatch);
    expect(touches).toEqual([]);
  }, 60_000);
});
