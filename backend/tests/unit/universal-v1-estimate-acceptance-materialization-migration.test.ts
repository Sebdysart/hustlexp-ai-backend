import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { analyzeMigrationFile } from '../../../scripts/analyze-migration-safety.js';

const migrationPath = resolve(
  process.cwd(),
  'backend/database/migrations/20260906_universal_v1_estimate_acceptance_materialization.sql',
);
const sql = readFileSync(migrationPath, 'utf8');

describe('Universal V1 estimate acceptance and Task materialization migration', () => {
  it('is the append-only successor to the reviewed TaskDraft claim-import repair', () => {
    const materializationIndex = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260906_universal_v1_estimate_acceptance_materialization',
    );

    expect(REQUIRED_MIGRATION_FILES).toHaveLength(128);
    expect(materializationIndex).toBeGreaterThan(0);
    expect(REQUIRED_MIGRATION_FILES.slice(materializationIndex - 1)).toEqual([
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
    expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/gimu);
  });

  it('has no blocker under the repository migration-safety policy', () => {
    expect(
      analyzeMigrationFile(migrationPath, sql).filter((issue) => issue.severity === 'BLOCKER'),
    ).toEqual([]);
  });

  it('makes PROVIDER_ESTIMATE quote versions explicitly payment-free', () => {
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS universal_contract_version SMALLINT NOT NULL DEFAULT 0',
    );
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS payment_posture TEXT;');
    expect(sql).toContain("payment_posture = 'PAYMENT_FREE_ESTIMATE'");
    expect(sql).toContain('ALTER COLUMN pay_token DROP NOT NULL');
    expect(sql).toContain('ALTER COLUMN stripe_mode DROP NOT NULL');
    for (const field of [
      'pay_token',
      'stripe_payment_link_url',
      'stripe_checkout_session_id',
      'stripe_payment_intent_id',
      'stripe_mode',
      'paid_at',
    ]) {
      expect(sql).toContain(`quote_version.${field} IS NULL`);
    }
    expect(sql).toContain(
      'PROVIDER_ESTIMATE quote version must be payment-free and provider-neutral',
    );
    expect(sql).toContain(
      'Universal V1 provider-estimate quote versions are append-only',
    );
    expect(sql).toContain(
      'CREATE TRIGGER universal_provider_estimate_quote_versions_no_truncate',
    );
  });

  it('normalizes the estimate work category and includes it in the immutable digest', () => {
    expect(sql).toContain(
      'ALTER TABLE public.provider_estimate_submissions\n  ADD COLUMN IF NOT EXISTS work_category_code TEXT;',
    );
    expect(sql).toContain('ALTER COLUMN work_category_code SET NOT NULL');
    expect(sql).toContain("work_category_code ~ '^[a-z][a-z0-9_]{1,63}$'");
    expect(sql).toContain("'workCategoryCode', NEW.work_category_code");
    expect(sql).toContain('routing.category_snapshot = NEW.work_category_code');
    expect(sql).toContain(
      'precontract provider estimate requires reviewed work-category adoption evidence',
    );
    expect(sql).toContain(
      'precontract provider-estimate quote version requires reviewed payment-posture adoption evidence',
    );
    expect(sql).not.toMatch(
      /UPDATE\s+(?:public\.)?provider_estimate_submissions\s+SET/iu,
    );
    expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?quote_versions\s+SET/iu);
  });

  it('requires exact official qualification only for credentialed trade routes', () => {
    expect(sql).toContain(
      "'CREDENTIALED_TRADE_REVIEW_REQUIRED' = ANY(route_reason_codes)",
    );
    expect(sql).toContain('FROM public.current_verified_trade_qualifications qualification');
    expect(sql).toContain(
      'qualification.provider_user_id = NEW.provider_user_id',
    );
    expect(sql).toContain(
      'qualification.organization_id = NEW.provider_organization_id',
    );
    expect(sql).toContain(
      'lower(permitted.category) = NEW.work_category_code',
    );
    expect(sql).toContain(
      'ordinary estimate\n-- routes remain available to GENERAL_SERVICE_PROVIDER providers',
    );
  });

  it('records the service exact write set as one immutable materialization fact', () => {
    const factBlock = sql.match(
      /CREATE TABLE IF NOT EXISTS public\.task_estimate_acceptance_materializations \([\s\S]*?\n\);/u,
    )?.[0];
    expect(factBlock).toBeDefined();
    for (const field of [
      'id',
      'task_draft_id',
      'provider_estimate_submission_id',
      'quote_id',
      'quote_version_id',
      'poster_user_id',
      'prior_routing_decision_id',
      'resulting_routing_decision_id',
      'task_id',
      'scope_version_id',
      'expected_draft_version',
      'materialization_version',
      'idempotency_key',
      'request_sha256',
      'created_at',
    ]) {
      expect(factBlock).toMatch(new RegExp(`\\b${field}\\b`, 'u'));
    }
    expect(factBlock).toContain('UNIQUE (task_draft_id)');
    expect(factBlock).toContain('UNIQUE (task_id)');
    expect(factBlock).toContain('UNIQUE (quote_version_id)');
    expect(factBlock).toContain('provider_estimate_submission_id\n  )');
    expect(factBlock).toContain('poster_user_id,\n    idempotency_key');
    expect(factBlock).toContain('materialization_version = 1');
    expect(sql).toContain(
      'BEFORE UPDATE OR DELETE ON public.task_estimate_acceptance_materializations',
    );
    expect(sql).toContain(
      'BEFORE TRUNCATE ON public.task_estimate_acceptance_materializations',
    );
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public.task_estimate_acceptance_materializations FROM PUBLIC',
    );
  });

  it('binds acceptance to the exact route transition, owner, quote, scope, and task', () => {
    expect(sql).toContain("prior_route.outcome = 'ESTIMATE_REQUIRED'");
    expect(sql).toContain('prior_route.decision_version = NEW.expected_draft_version');
    expect(sql).toContain("resulting_route.outcome = 'FULFILLMENT_CANDIDATE'");
    expect(sql).toContain(
      'resulting_route.supersedes_decision_id = prior_route.id',
    );
    expect(sql).toContain(
      'resulting_route.decision_version = prior_route.decision_version + 1',
    );
    expect(sql).toContain('draft.active_routing_decision_id = resulting_route.id');
    expect(sql).toContain('draft.poster_user_id = NEW.poster_user_id');
    expect(sql).toContain('draft.task_id = NEW.task_id');
    expect(sql).toContain('estimate.quote_version_id = quote_version.id');
    expect(sql).toContain('quote.task_id = task.id');
    expect(sql).toContain(
      'quote.provider_user_id IS NOT DISTINCT FROM estimate.provider_user_id',
    );
    expect(sql).toContain(
      'quote.provider_organization_id IS NOT DISTINCT FROM estimate.provider_organization_id',
    );
    expect(sql).toContain('quote_version.scope_version_id IS NULL');
    expect(sql).toContain('scope.scope_hash = estimate.scope_hash');
    expect(sql).toContain("scope.title = estimate.scope_snapshot ->> 'title'");
    expect(sql).toContain("scope.description = estimate.scope_snapshot ->> 'description'");
    expect(sql).toContain("scope.checklist = estimate.scope_snapshot -> 'checklist'");
    expect(sql).toContain('scope.customer_total_cents = estimate.customer_total_cents');
    expect(sql).toContain('scope.hustler_payout_cents = estimate.provider_payout_cents');
    expect(sql).toContain('scope.currency = estimate.currency');
    expect(sql).toContain('scope.created_by = NEW.poster_user_id');
    expect(sql).toContain('task.poster_id = NEW.poster_user_id');
    expect(sql).toContain('task.active_scope_version_id = scope.id');
    expect(sql).toContain("task.title = estimate.scope_snapshot ->> 'title'");
    expect(sql).toContain("task.rough_location = estimate.scope_snapshot ->> 'rough_location'");
    expect(sql).toContain('task.category = estimate.work_category_code');
    expect(sql).toContain("task.region_code = estimate.scope_snapshot ->> 'region_code'");
    expect(sql).toContain("task.risk_level = estimate.scope_snapshot ->> 'risk_level'");
    expect(sql).toContain('task.platform_margin_cents =');
    expect(sql).toContain("upper(task.currency) = estimate.currency");
    expect(sql).toContain("task.state = 'OPEN'");
    expect(sql).toContain('task.worker_id IS NULL');
    expect(sql).toContain('task.work_order_id IS NULL');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER task_estimate_acceptance_materialization_guard');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
  });

  it('makes the TaskDraft-to-Task binding one-time and commit-time exact', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS task_drafts_universal_task_binding_unique',
    );
    expect(sql).toContain(
      'WHERE universal_contract_version = 1 AND task_id IS NOT NULL',
    );
    expect(sql).toContain(
      'Universal V1 TaskDraft Task binding is one-time and immutable',
    );
    expect(sql).toContain(
      'Universal V1 TaskDraft binding requires its exact immutable materialization fact',
    );
    expect(sql).toContain(
      'CREATE CONSTRAINT TRIGGER universal_task_draft_materialization_presence_guard',
    );
    expect(sql).toMatch(
      /materialization\.task_draft_id = NEW\.id[\s\S]*?materialization\.task_id = NEW\.task_id[\s\S]*?materialization\.poster_user_id = NEW\.poster_user_id/u,
    );
  });

  it('uses provider-neutral task posture and rejects every legacy escrow binding', () => {
    expect(sql).toContain("'universal_financial_security'");
    expect(sql).toContain(
      "universal_payment_posture = 'PAYMENT_CREATION_FROZEN'",
    );
    expect(sql).toContain(
      "task.payment_method = 'universal_financial_security'",
    );
    expect(sql).toContain(
      "task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'",
    );
    expect(sql).toContain('Universal V1 Task cannot bind a legacy escrow');
    expect(sql).toContain(
      'BEFORE INSERT OR UPDATE OF task_id ON public.escrows',
    );
    expect(sql).toMatch(
      /NOT EXISTS \([\s\S]*?FROM public\.escrows escrow[\s\S]*?escrow\.task_id = task\.id/u,
    );
  });

  it('creates no assignment, escrow, financial event, or capability grant', () => {
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?escrows/iu);
    expect(sql).not.toMatch(
      /INSERT\s+INTO\s+(?:public\.)?task_financial_(?:operations|security_events)/iu,
    );
    expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?tasks\s+SET\s+worker_id/iu);
    expect(sql).not.toMatch(/GRANT\s+/iu);
    expect(sql).not.toMatch(/customerMoneyCreation\s*=\s*true/iu);
    expect(sql).not.toMatch(/PRODUCTION_PAYMENT_CREATION\s*=\s*(?:true|enabled)/iu);
  });
});
