import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'backend/database/migrations/20261001_universal_v1_relationship_origin_v1.sql'
  ),
  'utf8'
);
const taskDraftRouter = readFileSync(
  resolve(process.cwd(), 'backend/src/routers/web/taskDrafts.ts'),
  'utf8'
);

describe('Universal V1 RelationshipOrigin migration contract', () => {
  it('keeps one closed versioned policy matrix for exactly three origins', () => {
    expect(migration).toContain('universal_v1_relationship_origin_policies');
    expect(migration).toMatch(
      /origin_kind IN \(\s*'MARKETPLACE', 'PROVIDER_OS', 'BRING_YOUR_OWN_PROVIDER'\s*\)/u
    );
    expect(migration).toContain("(1, 'MARKETPLACE', 'CUSTOMER', FALSE");
    expect(migration).toContain("(1, 'PROVIDER_OS', 'PROVIDER', TRUE");
    expect(migration).toContain("(1, 'BRING_YOUR_OWN_PROVIDER', 'CUSTOMER', TRUE");
    expect(migration).toContain("provider_reference_authority = 'RELATIONSHIP_EVIDENCE_ONLY'");
    for (const authority of [
      'assignment_authority',
      'address_disclosure_authority',
      'eligibility_authority',
      'financial_authority',
      'work_order_authority',
      'fee_policy_authority',
    ]) {
      expect(migration).toContain(`${authority} = 'NONE'`);
    }
  });

  it('binds immutable versioned origin and explicit observations to TaskDraft', () => {
    expect(migration).toContain('relationship_origin_contract_version');
    expect(migration).toContain('REFERENCES public.task_drafts(id) ON DELETE RESTRICT');
    expect(migration).toContain('UNIQUE (task_draft_id, origin_version)');
    expect(migration).toContain('UNIQUE (task_draft_id, observation_kind, observation_version)');
    for (const observation of [
      'INITIATOR_IDENTITY_OBSERVED',
      'CUSTOMER_IDENTITY_OBSERVED',
      'CUSTOMER_CONSENT_OBSERVED',
      'PROVIDER_LINK_OBSERVED',
      'PROVIDER_CONSENT_OBSERVED',
    ]) {
      expect(migration).toContain(`'${observation}'`);
    }
    expect(migration).toContain('origin predecessor must be the exact prior version');
    expect(migration).toContain('observation predecessor must be the exact prior version');
    expect(migration).toContain('RelationshipOrigin policy and evidence are append-only');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(migration).toContain('BEFORE TRUNCATE');
  });

  it('derives deterministic identities and evidence rather than accepting substitutions', () => {
    expect(migration).toContain('universal_v1_relationship_deterministic_uuid');
    expect(migration).toContain('universal_v1_relationship_observation_digest');
    expect(migration).toContain('universal_v1_relationship_origin_digest');
    expect(migration).toContain("'relationship-origin-observation:'");
    expect(migration).toContain("'relationship-origin:'");
    expect(migration).toContain('observation identity is deterministic');
    expect(migration).toContain('observation evidence digest is deterministic');
    expect(migration).toContain('origin identity is deterministic');
    expect(migration).toContain('origin evidence digest is deterministic');
    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');
    expect(migration.match(/SET search_path = pg_catalog, public/gu)).toHaveLength(12);
    expect(migration.match(/public\.digest\(/gu)?.length).toBeGreaterThanOrEqual(6);
    expect(migration.replaceAll('public.digest(', '')).not.toMatch(/\bdigest\(/u);
  });

  it('holds routing until exact identity, consent, and provider link evidence is certified', () => {
    for (const reason of [
      'INITIATOR_IDENTITY_REQUIRED',
      'AUTHENTICATED_INITIATOR_REQUIRED',
      'CUSTOMER_IDENTITY_REQUIRED',
      'CUSTOMER_CONSENT_REQUIRED',
      'PROVIDER_LINK_REQUIRED',
      'PROVIDER_CONSENT_REQUIRED',
    ]) {
      expect(migration).toContain(`'${reason}'`);
    }
    expect(migration).toContain("routing_state IN ('HELD', 'ROUTING_READY')");
    expect(migration).toContain('enforce_relationship_origin_before_routing');
    expect(migration).toContain('ORDER BY candidate.origin_version DESC');
    expect(migration).toContain("origin.routing_state <> 'ROUTING_READY'");
    expect(migration).toContain('routing requires the exact latest certified RelationshipOrigin');
    expect(migration).toContain("'relationship_origin_routing_state', origin.routing_state");
    expect(migration).toContain("'relationship_origin_evidence_digest', origin.evidence_digest");
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(migration).toContain('requires an exact origin record by commit');
  });

  it('makes current public intake Marketplace-only without exposing Provider OS or BYOP assertions', () => {
    expect(taskDraftRouter).toContain('relationship_origin_contract_version');
    expect(taskDraftRouter).toContain("relationship_origin_kind = 'MARKETPLACE'");
    expect(taskDraftRouter).toContain("1,'MARKETPLACE',1,'v1'");
    expect(taskDraftRouter).toContain('storedRelationshipOrigin(route.evidence)');
    expect(taskDraftRouter).toContain('relationship_origin: relationshipOrigin');
    expect(taskDraftRouter).not.toMatch(/relationship_origin:\s*z\./u);
    expect(taskDraftRouter).not.toContain("z.enum(['MARKETPLACE'");
    expect(migration).toContain('ensure_universal_v1_marketplace_relationship_origin');
    expect(migration).toContain(
      "external-customer evidence is privacy-safe Provider OS customer evidence only"
    );
    expect(migration).toContain('Provider OS initiator must be the linked provider');
    expect(migration).toContain('BYOP initiator must be the authenticated customer');
    expect(migration).toContain('BYOP customer and provider must be distinct subjects');
  });

  it('contains no assignment, address, eligibility, money, Work Order, or fee mutation path', () => {
    expect(migration).not.toMatch(/\bstripe\b/iu);
    expect(migration).not.toMatch(/exact_address|street_address|latitude|longitude/iu);
    const consequentialTables = [
      'task_provider_eligibility_decisions',
      'task_eligibility_decisions',
      'task_applications',
      'task_reservations',
      'task_work_orders',
      'task_financial_security_events',
      'escrows',
      'revenue_ledger',
      'task_location_access_log',
    ];
    for (const table of consequentialTables) {
      expect(migration).not.toMatch(
        new RegExp(`(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:public\\.)?${table}\\b`, 'iu')
      );
    }
    expect(migration).not.toMatch(/platform_fee_cents|processor_fee_cents|fee_rate|fee_amount/iu);
    expect(migration).toContain("fee_policy_authority TEXT NOT NULL CHECK (fee_policy_authority = 'NONE')");
  });
});
