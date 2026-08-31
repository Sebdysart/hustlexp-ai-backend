import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import pg from 'pg';
import { describe, expect, it } from 'vitest';

const enabled = process.env.HX_ALLOW_TASK_DRAFT_INGRESS_PG === '1';
const describePg = enabled ? describe : describe.skip;
const databaseUrl = process.env.LOCAL_TEST_DB_URL ?? '';
const migration = readFileSync(
  resolve(
    process.cwd(),
    'backend/database/migrations/20261001_universal_v1_relationship_origin_v1.sql'
  ),
  'utf8'
);
const expectedRelationshipFunctions = [
  'bootstrap_task_draft_marketplace_relationship_origin',
  'certify_task_draft_relationship_origin_presence',
  'enforce_relationship_origin_before_routing',
  'enforce_task_draft_relationship_origin_contract',
  'enforce_universal_v1_relationship_observation',
  'enforce_universal_v1_relationship_origin',
  'ensure_universal_v1_marketplace_relationship_origin',
  'prevent_universal_v1_relationship_origin_mutation',
  'universal_v1_relationship_deterministic_uuid',
  'universal_v1_relationship_observation_digest',
  'universal_v1_relationship_origin_digest',
  'universal_v1_relationship_subject_binding',
] as const;

type OriginKind = 'PROVIDER_OS' | 'BRING_YOUR_OWN_PROVIDER';
type ObservationKind =
  | 'INITIATOR_IDENTITY_OBSERVED'
  | 'CUSTOMER_IDENTITY_OBSERVED'
  | 'CUSTOMER_CONSENT_OBSERVED'
  | 'PROVIDER_LINK_OBSERVED'
  | 'PROVIDER_CONSENT_OBSERVED';

function assertDisposableDatabase(value: string): URL {
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
      'RelationshipOrigin proof may run only from the exact disposable system database identity'
    );
  }
  return parsed;
}

function exactIdentifier(value: string): string {
  if (!/^hx_ci_relationship_[a-f0-9]{24}$/u.test(value)) {
    throw new Error('Refusing an unrecognized disposable RelationshipOrigin database identifier');
  }
  return `"${value}"`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function installCanonicalStubs(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE public.users (id UUID PRIMARY KEY);
    CREATE TABLE public.business_organizations (id UUID PRIMARY KEY);
    CREATE TABLE public.business_memberships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES public.business_organizations(id),
      user_id UUID NOT NULL REFERENCES public.users(id),
      status TEXT NOT NULL,
      UNIQUE (organization_id, user_id)
    );
    CREATE TABLE public.task_drafts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      submission_id UUID NOT NULL UNIQUE,
      card_token_hash TEXT NOT NULL UNIQUE,
      task_id UUID,
      quote_id UUID
    );
    CREATE TABLE public.task_routing_decisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_draft_id UUID NOT NULL REFERENCES public.task_drafts(id),
      evidence JSONB NOT NULL DEFAULT '{}'::JSONB
    );
  `);
}

async function insertObservation(
  pool: pg.Pool,
  input: {
    taskDraftId: string;
    originKind: OriginKind;
    observationKind: ObservationKind;
    subjectRole: 'CUSTOMER' | 'PROVIDER';
    identityBasis:
      | 'AUTHENTICATED_USER'
      | 'PRIVACY_SAFE_EXTERNAL_CUSTOMER'
      | 'PROVIDER_ORGANIZATION';
    subjectUserId?: string;
    subjectOrganizationId?: string;
    subjectBinding: string;
    observedByUserId?: string;
    consent?: boolean;
  }
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO public.universal_v1_relationship_origin_observations (
       task_draft_id, policy_version, origin_kind, observation_version,
       observation_kind, subject_role, identity_basis, subject_user_id,
       subject_organization_id, subject_binding_sha256,
       consent_contract_version, source_evidence_sha256, observed_by_user_id
     ) VALUES (
       $1, 1, $2, 1, $3, $4, $5, $6, $7, $8,
       $9, $10, $11
     ) RETURNING id`,
    [
      input.taskDraftId,
      input.originKind,
      input.observationKind,
      input.subjectRole,
      input.identityBasis,
      input.subjectUserId ?? null,
      input.subjectOrganizationId ?? null,
      input.subjectBinding,
      input.consent ? 'v1' : null,
      sha256(`evidence:${input.taskDraftId}:${input.observationKind}`),
      input.observedByUserId ?? null,
    ]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('RelationshipOrigin observation did not materialize');
  return id;
}

