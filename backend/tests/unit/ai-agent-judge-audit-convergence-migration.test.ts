import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'backend/database/migrations/20260830_ai_agent_judge_audit_convergence.sql',
  ),
  'utf8',
);

describe('AI agent Judge audit schema convergence', () => {
  it('registers the append-only repair before the outbound and ingress tails', () => {
    const repairIndex = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260830_ai_agent_judge_audit_convergence',
    );

    expect(REQUIRED_MIGRATION_FILES).toHaveLength(121);
    expect(repairIndex).toBeGreaterThanOrEqual(0);
    expect(REQUIRED_MIGRATION_FILES.slice(repairIndex)).toEqual([
      {
        name: '20260830_ai_agent_judge_audit_convergence',
        fileName: '20260830_ai_agent_judge_audit_convergence.sql',
      },
      {
        name: '20260831_provider_neutral_outbound_communication',
        fileName: '20260831_provider_neutral_outbound_communication.sql',
      },
      {
        name: '20260901_universal_v1_lead_ingress_port',
        fileName: '20260901_universal_v1_lead_ingress_port.sql',
      },
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
    ]);
  });

  it('replaces and validates the exact closed proposal-agent set', () => {
    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS ai_agent_decisions_agent_type_check',
    );
    expect(migration).toMatch(
      /CHECK \(agent_type IN \(\s*'scoper',\s*'judge',\s*'matchmaker',\s*'dispute',\s*'reputation',\s*'onboarding',\s*'logistics'\s*\)\) NOT VALID/,
    );
    expect(migration).toContain(
      'VALIDATE CONSTRAINT ai_agent_decisions_agent_type_check',
    );
  });

  it('does not rewrite or remove audit evidence', () => {
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\b/i);
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });
});
