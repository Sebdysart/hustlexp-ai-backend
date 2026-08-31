import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'backend/database/migrations/20261003_universal_v1_task_opportunities_v1.sql'
);
const migration = readFileSync(migrationPath, 'utf8');

describe('Universal V1 Task Opportunities migration contract', () => {
  it('is the ordered successor and reuses canonical task_applications', () => {
    expect(migrationPath).toContain('20261003_universal_v1_task_opportunities_v1.sql');
    expect(migration).toContain("to_regclass('public.universal_v1_relationship_origins')");
    expect(migration).not.toContain("to_regclass('public.universal_v1_dispute_incidents')");
    expect(migration).toContain('ALTER TABLE public.task_applications');
    expect(migration).not.toMatch(/CREATE\s+TABLE[^;]*task_provider_interests/iu);
  });

  it('projects only real open Marketplace TaskDrafts with exact route and origin authority', () => {
    expect(migration).toContain('current_universal_v1_task_opportunities_v1');
    expect(migration).toContain('WITH (security_invoker = true)');
    expect(migration).toContain("draft.status = 'account_claimed'");
    expect(migration).toContain('draft.task_id IS NULL');
    expect(migration).toContain('route.id = draft.active_routing_decision_id');
    expect(migration).toContain('origin.origin_kind = draft.relationship_origin_kind');
    expect(migration).toContain("origin.routing_state = 'ROUTING_READY'");
    expect(migration).toContain("route.outcome IN ('FULFILLMENT_CANDIDATE', 'ESTIMATE_REQUIRED')");
    expect(migration).toContain("cell.routing_availability = 'ACTIVE'");
    expect(migration).toContain(
      'NOT EXISTS (\n    SELECT 1\n    FROM public.universal_v1_relationship_origins successor'
    );
  });

  it('binds a named immutable route-context scope artifact and a separate public allowlist', () => {
    expect(migration).toContain("'TASK_DRAFT_ROUTE_CONTEXT_V1'::TEXT AS scope_artifact_kind");
    expect(migration).toContain('route.id AS scope_artifact_id');
    expect(migration).toContain('route.decision_version AS scope_artifact_version');
    expect(migration).toContain("'routeContextEvidence', route.evidence");
    expect(migration).toContain('public.digest(scope_artifact.scope_artifact::TEXT');
    expect(migration).toContain('interest_scope_artifact_id = interest_routing_decision_id');
    expect(migration).toContain(
      'interest_scope_artifact_version = interest_routing_decision_version'
    );
    expect(migration).toContain('forged route, origin, or scope artifact binding');
    expect(migration).toContain('public_scope.public_scope');
    expect(migration).not.toContain('scope_snapshot_version');
  });

  it('keeps legacy and post-estimate rows task-bound while pre-task interest alone may be taskless', () => {
    expect(migration).toMatch(
      /universal_contract_version = 0[\s\S]*?task_id IS NOT NULL[\s\S]*?opportunity_contract_version = 0/u
    );
    expect(migration).toMatch(
      /opportunity_contract_version = 0[\s\S]*?task_id IS NOT NULL[\s\S]*?interest_scope_version_id IS NOT NULL/u
    );
    expect(migration).toMatch(
      /opportunity_contract_version = 1[\s\S]*?status = 'pending'[\s\S]*?task_id IS NULL/u
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.enforce_universal_post_estimate_interest()'
    );
    expect(migration).toContain('OR NEW.opportunity_contract_version = 1');
    expect(migration).toContain("task.automation_classification = 'CONTROLLED_TEST'");
    expect(migration).toContain("routing.outcome = 'FULFILLMENT_CANDIDATE'");
    expect(migration).toContain('scope.id = NEW.interest_scope_version_id');
  });

  it('allows NULL organization and credential in the general-individual request digest', () => {
    const digestFunction = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.universal_v1_task_opportunity_interest_request_sha256'
      ),
      migration.indexOf('-- Preserve the existing post-estimate interest guard')
    );
    expect(digestFunction).not.toMatch(/\bSTRICT\b/u);
    expect(digestFunction).toContain("COALESCE(p_provider_organization_id::TEXT, '')");
    expect(digestFunction).toContain("COALESCE(p_business_credential_id::TEXT, '')");
    expect(migration).toContain('NEW.rejection_reason IS NOT NULL');
    expect(migration).toContain('NEW.message IS NOT NULL');
  });

  it('observes general providers without a trade license and fully proves VTB qualifications', () => {
    expect(migration).toContain("profile.provider_class <> 'GENERAL_SERVICE_PROVIDER'");
    expect(migration).toContain("organization.provider_class = 'GENERAL_SERVICE_PROVIDER'");
    expect(migration).toContain('NEW.observed_trade_credential_id IS NOT NULL');
    expect(migration).toContain("profile.provider_class <> 'VERIFIED_TRADE_BUSINESS'");
    expect(migration).toContain('public.current_verified_trade_qualifications');
    for (const exactCredentialFact of [
      'issuing_authority',
      'jurisdiction_code',
      'license_scope',
      'license_status',
      'expires_at',
      'evidence_hash',
      'verified_at',
      'official_source_checked_at',
      'permitted_category',
    ]) {
      expect(migration).toContain(exactCredentialFact);
    }
    expect(migration).toContain('trade_qualification_sha256');
    expect(migration).toContain('provider_capability_sha256');
  });

  it('makes only the new pre-task interest contract append-only', () => {
    expect(migration).toContain('IF OLD.opportunity_contract_version = 1');
    expect(migration).toContain('OR NEW.opportunity_contract_version = 1');
    expect(migration).toContain('IF OLD.universal_contract_version <> 1 THEN');
    expect(migration).toContain("OLD.status = 'pending'");
    expect(migration).toContain("NEW.status IN ('withdrawn', 'expired', 'rejected')");
    expect(migration).toContain('WHERE opportunity_contract_version = 1');
    expect(migration).toContain('TaskDraft EXPRESS_INTEREST cannot be deleted');
    expect(migration).toContain('TaskDraft EXPRESS_INTEREST cannot be truncated');
  });

  it('hardens every executable function and exposes no PUBLIC grant', () => {
    const functions = [
      'universal_v1_task_opportunity_interest_request_sha256',
      'enforce_universal_post_estimate_interest',
      'enforce_universal_v1_task_opportunity_interest_v1',
      'enforce_universal_interest_integrity',
      'prevent_universal_v1_task_opportunity_interest_delete',
      'prevent_universal_v1_task_opportunity_interest_truncate',
    ];
    expect(migration.match(/CREATE OR REPLACE FUNCTION public\./gu)).toHaveLength(functions.length);
    expect(migration.match(/SET search_path = pg_catalog, public/gu)).toHaveLength(
      functions.length
    );
    for (const functionName of functions) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${functionName}`);
    }
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.current_universal_v1_task_opportunities_v1 FROM PUBLIC'
    );
    expect(migration).not.toMatch(/\bGRANT\b[\s\S]*?\bPUBLIC\b/iu);
    expect(migration.replaceAll('public.digest(', '')).not.toMatch(/\bdigest\(/u);
  });

  it('contains no reservation, eligibility, assignment, private-data, or economic side effect', () => {
    const forbiddenDmlTables = [
      'tasks',
      'task_provider_eligibility_decisions',
      'task_reservations',
      'task_work_orders',
      'task_location_access_log',
      'task_financial_security_events',
      'provider_payables',
      'escrows',
      'revenue_ledger',
    ];
    for (const table of forbiddenDmlTables) {
      expect(migration).not.toMatch(
        new RegExp(`(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:public\\.)?${table}\\b`, 'iu')
      );
    }
    expect(migration).not.toMatch(/\bstripe\b/iu);
    expect(migration).not.toContain('raw_input');
    expect(migration).not.toContain('scope_summary');
    expect(migration).not.toContain('customer_email');
    expect(migration).not.toContain('customer_phone');
    expect(migration).toContain("'NONE'::TEXT AS assignment_authority");
    expect(migration).toContain("'NONE'::TEXT AS address_contact_authority");
    expect(migration).toContain("'NONE'::TEXT AS financial_authority");
    expect(migration).toContain("'NONE'::TEXT AS guaranteed_earning_authority");
  });
});
