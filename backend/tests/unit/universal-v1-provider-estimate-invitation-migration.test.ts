import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeMigrationFile } from '../../../scripts/analyze-migration-safety.js';

const migrationPath = resolve(
  process.cwd(),
  'backend/database/migrations/20260907_universal_v1_provider_estimate_invitation.sql',
);
const sql = readFileSync(migrationPath, 'utf8');

describe('Universal V1 provider-estimate invitation migration', () => {
  it('is append-only migration-runner input with no migration-safety blocker', () => {
    expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/gimu);
    expect(
      analyzeMigrationFile(migrationPath, sql).filter((issue) => issue.severity === 'BLOCKER'),
    ).toEqual([]);
  });

  it('records one immutable invitation bound to exact eligibility and quote facts', () => {
    const table = sql.match(
      /CREATE TABLE IF NOT EXISTS public\.task_provider_estimate_invitations \([\s\S]*?\n\);/u,
    )?.[0];
    expect(table).toBeDefined();
    for (const field of [
      'task_draft_id',
      'routing_decision_id',
      'eligibility_decision_id',
      'quote_id',
      'quote_created_by',
      'provider_user_id',
      'provider_organization_id',
      'provider_class',
      'trade_credential_id',
      'routing_decision_version',
      'eligibility_decision_version',
      'eligibility_evidence_sha256',
      'work_category_code',
      'region_code',
      'risk_level',
      'requires_proof',
      'rough_location',
      'decision_authority',
      'decided_by',
      'authority_policy_version',
      'valid_until',
      'idempotency_key',
      'request_sha256',
      'created_at',
    ]) {
      expect(table).toMatch(new RegExp(`\\b${field}\\b`, 'u'));
    }
    expect(table).toContain('UNIQUE (quote_id)');
    expect(table).toContain('UNIQUE (\n    eligibility_decision_id\n  )');
    expect(table).toContain(
      'UNIQUE NULLS NOT DISTINCT (\n    decision_authority,\n    decided_by,\n    idempotency_key\n  )',
    );
    expect(sql).toContain(
      'BEFORE UPDATE OR DELETE ON public.task_provider_estimate_invitations',
    );
    expect(sql).toContain(
      'BEFORE TRUNCATE ON public.task_provider_estimate_invitations',
    );
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public.task_provider_estimate_invitations FROM PUBLIC',
    );
  });

  it('derives provider identity and task snapshots from immutable eligibility evidence', () => {
    for (const field of [
      'work_category_code',
      'region_code',
      'risk_level',
      'requires_proof',
      'rough_location',
    ]) {
      expect(sql).toContain(`eligibility.evidence -> '${field}'`);
      expect(sql).toContain(`eligibility.evidence ->> '${field}'`);
    }
    expect(sql).toContain('NEW.task_draft_id := eligibility.task_draft_id');
    expect(sql).toContain('NEW.routing_decision_id := eligibility.routing_decision_id');
    expect(sql).toContain('NEW.provider_user_id := eligibility.provider_user_id');
    expect(sql).toContain('NEW.provider_organization_id := eligibility.provider_organization_id');
    expect(sql).toContain('NEW.provider_class := eligibility.provider_class');
    expect(sql).toContain('NEW.trade_credential_id := eligibility.trade_credential_id');
    expect(sql).toContain('digest(eligibility.evidence::text');
    expect(sql).toContain('routing.category_snapshot IS DISTINCT FROM evidence_work_category');
  });

  it('requires a current exact active ESTIMATE_REQUIRED eligibility fact', () => {
    expect(sql).toContain("routing.outcome <> 'ESTIMATE_REQUIRED'");
    expect(sql).toContain(
      'draft.active_routing_decision_id IS DISTINCT FROM routing.id',
    );
    expect(sql).toContain('eligibility.task_eligible IS NOT TRUE');
    expect(sql).toContain('eligibility.valid_until <= clock_timestamp()');
    expect(sql).toMatch(
      /FROM public\.task_provider_eligibility_decisions newer[\s\S]*?newer\.decision_version > eligibility\.decision_version/u,
    );
    expect(sql).toContain('NEW.valid_until > eligibility.valid_until');
  });

  it('allows only a current scoped named operator and denies deterministic issuance', () => {
    expect(sql).toContain("decision_authority = 'NAMED_OPERATOR'");
    expect(sql).toContain(
      "decision_authority = 'NAMED_OPERATOR' AND decided_by IS NOT NULL",
    );
    expect(sql).toContain('deterministic policy issuance is disabled');
    expect(sql).toContain('operator_role.can_manage_operations IS TRUE');
    expect(sql).toContain("operator_user.account_status = 'ACTIVE'");
    expect(sql).toContain('operator_user.is_minor IS FALSE');
    expect(sql).toContain('COALESCE(operator_user.is_banned, FALSE) IS FALSE');
    expect(sql).toContain('NEW.decided_by IS NOT DISTINCT FROM eligibility.provider_user_id');
    expect(sql).toContain('provider_membership.user_id = NEW.decided_by');
    expect(sql).toContain('a provider cannot select itself through named operator authority');
  });

  it('serializes eligibility authority and locks every mutable authority row', () => {
    expect(sql).toContain("'eligibility:' || p_task_draft_id::text || ':' || p_provider_user_id::text");
    for (const table of [
      'public.users', 'public.admin_roles', 'public.capability_profiles',
      'public.business_organizations', 'public.business_memberships',
      'public.business_credentials', 'public.verified_trades',
    ]) {
      expect(sql).toContain(`FROM ${table}`);
    }
    expect(sql).toContain('FOR SHARE');
  });

  it('reserves commercial estimate submission to owners and admins', () => {
    expect(sql).toContain("'SUBMIT_ESTIMATE'");
    expect(sql).toMatch(/WHEN 'OWNER'[\s\S]*?'SUBMIT_ESTIMATE'/u);
    expect(sql).toMatch(/WHEN 'ADMIN'[\s\S]*?'SUBMIT_ESTIMATE'/u);
    for (const role of ['DISPATCHER', 'VIEWER', 'CREW']) {
      const clause = sql.match(new RegExp(`WHEN '${role}' THEN[\\s\\S]*?(?=WHEN|ELSE)`, 'u'))?.[0];
      expect(clause).toBeDefined();
      expect(clause).not.toContain('SUBMIT_ESTIMATE');
    }
    expect(sql).toContain('public.business_membership_has_action(');
  });

  it('keeps the runtime repository as the sole application invitation writer', () => {
    const root = resolve(process.cwd(), 'backend/src');
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = resolve(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(?:ts|js)$/u.test(entry)) files.push(path);
      }
    };
    walk(root);
    const writers = files.filter((file) =>
      /INSERT\s+INTO\s+(?:public\.)?task_provider_estimate_invitations/iu.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(writers.map((file) => file.replace(/\\/gu, '/').split('/backend/')[1])).toEqual([
      'src/services/UniversalV1EstimatePostgresRepository.ts',
    ]);
  });

  it('binds only an empty quote shell and freezes its issued identity', () => {
    expect(sql).toContain("quote_shell.quote_kind <> 'PROVIDER_ESTIMATE'");
    expect(sql).toContain("quote_shell.status <> 'draft'");
    expect(sql).toContain('quote_shell.active_version_id IS NOT NULL');
    expect(sql).toContain('quote_shell.task_id IS NOT NULL');
    expect(sql).toContain('FROM public.quote_versions version');
    expect(sql).toContain('provider_estimate_quote_invitation_on_insert');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    for (const field of [
      'id',
      'task_draft_id',
      'quote_kind',
      'provider_user_id',
      'provider_organization_id',
      'routing_decision_id',
      'created_by',
    ]) {
      expect(sql).toContain(`NEW.${field} IS DISTINCT FROM OLD.${field}`);
    }
    expect(sql).toContain(
      'issued provider-estimate quote identity and invitation binding are immutable',
    );
  });

  it('makes invitation expiry authoritative for submission and quote-version expiry', () => {
    expect(sql).toContain('universal_provider_estimate_invitation_guard');
    expect(sql).toContain('invitation.valid_until <= clock_timestamp()');
    expect(sql).toContain('NEW.created_at >= invitation.valid_until');
    expect(sql).toContain('version.expires_at = invitation.valid_until');
    expect(sql).toContain('version.expires_at > clock_timestamp()');
    expect(sql).not.toContain('provider_estimate_expires_at');
    for (const expression of [
      "NEW.scope_snapshot ->> 'work_category_code' IS DISTINCT FROM invitation.work_category_code",
      "NEW.scope_snapshot ->> 'region_code' IS DISTINCT FROM invitation.region_code",
      "NEW.scope_snapshot ->> 'risk_level' IS DISTINCT FROM invitation.risk_level",
      "NEW.scope_snapshot ->> 'rough_location' IS DISTINCT FROM invitation.rough_location",
    ]) {
      expect(sql).toContain(expression);
    }
    expect(sql).toContain(
      'provider input cannot replace server-authoritative category, region, risk, proof, or rough location',
    );
  });

  it('rechecks exact provider and official trade authority at invitation, submission, and acceptance', () => {
    expect(sql).toContain('universal_v1_invited_provider_authority_is_current');
    expect(sql).toContain('qualification.business_credential_id = checked_trade_credential_id');
    expect(sql).toContain('qualification.provider_user_id = checked_provider_user_id');
    expect(sql).toContain('qualification.organization_id = checked_provider_organization_id');
    expect(sql).toContain('qualification.jurisdiction_code = checked_region_code');
    expect(sql).toContain('lower(permitted.category) = checked_work_category_code');
    expect(sql).toContain("provider.account_status = 'ACTIVE'");
    expect(sql).toContain('provider.is_minor IS FALSE');
    expect(sql).toContain('COALESCE(provider.is_banned, FALSE) IS FALSE');
    expect(sql).toContain(
      "'CREDENTIALED_TRADE_REVIEW_REQUIRED' = ANY(routing.reason_codes)",
    );
    expect(sql).toContain('task_estimate_acceptance_current_invitation_guard');
    expect(sql).toContain(
      'estimate acceptance requires an unexpired invitation and current exact provider authority',
    );
  });

  it('creates no money, escrow, assignment, Work Order, or capability grant', () => {
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?escrows/iu);
    expect(sql).not.toMatch(
      /INSERT\s+INTO\s+(?:public\.)?task_financial_(?:operations|security_events)/iu,
    );
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?task_work_orders/iu);
    expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?tasks\s+SET\s+worker_id/iu);
    expect(sql).not.toMatch(/GRANT\s+/iu);
    expect(sql).not.toMatch(/customerMoneyCreation\s*=\s*true/iu);
    expect(sql).not.toMatch(/PRODUCTION_PAYMENT_CREATION\s*=\s*(?:true|enabled)/iu);
  });
});