async function insertOrigin(
  pool: pg.Pool,
  input: {
    taskDraftId: string;
    originKind: OriginKind;
    version: number;
    supersedes?: string;
    initiator?: string;
    customerIdentity?: string;
    customerConsent?: string;
    providerLink?: string;
    providerConsent?: string;
  }
): Promise<{ id: string; routing_state: string; hold_reason_codes: string[] }> {
  const result = await pool.query<{
    id: string;
    routing_state: string;
    hold_reason_codes: string[];
  }>(
    `INSERT INTO public.universal_v1_relationship_origins (
       task_draft_id, policy_version, origin_kind, origin_version,
       supersedes_origin_id, initiator_identity_observation_id,
       customer_identity_observation_id, customer_consent_observation_id,
       provider_link_observation_id, provider_consent_observation_id
     ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, routing_state, hold_reason_codes`,
    [
      input.taskDraftId,
      input.originKind,
      input.version,
      input.supersedes ?? null,
      input.initiator ?? null,
      input.customerIdentity ?? null,
      input.customerConsent ?? null,
      input.providerLink ?? null,
      input.providerConsent ?? null,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('RelationshipOrigin did not materialize');
  return row;
}

describePg('Universal V1 RelationshipOrigin PostgreSQL authority', () => {
  it(
    'installs before fixtures and keeps Marketplace, Provider OS, and BYOP fail closed',
    async () => {
      const sourceUrl = assertDisposableDatabase(databaseUrl);
      const proofDatabaseName = `hx_ci_relationship_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const quotedProofDatabase = exactIdentifier(proofDatabaseName);
      const adminUrl = new URL(sourceUrl);
      adminUrl.pathname = '/postgres';
      const proofUrl = new URL(sourceUrl);
      proofUrl.pathname = `/${proofDatabaseName}`;
      const adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
      let proofPool: pg.Pool | null = null;
      let databaseCreated = false;

      try {
        await adminPool.query(`CREATE DATABASE ${quotedProofDatabase}`);
        databaseCreated = true;
        proofPool = new pg.Pool({ connectionString: proofUrl.toString(), max: 3 });
        await installCanonicalStubs(proofPool);

        // Engine-first install and replay both precede all business fixtures.
        await proofPool.query(migration);
        await proofPool.query(migration);
        const functionPosture = await proofPool.query<{
          function_names: string[];
          functions: number;
          fixed_search_paths: number;
          security_definers: number;
          public_executors: number;
        }>(
          `SELECT array_agg(routine.proname::TEXT ORDER BY routine.proname)::TEXT[]
                    AS function_names,
                  count(*)::INTEGER AS functions,
                  count(*) FILTER (
                    WHERE routine.proconfig @> ARRAY['search_path=pg_catalog, public']
                  )::INTEGER AS fixed_search_paths,
                  count(*) FILTER (WHERE routine.prosecdef)::INTEGER AS security_definers,
                  count(*) FILTER (
                    WHERE has_function_privilege('public', routine.oid, 'EXECUTE')
                  )::INTEGER AS public_executors
             FROM pg_proc routine
            JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
            WHERE namespace.nspname = 'public'
              AND routine.proname LIKE '%relationship%'`
        );
        expect(functionPosture.rows[0]).toEqual({
          function_names: expectedRelationshipFunctions,
          functions: 12,
          fixed_search_paths: 12,
          security_definers: 0,
          public_executors: 0,
        });
        const tablePosture = await proofPool.query<{
          table_names: string[];
          public_readers: number;
          public_writers: number;
        }>(
          `SELECT array_agg(relation.relname::TEXT ORDER BY relation.relname)::TEXT[]
                    AS table_names,
                  count(*) FILTER (
                    WHERE has_table_privilege('public', relation.oid, 'SELECT')
                  )::INTEGER AS public_readers,
                  count(*) FILTER (
                    WHERE has_table_privilege('public', relation.oid, 'INSERT')
                       OR has_table_privilege('public', relation.oid, 'UPDATE')
                       OR has_table_privilege('public', relation.oid, 'DELETE')
                       OR has_table_privilege('public', relation.oid, 'TRUNCATE')
                  )::INTEGER AS public_writers
             FROM pg_class relation
             JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relname IN (
                'universal_v1_relationship_origin_observations',
                'universal_v1_relationship_origin_policies',
                'universal_v1_relationship_origins'
              )`
        );
        expect(tablePosture.rows[0]).toEqual({
          table_names: [
            'universal_v1_relationship_origin_observations',
            'universal_v1_relationship_origin_policies',
            'universal_v1_relationship_origins',
          ],
          public_readers: 0,
          public_writers: 0,
        });
        await expect(
          proofPool.query(
            'SELECT origin_kind FROM public.universal_v1_relationship_origin_policies ORDER BY origin_kind'
          )
        ).resolves.toMatchObject({ rows: [
          { origin_kind: 'BRING_YOUR_OWN_PROVIDER' },
          { origin_kind: 'MARKETPLACE' },
          { origin_kind: 'PROVIDER_OS' },
        ] });

        const marketplaceDraft = randomUUID();
        await proofPool.query(
          `INSERT INTO public.task_drafts (
             id, submission_id, card_token_hash,
             relationship_origin_contract_version, relationship_origin_kind,
             relationship_origin_policy_version,
             relationship_origin_intake_consent_version
           ) VALUES ($1, $2, $3, 1, 'MARKETPLACE', 1, 'v1')`,
          [marketplaceDraft, randomUUID(), sha256(`card:${marketplaceDraft}`)]
        );
        const marketplaceBefore = await proofPool.query<{
          observations: number;
          origins: number;
          evidence_digest: string;
          routing_state: string;
        }>(
          `SELECT
             (SELECT count(*)::INTEGER
                FROM public.universal_v1_relationship_origin_observations
               WHERE task_draft_id = $1) AS observations,
             count(*)::INTEGER AS origins,
             max(evidence_digest)::TEXT AS evidence_digest,
             max(routing_state) AS routing_state
           FROM public.universal_v1_relationship_origins
          WHERE task_draft_id = $1`,
          [marketplaceDraft]
        );
        expect(marketplaceBefore.rows[0]).toMatchObject({
          observations: 3,
          origins: 1,
          routing_state: 'ROUTING_READY',
          evidence_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        });
        await proofPool.query(
          'SELECT public.ensure_universal_v1_marketplace_relationship_origin($1)',
          [marketplaceDraft]
        );
        const marketplaceAfter = await proofPool.query(
          `SELECT
             (SELECT count(*)::INTEGER
                FROM public.universal_v1_relationship_origin_observations
               WHERE task_draft_id = $1) AS observations,
             count(*)::INTEGER AS origins,
             max(evidence_digest)::TEXT AS evidence_digest,
             max(routing_state) AS routing_state
           FROM public.universal_v1_relationship_origins
          WHERE task_draft_id = $1`,
          [marketplaceDraft]
        );
        expect(marketplaceAfter.rows).toEqual(marketplaceBefore.rows);
        await expect(
          proofPool.query<{ evidence: Record<string, unknown> }>(
            `INSERT INTO public.task_routing_decisions(task_draft_id, evidence)
             VALUES ($1, '{"relationship_origin_kind":"FORGED"}'::JSONB)
             RETURNING evidence`,
            [marketplaceDraft]
          )
        ).resolves.toMatchObject({
          rowCount: 1,
          rows: [{ evidence: expect.objectContaining({
            relationship_origin_contract_version: 1,
            relationship_origin_kind: 'MARKETPLACE',
            relationship_origin_policy_version: 1,
            relationship_origin_version: 1,
            relationship_origin_routing_state: 'ROUTING_READY',
            relationship_origin_evidence_digest: marketplaceBefore.rows[0]?.evidence_digest,
          }) }],
        });

        const providerUser = randomUUID();
        const customerUser = randomUUID();
        await proofPool.query(
          'INSERT INTO public.users(id) VALUES ($1), ($2)',
          [providerUser, customerUser]
        );
        const providerBinding = sha256(`USER:${providerUser}`);
        const customerBinding = sha256(`USER:${customerUser}`);

        const providerOsDraft = randomUUID();
        await proofPool.query('BEGIN');
        await proofPool.query(
          `INSERT INTO public.task_drafts (
             id, submission_id, card_token_hash,
             relationship_origin_contract_version, relationship_origin_kind,
             relationship_origin_policy_version
           ) VALUES ($1, $2, $3, 1, 'PROVIDER_OS', 1)`,
          [providerOsDraft, randomUUID(), sha256(`card:${providerOsDraft}`)]
        );
        const providerOsHeld = await insertOrigin(proofPool, {
          taskDraftId: providerOsDraft,
          originKind: 'PROVIDER_OS',
          version: 1,
        });
        await proofPool.query('COMMIT');
        expect(providerOsHeld).toMatchObject({
          routing_state: 'HELD',
          hold_reason_codes: [
            'INITIATOR_IDENTITY_REQUIRED',
            'CUSTOMER_IDENTITY_REQUIRED',
            'CUSTOMER_CONSENT_REQUIRED',
            'PROVIDER_LINK_REQUIRED',
            'PROVIDER_CONSENT_REQUIRED',
          ],
        });
        await expect(
          proofPool.query(
            'INSERT INTO public.task_routing_decisions(task_draft_id) VALUES ($1)',
            [providerOsDraft]
          )
        ).rejects.toMatchObject({
          code: 'P0001',
          message: expect.stringContaining('HXUV1-REL-30'),
        });

        const providerOsInitiator = await insertObservation(proofPool, {
          taskDraftId: providerOsDraft,
          originKind: 'PROVIDER_OS',
          observationKind: 'INITIATOR_IDENTITY_OBSERVED',
          subjectRole: 'PROVIDER',
          identityBasis: 'AUTHENTICATED_USER',
          subjectUserId: providerUser,
          subjectBinding: providerBinding,
          observedByUserId: providerUser,
        });
        const externalCustomerBinding = sha256(`external-customer:${providerOsDraft}`);
        const providerOsCustomer = await insertObservation(proofPool, {
          taskDraftId: providerOsDraft,
          originKind: 'PROVIDER_OS',
          observationKind: 'CUSTOMER_IDENTITY_OBSERVED',
          subjectRole: 'CUSTOMER',
          identityBasis: 'PRIVACY_SAFE_EXTERNAL_CUSTOMER',
          subjectBinding: externalCustomerBinding,
        });
        const providerOsCustomerConsent = await insertObservation(proofPool, {
          taskDraftId: providerOsDraft,
          originKind: 'PROVIDER_OS',
          observationKind: 'CUSTOMER_CONSENT_OBSERVED',
          subjectRole: 'CUSTOMER',
          identityBasis: 'PRIVACY_SAFE_EXTERNAL_CUSTOMER',
          subjectBinding: externalCustomerBinding,
          consent: true,
        });
        const providerOsLink = await insertObservation(proofPool, {
          taskDraftId: providerOsDraft,
          originKind: 'PROVIDER_OS',
          observationKind: 'PROVIDER_LINK_OBSERVED',
          subjectRole: 'PROVIDER',
          identityBasis: 'AUTHENTICATED_USER',
          subjectUserId: providerUser,
          subjectBinding: providerBinding,
          observedByUserId: providerUser,
        });
        const providerOsConsent = await insertObservation(proofPool, {
          taskDraftId: providerOsDraft,
          originKind: 'PROVIDER_OS',
          observationKind: 'PROVIDER_CONSENT_OBSERVED',
          subjectRole: 'PROVIDER',
          identityBasis: 'AUTHENTICATED_USER',
          subjectUserId: providerUser,
          subjectBinding: providerBinding,
          observedByUserId: providerUser,
          consent: true,
        });
        const providerOsReady = await insertOrigin(proofPool, {
          taskDraftId: providerOsDraft,
          originKind: 'PROVIDER_OS',
          version: 2,
          supersedes: providerOsHeld.id,
          initiator: providerOsInitiator,
          customerIdentity: providerOsCustomer,
          customerConsent: providerOsCustomerConsent,
          providerLink: providerOsLink,
          providerConsent: providerOsConsent,
        });
        expect(providerOsReady).toMatchObject({
          routing_state: 'ROUTING_READY',
          hold_reason_codes: [],
        });
        await expect(
          proofPool.query(
            'INSERT INTO public.task_routing_decisions(task_draft_id) VALUES ($1)',
            [providerOsDraft]
          )
        ).resolves.toMatchObject({ rowCount: 1 });

        const byopDraft = randomUUID();
        await proofPool.query('BEGIN');
        await proofPool.query(
          `INSERT INTO public.task_drafts (
             id, submission_id, card_token_hash,
             relationship_origin_contract_version, relationship_origin_kind,
             relationship_origin_policy_version
           ) VALUES ($1, $2, $3, 1, 'BRING_YOUR_OWN_PROVIDER', 1)`,
          [byopDraft, randomUUID(), sha256(`card:${byopDraft}`)]
        );
        const byopInitiator = await insertObservation(proofPool, {
          taskDraftId: byopDraft,
          originKind: 'BRING_YOUR_OWN_PROVIDER',
          observationKind: 'INITIATOR_IDENTITY_OBSERVED',
          subjectRole: 'CUSTOMER',
          identityBasis: 'AUTHENTICATED_USER',
          subjectUserId: customerUser,
          subjectBinding: customerBinding,
          observedByUserId: customerUser,
        });
        const byopCustomer = await insertObservation(proofPool, {
          taskDraftId: byopDraft,
          originKind: 'BRING_YOUR_OWN_PROVIDER',
          observationKind: 'CUSTOMER_IDENTITY_OBSERVED',
          subjectRole: 'CUSTOMER',
          identityBasis: 'AUTHENTICATED_USER',
          subjectUserId: customerUser,
          subjectBinding: customerBinding,
          observedByUserId: customerUser,
        });
        const byopCustomerConsent = await insertObservation(proofPool, {
          taskDraftId: byopDraft,
          originKind: 'BRING_YOUR_OWN_PROVIDER',
          observationKind: 'CUSTOMER_CONSENT_OBSERVED',
          subjectRole: 'CUSTOMER',
          identityBasis: 'AUTHENTICATED_USER',
          subjectUserId: customerUser,
          subjectBinding: customerBinding,
          observedByUserId: customerUser,
          consent: true,
        });
        const byopLink = await insertObservation(proofPool, {
          taskDraftId: byopDraft,
          originKind: 'BRING_YOUR_OWN_PROVIDER',
          observationKind: 'PROVIDER_LINK_OBSERVED',
          subjectRole: 'PROVIDER',
          identityBasis: 'AUTHENTICATED_USER',
          subjectUserId: providerUser,
          subjectBinding: providerBinding,
          observedByUserId: providerUser,
        });
        const byopHeld = await insertOrigin(proofPool, {
          taskDraftId: byopDraft,
          originKind: 'BRING_YOUR_OWN_PROVIDER',
          version: 1,
          initiator: byopInitiator,
          customerIdentity: byopCustomer,
          customerConsent: byopCustomerConsent,
          providerLink: byopLink,
        });
        await proofPool.query('COMMIT');
        expect(byopHeld).toMatchObject({
          routing_state: 'HELD',
          hold_reason_codes: ['PROVIDER_CONSENT_REQUIRED'],
        });
        await expect(
          proofPool.query(
            'INSERT INTO public.task_routing_decisions(task_draft_id) VALUES ($1)',
            [byopDraft]
          )
        ).rejects.toMatchObject({ code: 'P0001' });
        const byopProviderConsent = await insertObservation(proofPool, {
          taskDraftId: byopDraft,
          originKind: 'BRING_YOUR_OWN_PROVIDER',
          observationKind: 'PROVIDER_CONSENT_OBSERVED',
          subjectRole: 'PROVIDER',
          identityBasis: 'AUTHENTICATED_USER',
          subjectUserId: providerUser,
          subjectBinding: providerBinding,
          observedByUserId: providerUser,
          consent: true,
        });
        const byopReady = await insertOrigin(proofPool, {
          taskDraftId: byopDraft,
          originKind: 'BRING_YOUR_OWN_PROVIDER',
          version: 2,
          supersedes: byopHeld.id,
          initiator: byopInitiator,
          customerIdentity: byopCustomer,
          customerConsent: byopCustomerConsent,
          providerLink: byopLink,
          providerConsent: byopProviderConsent,
        });
        expect(byopReady.routing_state).toBe('ROUTING_READY');

        await expect(
          proofPool.query(
            `UPDATE public.universal_v1_relationship_origins
                SET origin_kind = 'MARKETPLACE'
              WHERE id = $1`,
            [providerOsReady.id]
          )
        ).rejects.toMatchObject({
          code: 'P0001',
          message: expect.stringContaining('HXUV1-REL-1'),
        });
        await expect(
          proofPool.query(
            'DELETE FROM public.universal_v1_relationship_origin_observations WHERE id = $1',
            [providerOsConsent]
          )
        ).rejects.toMatchObject({
          code: 'P0001',
          message: expect.stringContaining('HXUV1-REL-1'),
        });
        await expect(
          proofPool.query(
            `UPDATE public.task_drafts
                SET relationship_origin_kind = 'MARKETPLACE'
              WHERE id = $1`,
            [providerOsDraft]
          )
        ).rejects.toMatchObject({
          code: 'P0001',
          message: expect.stringContaining('HXUV1-REL-27'),
        });
        await expect(
          proofPool.query(
            `INSERT INTO public.universal_v1_relationship_origin_observations (
               id, task_draft_id, policy_version, origin_kind,
               observation_version, observation_kind, subject_role,
               identity_basis, subject_user_id, subject_binding_sha256,
               source_evidence_sha256, observed_by_user_id
             ) VALUES (
               $1, $2, 1, 'PROVIDER_OS', 2,
               'PROVIDER_CONSENT_OBSERVED', 'PROVIDER',
               'AUTHENTICATED_USER', $3, $4, $5, $3
             )`,
            [randomUUID(), providerOsDraft, providerUser, providerBinding, 'f'.repeat(64)]
          )
        ).rejects.toMatchObject({ code: 'P0001' });

        const noOriginDraft = randomUUID();
        const client = await proofPool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO public.task_drafts (
               id, submission_id, card_token_hash,
               relationship_origin_contract_version, relationship_origin_kind,
               relationship_origin_policy_version
             ) VALUES ($1, $2, $3, 1, 'PROVIDER_OS', 1)`,
            [noOriginDraft, randomUUID(), sha256(`card:${noOriginDraft}`)]
          );
          await expect(client.query('COMMIT')).rejects.toMatchObject({
            code: 'P0001',
            message: expect.stringContaining('HXUV1-REL-29'),
          });
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
          client.release();
        }

        await expect(
          proofPool.query(
            `SELECT
               (SELECT count(*)::INTEGER FROM public.task_routing_decisions) AS routes,
               (SELECT count(*)::INTEGER
                  FROM public.universal_v1_relationship_origins
                 WHERE routing_state = 'ROUTING_READY') AS ready_origins`
          )
        ).resolves.toMatchObject({ rows: [{ routes: 2, ready_origins: 3 }] });
      } finally {
        try {
          if (proofPool) await proofPool.end();
        } finally {
          try {
            if (databaseCreated) {
              await adminPool.query(`DROP DATABASE ${quotedProofDatabase}`);
            }
          } finally {
            await adminPool.end();
          }
        }
      }
    },
    60_000
  );
});
