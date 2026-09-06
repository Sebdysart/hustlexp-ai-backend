import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files';

const fileName = '20261009_universal_v1_standardized_quote_readiness_v1.sql';
const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', fileName),
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

describe('Universal V1 standardized quote and renewable fake-readiness migration', () => {
  it('is append-only migration 143 and leaves every HOLD relation outside its dependency graph', () => {
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(146);
    expect(REQUIRED_MIGRATION_FILES[142]).toEqual({
      name: '20261009_universal_v1_standardized_quote_readiness_v1',
      fileName,
    });
    for (const relation of heldRelations) {
      expect(migration).not.toMatch(new RegExp(`\\b${relation}\\b`, 'u'));
    }
    expect(migration).not.toMatch(
      /^[ \t]*(?:INSERT\s+INTO|UPDATE\s+(?!OR\b)|DELETE\s+FROM|TRUNCATE\s+TABLE)\b/imu
    );
  });

  it('replaces every trigger deterministically on raw migration replay', () => {
    const triggerNames = [
      'task_draft_standardized_quote_versions_insert_guard',
      'task_draft_standardized_quote_acceptance_insert_guard',
      'task_draft_payment_method_readiness_insert_guard',
      'task_draft_standardized_quote_versions_immutable',
      'task_draft_standardized_quote_versions_no_truncate',
      'task_draft_standardized_quote_acceptance_immutable',
      'task_draft_standardized_quote_acceptance_no_truncate',
      'task_draft_payment_method_readiness_immutable',
      'task_draft_payment_method_readiness_no_truncate',
    ];

    for (const triggerName of triggerNames) {
      expect(migration).toContain(`DROP TRIGGER IF EXISTS ${triggerName}`);
      expect(migration).toContain(`CREATE TRIGGER ${triggerName}`);
    }
  });

  it('derives scope and economics from the current route, origin, cell, and Price Book', () => {
    expect(migration).toContain("route.outcome <> 'FULFILLMENT_CANDIDATE'");
    expect(migration).toContain("pricing.automation_evidence_state <> 'CONTROLLED_TEST_ONLY'");
    expect(migration).toContain('NEW.scope_snapshot := jsonb_build_object(');
    expect(migration).toContain("'scopeArtifactKind', 'TASK_DRAFT_STANDARDIZED_SCOPE_V1'");
    expect(migration).toContain("'scopeSource', 'TYPED_TASK_DRAFT_ALLOWLIST_V1'");
    expect(migration).toContain("WHEN 'moving' THEN jsonb_strip_nulls(jsonb_build_object(");
    expect(migration).toContain(
      "WHEN 'furniture_assembly' THEN jsonb_strip_nulls(jsonb_build_object("
    );
    expect(migration).not.toContain("'product_link', draft.structured");
    expect(migration).not.toContain("'answers', draft.structured -> 'answers'");
    expect(migration).not.toContain("'scopeSummary', draft.scope_summary");
    expect(migration).toContain("'access', draft.structured #> '{answers,access}'");
    const scopeProjection = migration.slice(
      migration.indexOf('NEW.scope_snapshot := jsonb_build_object('),
      migration.indexOf('NEW.scope_sha256 :=', migration.indexOf('NEW.scope_snapshot :='))
    );
    const projectedAnswerKeys = [
      ...scopeProjection.matchAll(/draft\.structured #> '\{answers,([^}]+)\}'/gu),
    ].map((match) => match[1]);
    expect([...new Set(projectedAnswerKeys)]).toEqual([
      'size_weight',
      'access',
      'move_type',
      'workers_needed',
      'fragile',
      'assembly_scope_class',
      'item_count_class',
      'new_in_box',
      'tools_included',
      'old_item_removal',
    ]);
    for (const excludedFreeFormAnswer of [
      'item',
      'timing',
      'item_dimensions',
      'assembly_options',
    ]) {
      expect(scopeProjection).not.toContain(`{answers,${excludedFreeFormAnswer}}`);
    }
    const furnitureScopeProjection = scopeProjection.slice(
      scopeProjection.indexOf("WHEN 'furniture_assembly'"),
      scopeProjection.indexOf("ELSE '{}'::JSONB")
    );
    expect(furnitureScopeProjection).not.toContain('{answers,access}');
    for (const excludedMutableCarrier of [
      'required_skills',
      'required_tools',
      'labor_label',
    ]) {
      expect(scopeProjection).not.toContain(`draft.structured -> '${excludedMutableCarrier}'`);
    }
    expect(migration).toContain(
      'HXUV1-STDQUOTE-18: retained furniture answer is outside typed allowlist'
    );
    expect(migration).toContain(
      'HXUV1-STDQUOTE-18: retained moving answer is outside typed allowlist'
    );
    const typedAnswerGuard = migration.slice(
      migration.indexOf('-- Provider-visible quote scope is a typed allowlist'),
      migration.indexOf('SELECT * INTO origin')
    );
    expect(typedAnswerGuard).not.toContain('IS NOT NULL');
    expect(typedAnswerGuard).toContain(
      "draft.structured #>> '{answers,assembly_scope_class}'"
    );
    expect(typedAnswerGuard).toContain(
      "IS DISTINCT FROM 'STANDARD_SINGLE_FLAT_PACK_ITEM_V1'"
    );
    expect(typedAnswerGuard).toContain(
      "{answers,item_count_class}' IS DISTINCT FROM 'one'"
    );
    expect(typedAnswerGuard).toContain(
      "{answers,size_weight}' IS DISTINCT FROM 'light'"
    );
    expect(typedAnswerGuard).toContain(
      "{answers,access}' IS DISTINCT FROM 'ground'"
    );
    expect(typedAnswerGuard).toContain(
      "{answers,move_type}' IS DISTINCT FROM 'same'"
    );
    expect(typedAnswerGuard).toContain(
      "{answers,workers_needed}' IS DISTINCT FROM 'one'"
    );
    expect(typedAnswerGuard).toContain(
      "{answers,fragile}' IS DISTINCT FROM 'false'::JSONB"
    );
    expect(typedAnswerGuard).toContain(
      "{answers,new_in_box}' IS DISTINCT FROM 'true'::JSONB"
    );
    expect(typedAnswerGuard).toContain(
      "{answers,tools_included}' IS DISTINCT FROM 'true'::JSONB"
    );
    expect(typedAnswerGuard).toContain(
      "{answers,old_item_removal}' IS DISTINCT FROM 'false'::JSONB"
    );
    expect(typedAnswerGuard).toContain('FROM jsonb_object_keys(');
    expect(typedAnswerGuard).toContain(
      "'timing', 'scope_confirmed_at'"
    );
    expect(typedAnswerGuard).toContain(
      "'access', 'item_dimensions', 'assembly_options', 'scope_confirmed_at'"
    );
    expect(migration).toContain(
      "route.category_snapshot NOT IN ('moving', 'furniture_assembly')"
    );
    expect(migration).toContain('NEW.pricing_snapshot := jsonb_build_object(');
    expect(migration).toContain("':hxuv1-standardized-base-v1'");
    expect(migration).toContain("pricing.policy_version <> 'hxos-price-book-v1'");
    expect(migration).toContain("'pricingMode', 'BASE_PRICE_NO_MODIFIERS'");
    expect(migration).toContain("'scopeModifierCount', 0");
    expect(migration).toContain("'sourcePriceBookPolicyVersion', pricing.policy_version");
    expect(migration).toContain(
      'HXUV1-STDQUOTE-20: exact service-cell Price Book mapping is required'
    );
    expect(migration).toContain(
      'FROM public.universal_v1_service_cell_price_book_mappings mapping'
    );
    expect(migration).toContain("'priceBookMappingId', pricing_mapping.id");
    expect(migration).toContain('NEW.customer_total_cents := pricing.base_price_cents');
    expect(migration).toContain(
      'margin_floor_bps := round(pricing.platform_margin_floor_pct * 100)::INTEGER'
    );
    expect(migration).toContain(
      'NEW.provider_payout_cents := computed_provider_payout_cents'
    );
    expect(migration).toContain(
      'NEW.platform_margin_cents := pricing.base_price_cents - computed_provider_payout_cents'
    );
    expect(migration).toContain(
      'computed_provider_payout_cents < pricing.min_hustler_payout_cents'
    );
    expect(migration).toContain(
      '(pricing.base_price_cents - computed_provider_payout_cents)::NUMERIC * 10000'
    );
    expect(migration).toContain(
      'pricing.base_price_cents::NUMERIC * margin_floor_bps::NUMERIC'
    );
    expect(migration).toContain("NEW.payment_posture := 'PAYMENT_CREATION_FROZEN'");
  });

  it('binds quote, acceptance, and opportunity to one versioned sanitized scope artifact', () => {
    expect(migration).toContain('CHECK (scope_artifact_id = id)');
    expect(migration).toContain('CHECK (scope_artifact_id = quote_version_id)');
    expect(migration).toContain('NEW.scope_artifact_id := NEW.id');
    expect(migration).toContain('NEW.scope_artifact_id := quote.scope_artifact_id');
    expect(migration).toContain(
      'standardized_quote.scope_artifact_id AS standardized_scope_artifact_id'
    );
    expect(migration).toContain(
      'standardized_quote.scope_sha256 AS standardized_scope_artifact_sha256'
    );
  });

  it('requires an immutable explicit service-cell to Price Book mapping', () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS public.universal_v1_service_cell_price_book_mappings'
    );
    expect(migration).toContain(
      'price_book_mapping_id UUID NOT NULL'
    );
    expect(migration).toContain(
      'mapping.service_cell_authority_id = cell.id'
    );
    expect(migration).toContain(
      'mapping.service_cell_authority_version = cell.authority_version'
    );
    expect(migration).toContain(
      'mapping.environment_class = cell.authority_environment'
    );
    expect(migration).toContain(
      'universal_v1_service_cell_price_book_mappings_immutable'
    );
    expect(migration).toContain(
      'universal_v1_service_cell_price_book_mappings_no_truncate'
    );
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.universal_v1_service_cell_price_book_mappings FROM PUBLIC'
    );
  });

  it('removes opportunities when the owning Poster is no longer actionable', () => {
    const opportunityView = migration.slice(
      migration.indexOf('CREATE OR REPLACE VIEW public.current_universal_v1_task_opportunities_v1'),
      migration.indexOf('REVOKE ALL ON TABLE public.task_draft_standardized_quote_versions')
    );
    expect(opportunityView).toContain('JOIN public.users poster');
    expect(opportunityView).toContain('poster.id = draft.poster_user_id');
    expect(opportunityView).toContain("poster.default_mode = 'poster'");
    expect(opportunityView).toContain("poster.account_status = 'ACTIVE'");
    expect(opportunityView).toContain('poster.is_minor IS FALSE');
    expect(opportunityView).toContain('COALESCE(poster.is_banned, FALSE) IS FALSE');
  });

  it('locks price only through an acceptance recorded before quote expiry', () => {
    expect(migration).toContain('OR quote.valid_until <= acceptance_observed_at');
    expect(migration).toContain('an accepted quote cannot be superseded');
    expect(migration).toContain('acceptance.accepted_at > quote.valid_until');
    expect(migration).not.toMatch(
      /enforce_universal_v1_fake_payment_readiness_v1[\s\S]*?quote\.valid_until <= clock_timestamp\(\)/u
    );
    expect(migration).not.toContain(
      'AND standardized_quote.valid_until > clock_timestamp()'
    );
  });

  it('supports crash-gap recovery and renewable versioned readiness after expiry', () => {
    expect(migration).toContain(
      'readiness_version = expected_readiness_version + 1'
    );
    expect(migration).toContain('supersedes_readiness_fact_id');
    expect(migration).toContain('expected readiness version changed');
    expect(migration).toContain("NEW.expires_at := NEW.created_at + interval '30 minutes'");
    expect(migration).toContain('successor.supersedes_readiness_fact_id = candidate.id');
    expect(migration).toContain('candidate.expires_at > clock_timestamp()');
    expect(migration).toContain(
      "'FAKE_PAYMENT_METHOD_READINESS_V1:' || acceptance.id::TEXT || ':v'"
    );
  });

  it('fails closed when an accepted quote no longer has its exact route, origin, or cell', () => {
    expect(migration).toContain(
      'draft.active_routing_decision_id IS DISTINCT FROM quote.routing_decision_id'
    );
    expect(migration).toContain('route.decision_version = quote.routing_decision_version');
    expect(migration).toContain('cell.authority_version = quote.service_cell_authority_version');
    expect(migration).toContain('origin.origin_version = quote.relationship_origin_version');
    expect(migration).toContain('accepted quote routing context requires review');
    expect(migration).toContain('quote routing context requires review before acceptance');
    expect(migration).toContain('candidate.relationship_origin_id = origin.id');
    expect(migration).toContain(
      'candidate.relationship_origin_version = origin.origin_version'
    );
    expect(migration).toContain('candidate.service_cell_authority_id = cell.id');
    expect(migration).toContain(
      'candidate.service_cell_authority_version = cell.authority_version'
    );
  });

  it('uses one observed acceptance timestamp for both expiry validation and the immutable fact', () => {
    expect(migration).toContain(
      'acceptance_observed_at TIMESTAMPTZ := clock_timestamp()'
    );
    expect(migration).toContain('quote.valid_until <= acceptance_observed_at');
    expect(migration).toContain('NEW.accepted_at := acceptance_observed_at');
  });

  it('distinguishes issuance evidence from each later current command witness', () => {
    for (const field of [
      'issuance_build_commit_sha',
      'issuance_release_manifest_digest',
      'issuance_capability_policy_digest',
      'command_build_commit_sha',
      'command_release_manifest_digest',
      'command_capability_policy_digest',
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).not.toMatch(
      /quote\.(?:issuance_)?build_commit_sha\)?\s+IS DISTINCT FROM\s+(?:btrim\()?NEW\.command_build_commit_sha/u
    );
    expect(migration).toContain('APPLICATION_MEASURED');
    expect(migration).toContain('shared database role does not authenticate the signed manifest');
  });

  it('serializes a deterministic quote/readiness predecessor chain and freezes every effect', () => {
    expect(migration).toContain("'STANDARDIZED_QUOTE_V1:' || draft.id::TEXT || ':v'");
    expect(migration).toContain('UNIQUE (task_draft_id, quote_version)');
    expect(migration).toContain('UNIQUE (supersedes_quote_version_id)');
    expect(migration).toContain('UNIQUE (task_draft_id, readiness_version)');
    expect(migration).toContain('UNIQUE (supersedes_readiness_fact_id)');
    for (const effect of [
      'external_provider_called',
      'customer_money_created',
      'authorization_created',
      'financial_security_event_created',
      'capture_created',
      'assignment_created',
      'work_order_created',
      'settlement_created',
      'payout_created',
    ]) {
      expect(migration).toMatch(
        new RegExp(`${effect} BOOLEAN NOT NULL DEFAULT FALSE[\\s\\S]*?${effect} IS FALSE`, 'u')
      );
    }
  });
});
