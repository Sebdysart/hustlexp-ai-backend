import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const MIGRATION_NAME = '20260825_pr276_incident_containment';
const MIGRATION_FILE = `backend/database/migrations/${MIGRATION_NAME}.sql`;
const SQL = readFileSync(MIGRATION_FILE, 'utf8');
const CANONICAL_SQL = SQL.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

function functionDigest(name: string): string {
  const start = SQL.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  expect(start, `${name} must be restored`).toBeGreaterThanOrEqual(0);
  const definition = SQL.slice(start).match(/^CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/)?.[0];
  expect(definition, `${name} definition must be complete`).toBeTruthy();
  return createHash('sha256')
    .update(definition!.replace(/\s+/g, ' ').trim())
    .digest('hex');
}

const PR276_LEDGER_IDENTITIES = [
  '20260819_ops_web_hardening',
  '20260821_ops_business_claim_links',
  '20260821_business_ownership',
  '20260821_business_claim_links_extra',
  '20260823_business_fulfiller_lifecycle',
  '20260823_business_payout_tables',
  '20260824_enforce_controlled_test_business_acceptance',
  '20260824_business_controlled_test_acceptance',
  '20260824_orchestration_mode',
] as const;

describe('PR276 incident containment migration', () => {
  it('is one append-only forward repair after every immutable PR276 ledger identity', () => {
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(115);
    expect(REQUIRED_MIGRATION_FILES.slice(-11).map((entry) => entry.name)).toEqual([
      ...PR276_LEDGER_IDENTITIES,
      '20260823_quote_payment_recovery',
      MIGRATION_NAME,
    ]);
    expect(REQUIRED_MIGRATION_FILES.at(-1)).toEqual({
      name: MIGRATION_NAME,
      fileName: `${MIGRATION_NAME}.sql`,
    });
  });

  it('relies on the runner transaction and contains no destructive repair shortcut', () => {
    expect(SQL).not.toMatch(/^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT)\s*;/im);
    expect(CANONICAL_SQL).not.toMatch(/\bCASCADE\b/i);
    expect(CANONICAL_SQL).not.toMatch(
      /(?:^|;)\s*(?:DROP\s+(?:TABLE|SCHEMA|DATABASE)|TRUNCATE\s+(?:TABLE\s+)?|DELETE\s+FROM)\b/i
    );
    expect(CANONICAL_SQL).not.toMatch(/\bUPDATE\s+(?:public\.)?(?:tasks|business_organizations|escrows|users)\b/i);
    expect(CANONICAL_SQL).not.toMatch(/\bINSERT\s+INTO\s+(?:public\.)?(?:tasks|business_organizations|escrows|users)\b/i);
  });

  it('adds forward-only NOT VALID checks instead of rewriting historical business rows', () => {
    for (const [constraint, definition] of [
      ['tasks_pr276_business_fulfiller_frozen', 'business_fulfiller_organization_id IS NULL'],
      ['tasks_pr276_orchestration_frozen', "orchestration_mode = 'AUTOMATED'"],
      ['quotes_pr276_business_organization_frozen', 'business_organization_id IS NULL'],
      ['quotes_pr276_business_location_frozen', 'business_location_id IS NULL'],
      ['quotes_pr276_provider_service_profile_frozen', 'provider_service_profile_id IS NULL'],
      ['quotes_pr276_claimed_by_user_frozen', 'claimed_by_user_id IS NULL'],
    ]) {
      expect(CANONICAL_SQL).toContain(
        `ADD CONSTRAINT ${constraint} CHECK (${definition}) NOT VALID`
      );
    }
    expect(CANONICAL_SQL).not.toMatch(/ADD\s+CONSTRAINT\s+quotes_pr276_business_claim_frozen/i);
    expect(CANONICAL_SQL).not.toMatch(/\bVALIDATE\s+CONSTRAINT\b/i);
    expect(CANONICAL_SQL).toMatch(/\borchestration_mode\b/i);
    expect(CANONICAL_SQL).toMatch(/\bbusiness_fulfiller_organization_id\b/i);
    expect(CANONICAL_SQL).not.toMatch(/hustlexp\.is_test|hustlexp\.ops_manual|manual_bypass/i);
  });

  it('keeps provider transfer status closed while admitting confirmed reversals', () => {
    expect(CANONICAL_SQL).toContain(
      'DROP CONSTRAINT IF EXISTS escrows_provider_transfer_status_ck'
    );
    expect(CANONICAL_SQL).toContain(
      "ADD CONSTRAINT escrows_provider_transfer_status_ck CHECK ( provider_transfer_status IS NULL OR provider_transfer_status IN ( 'submitted', 'processing', 'paid', 'manual_reconciliation', 'reversed' ) )"
    );
    const transferStatusConstraint = CANONICAL_SQL.match(
      /ADD CONSTRAINT escrows_provider_transfer_status_ck[\s\S]*?\)/i
    )?.[0];
    expect(transferStatusConstraint?.match(/'reversed'/g)).toHaveLength(1);
  });

  it('admits only exact released-dispute/failure quarantine and keeps released refunds blocked', () => {
    expect(CANONICAL_SQL).toContain(
      "current_setting('hustlexp.released_dispute_authority', true)"
    );
    expect(CANONICAL_SQL).toContain(
      "current_setting('hustlexp.transfer_failed_authority', true)"
    );
    for (const evidenceType of [
      'released_dispute_authority_v1',
      'dispute_locked_after_release',
      'transfer_failed_provider_witness_v1',
    ]) {
      expect(CANONICAL_SQL).toContain(evidenceType);
    }
    expect(CANONICAL_SQL).toContain(
      'released-origin refund % requires insurance and verification-earnings compensation authority'
    );
    expect(CANONICAL_SQL).toMatch(
      /released_dispute_authority[^;]+\)=OLD\.id::text/i
    );
    expect(CANONICAL_SQL).toMatch(
      /transfer_failed_authority[^;]+\)=OLD\.id::text/i
    );
    expect(CANONICAL_SQL).toContain(
      "ELSIF OLD.state IN ('RELEASED','REFUNDED','REFUND_PARTIAL') THEN"
    );
    expect(CANONICAL_SQL).toContain('provider_transfer_status_authority_v1');
    expect(CANONICAL_SQL).toContain(
      "current_setting('hustlexp.provider_transfer_status_authority', true)"
    );
    expect(CANONICAL_SQL).toContain(
      "to_jsonb(NEW)-'provider_transfer_status'-'version'-'updated_at'"
    );
    expect(CANONICAL_SQL).not.toContain(
      "current_setting('hustlexp.dispute_release_override', true)"
    );
    expect(CANONICAL_SQL).toContain(
      'requires exact current dispute and provider release authority'
    );
  });

  it('restores the ab4a76cb acceptance trigger shape without Business or OPS exceptions', () => {
    for (const trigger of [
      'task_region_policy_accept_insert_gate',
      'task_region_policy_accept_gate',
      'task_worker_eligibility_accept_insert_gate',
      'task_worker_eligibility_accept_gate',
      'controlled_test_provider_capability_accept_guard',
      'controlled_test_offer_accept_guard',
    ]) {
      expect(CANONICAL_SQL).toContain(`CREATE TRIGGER ${trigger}`);
    }

    expect(CANONICAL_SQL).toMatch(
      /CREATE TRIGGER task_region_policy_accept_insert_gate BEFORE INSERT ON (?:public\.)?tasks FOR EACH ROW WHEN \(NEW\.state\s*=\s*'ACCEPTED'\) EXECUTE FUNCTION (?:public\.)?enforce_task_region_policy_on_accept\(\)/i
    );
    expect(CANONICAL_SQL).toMatch(
      /CREATE TRIGGER task_worker_eligibility_accept_insert_gate BEFORE INSERT ON (?:public\.)?tasks FOR EACH ROW WHEN \(NEW\.state\s*=\s*'ACCEPTED'\) EXECUTE FUNCTION (?:public\.)?enforce_task_worker_eligibility_on_accept\(\)/i
    );
    expect(CANONICAL_SQL).toMatch(
      /CREATE TRIGGER controlled_test_provider_capability_accept_guard BEFORE INSERT OR UPDATE OF state\s*,\s*worker_id ON (?:public\.)?tasks FOR EACH ROW EXECUTE FUNCTION (?:public\.)?enforce_controlled_test_provider_capability_on_accept\(\)/i
    );
    expect(CANONICAL_SQL).toMatch(
      /CREATE TRIGGER controlled_test_offer_accept_guard BEFORE INSERT OR UPDATE OF state\s*,\s*worker_id ON (?:public\.)?tasks FOR EACH ROW EXECUTE FUNCTION (?:public\.)?enforce_controlled_test_offer_acceptance\(\)/i
    );
  });

  it('copies the six final ab4a76cb function bodies byte-for-byte after whitespace normalization', () => {
    expect({
      enforce_task_region_policy_on_accept: functionDigest('enforce_task_region_policy_on_accept'),
      enforce_task_worker_eligibility_on_accept: functionDigest(
        'enforce_task_worker_eligibility_on_accept'
      ),
      enforce_controlled_test_offer_acceptance: functionDigest(
        'enforce_controlled_test_offer_acceptance'
      ),
      enforce_controlled_test_provider_capability_on_accept: functionDigest(
        'enforce_controlled_test_provider_capability_on_accept'
      ),
      enforce_task_liquidity_cell_on_accept: functionDigest(
        'enforce_task_liquidity_cell_on_accept'
      ),
      enforce_worker_offer_decision_on_accept: functionDigest(
        'enforce_worker_offer_decision_on_accept'
      ),
    }).toEqual({
      enforce_task_region_policy_on_accept:
        'ee7b679a2d3de0e6185bd4ddf25cb5de4181d797fb129c4dc4f375c564720e8b',
      enforce_task_worker_eligibility_on_accept:
        'b314a1ee8c2795d93355364c55ccb94467c1498bad727f1b2022f5a1ce6aa003',
      enforce_controlled_test_offer_acceptance:
        '68a58f2e9350efcf7164252562052fae0037de11844ef469dc9e5373fb07a3d6',
      enforce_controlled_test_provider_capability_on_accept:
        '179cc3395afc798d4fec8e2f7a04b7d1aa1d56852b3ae28b2780452e15216dda',
      enforce_task_liquidity_cell_on_accept:
        '925900ad4191b84c4c07001758b39454b56f225d8002f98c5db880e38e89ba36',
      enforce_worker_offer_decision_on_accept:
        '58eac8fcf38a65bb0808097c1a8cf3749f139ab1a65d8616aee35f0039aead35',
    });
  });

  it('freezes future Business/manual orchestration and removes public/runtime DDL authority', () => {
    expect(CANONICAL_SQL).toContain(
      "ADD CONSTRAINT tasks_pr276_orchestration_frozen CHECK (orchestration_mode = 'AUTOMATED') NOT VALID"
    );
    expect(CANONICAL_SQL).toContain(
      'DROP TRIGGER IF EXISTS controlled_test_business_acceptance_guard ON public.tasks'
    );
    expect(CANONICAL_SQL).toContain(
      'DROP FUNCTION IF EXISTS public.enforce_controlled_test_business_acceptance()'
    );
    expect(CANONICAL_SQL).toMatch(/\bRAISE\s+EXCEPTION\b/i);
    expect(CANONICAL_SQL).toMatch(/current_setting\('hustlexp\.runtime_database_role'/i);
    expect(CANONICAL_SQL).toMatch(/CURRENT_USER IS DISTINCT FROM SESSION_USER/i);
    expect(CANONICAL_SQL).toMatch(/ALTER DATABASE %I SET search_path TO pg_catalog, public/i);
    expect(CANONICAL_SQL).toMatch(/has_parameter_privilege\([^)]*session_replication_role/i);
    expect(CANONICAL_SQL).toMatch(/\bREVOKE\s+CREATE\s+ON\s+SCHEMA\s+public\b/i);
    expect(CANONICAL_SQL).toMatch(/REVOKE\s+TEMPORARY\s+ON\s+DATABASE/i);
    expect(CANONICAL_SQL).toMatch(
      /has_database_privilege\(v_runtime_role\.rolname,\s*current_database\(\),\s*'TEMP'\)/i
    );
    expect(CANONICAL_SQL).toMatch(/has_table_privilege\([^)]*'TRIGGER'/i);
    expect(CANONICAL_SQL).toMatch(/\bREVOKE\s+EXECUTE\s+ON\s+FUNCTION\b/i);
    expect(CANONICAL_SQL).toContain("v_relkind NOT IN ('r', 'p')");
    expect(CANONICAL_SQL).toContain('ENABLE ALWAYS TRIGGER pr276_incident_dml_guard');
    expect(CANONICAL_SQL).toContain('ENABLE ALWAYS TRIGGER pr276_incident_truncate_guard');
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect(CANONICAL_SQL).toMatch(
        new RegExp(`has_table_privilege\\([^)]*'${privilege}'`, 'i')
      );
    }
  });

  it('makes the escrow event ledger append-only for every session role', () => {
    expect(CANONICAL_SQL).toContain(
      "RAISE EXCEPTION 'HXIC5: escrow events are append-only'"
    );
    expect(CANONICAL_SQL).toContain(
      "'CREATE TRIGGER escrow_events_destructive_guard ' 'BEFORE UPDATE OR DELETE ON %s ' 'FOR EACH STATEMENT EXECUTE FUNCTION public.reject_escrow_event_destructive_mutation()'"
    );
    expect(CANONICAL_SQL).toContain(
      'ALTER TABLE %s ENABLE ALWAYS TRIGGER escrow_events_destructive_guard'
    );
    expect(CANONICAL_SQL).toContain(
      'ALTER TABLE %s ENABLE ALWAYS TRIGGER escrow_events_truncate_guard'
    );
    expect(CANONICAL_SQL).toMatch(
      /REVOKE UPDATE, DELETE, %s, TRIGGER ON TABLE %s FROM %I/i
    );
    expect(CANONICAL_SQL).toMatch(
      /has_any_column_privilege\(v_runtime_role_name, v_table::OID, 'UPDATE'\)/i
    );
  });

  it('protects admin denial evidence with one exact GDPR-only update shape', () => {
    expect(CANONICAL_SQL).toContain(
      'HXIC6: admin actions are append-only outside exact GDPR anonymization'
    );
    expect(CANONICAL_SQL).toContain(
      "NEW.action_details = '{\"gdpr_deleted\":true}'::jsonb"
    );
    expect(CANONICAL_SQL).toContain(
      "NEW.result_details = '{\"gdpr_deleted\":true}'::jsonb"
    );
    expect(CANONICAL_SQL).toContain("user_row.account_status = 'DELETED'");
    expect(CANONICAL_SQL).toContain(
      'ALTER TABLE %s ENABLE ALWAYS TRIGGER admin_actions_destructive_guard'
    );
    expect(CANONICAL_SQL).toContain(
      'ALTER TABLE %s ENABLE ALWAYS TRIGGER admin_actions_truncate_guard'
    );
    expect(CANONICAL_SQL).toContain(
      'GRANT UPDATE (action_details, result_details) ON TABLE %s TO %I'
    );
  });

  it('binds full refunds to one durable provider claim before terminal money state', () => {
    expect(CANONICAL_SQL).toContain('refund_provider_create_claim_v1');
    expect(CANONICAL_SQL).toContain('refund_provider_claim_resolved_v1');
    expect(CANONICAL_SQL).toContain(
      "current_setting('hustlexp.refund_terminal_authority', true)"
    );
    expect(CANONICAL_SQL).toContain('jsonb_object_length(claim.metadata)=16');
    expect(CANONICAL_SQL).toContain('jsonb_object_length(witness.metadata)=10');
    expect(CANONICAL_SQL).toContain('jsonb_object_length(resolution.metadata)=16');
    expect(CANONICAL_SQL).toContain(
      "(to_jsonb(NEW)-'state'-'stripe_refund_id'-'refunded_at'-'version'-'updated_at')"
    );
    expect(CANONICAL_SQL).toContain(
      'CREATE TRIGGER active_refund_claim_accept_gate'
    );
    expect(CANONICAL_SQL).toContain(
      'ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER active_refund_claim_accept_gate'
    );
  });

  it('pins every restored function and the incident guard to the trusted search path', () => {
    for (const functionName of [
      'enforce_task_region_policy_on_accept',
      'enforce_task_worker_eligibility_on_accept',
      'enforce_controlled_test_offer_acceptance',
      'enforce_controlled_test_provider_capability_on_accept',
      'enforce_task_liquidity_cell_on_accept',
      'enforce_worker_offer_decision_on_accept',
      'reject_pr276_incident_table_mutation',
      'reject_control_table_destructive_mutation',
      'reject_escrow_event_destructive_mutation',
      'reject_admin_action_destructive_mutation',
      'enforce_no_active_refund_claim_on_accept',
      'prevent_task_terminal_mutation',
      'prevent_escrow_terminal_mutation',
      'prevent_escrow_amount_change',
      'enforce_xp_requires_released_escrow',
      'prevent_xp_ledger_delete',
      'prevent_xp_ledger_truncate',
      'enforce_released_requires_completed',
      'enforce_completed_requires_accepted_proof',
      'live_task_requires_funded_escrow',
      'live_task_price_floor',
    ]) {
      expect(CANONICAL_SQL).toContain(
        `ALTER FUNCTION public.${functionName}() SET search_path = pg_catalog, public`
      );
    }
  });

  it('pins every transitive acceptance helper without changing its declared semantics', () => {
    const helpers = [
      {
        signature: 'hxos_same_worker_proof_retake_continuation(TEXT, TEXT, UUID, UUID)',
        volatility: 'IMMUTABLE',
        parallel: 'SAFE',
      },
      {
        signature: 'hxos_local_test_liquidity_witness_current(UUID, UUID, UUID)',
        volatility: 'STABLE',
        parallel: 'UNSAFE',
      },
      {
        signature: 'hxos_local_test_provider_capability_current(UUID, UUID, UUID)',
        volatility: 'STABLE',
        parallel: 'UNSAFE',
      },
      {
        signature: 'hxos_local_test_liquidity_witness_current_v2(UUID, UUID, UUID)',
        volatility: 'STABLE',
        parallel: 'UNSAFE',
      },
      {
        signature: 'hxos_local_test_offer_action_current(UUID, UUID, UUID, TEXT)',
        volatility: 'STABLE',
        parallel: 'UNSAFE',
      },
    ] as const;

    for (const helper of helpers) {
      const prefix = `ALTER FUNCTION public.${helper.signature}`;
      expect(CANONICAL_SQL).toContain(`${prefix} SET search_path = pg_catalog, public`);
      expect(CANONICAL_SQL).toContain(`${prefix} OWNER TO CURRENT_USER`);
      expect(CANONICAL_SQL).toContain(`${prefix} SECURITY INVOKER`);
      expect(CANONICAL_SQL).toContain(`${prefix} CALLED ON NULL INPUT`);
      expect(CANONICAL_SQL).toContain(`${prefix} ${helper.volatility}`);
      expect(CANONICAL_SQL).toContain(`${prefix} PARALLEL ${helper.parallel}`);
    }
  });

  it('binds immutable cluster/database identity and the hash-ordinal migration ledger', () => {
    expect(CANONICAL_SQL).toContain('CREATE TABLE public.hx_database_identity');
    expect(CANONICAL_SQL).toMatch(/pg_catalog\.pg_control_system\(\)/i);
    expect(CANONICAL_SQL).toContain('cluster_system_identifier');
    expect(CANONICAL_SQL).toContain('database_oid');
    expect(CANONICAL_SQL).toContain('migration_owner');
    expect(CANONICAL_SQL).toContain('ALTER COLUMN ordinal SET NOT NULL');
    expect(CANONICAL_SQL).toContain('ALTER COLUMN source_sha256 SET NOT NULL');
    expect(CANONICAL_SQL).toContain('applied_migrations_ordinal_unique');
    expect(CANONICAL_SQL).toContain("source_sha256 ~ '^[a-f0-9]{64}$'");
  });

  it('makes every constitutional money/state and acceptance trigger immune to replica mode', () => {
    for (const triggerName of [
      'task_region_policy_accept_insert_gate',
      'task_region_policy_accept_gate',
      'task_worker_eligibility_accept_insert_gate',
      'task_worker_eligibility_accept_gate',
      'controlled_test_provider_capability_accept_guard',
      'controlled_test_offer_accept_guard',
      'task_liquidity_cell_accept_gate',
      'task_worker_offer_accept_gate',
      'task_terminal_guard',
      'task_completed_requires_accepted_proof',
      'live_task_escrow_check',
      'live_task_price_check',
      'escrow_terminal_guard',
      'escrow_amount_immutable',
      'escrow_released_requires_completed_task',
      'xp_requires_released_escrow',
      'xp_ledger_no_delete',
      'xp_ledger_no_truncate',
    ]) {
      expect(CANONICAL_SQL).toMatch(
        new RegExp(`ENABLE ALWAYS TRIGGER ${triggerName}`, 'i')
      );
    }
  });

  it('removes runtime mutation authority from every migrator-owned control table', () => {
    for (const tableName of [
      'public.applied_migrations',
      'public.schema_versions',
      'public.hx_database_identity',
    ]) {
      expect(CANONICAL_SQL).toContain(`'${tableName}'`);
    }
    expect(CANONICAL_SQL).toContain('ENABLE ALWAYS TRIGGER migration_control_destructive_guard');
    expect(CANONICAL_SQL).toContain('ENABLE ALWAYS TRIGGER migration_control_truncate_guard');
    expect(CANONICAL_SQL).toMatch(/REVOKE INSERT \(%I\), UPDATE \(%I\), REFERENCES \(%I\)/i);
    expect(CANONICAL_SQL).toMatch(/has_any_column_privilege\([^)]*'INSERT'/i);
    expect(CANONICAL_SQL).toMatch(/has_any_column_privilege\([^)]*'UPDATE'/i);
    expect(CANONICAL_SQL).toMatch(/has_any_column_privilege\([^)]*'REFERENCES'/i);
    for (const catalog of [
      'pg_class',
      'pg_proc',
      'pg_type',
      'pg_collation',
      'pg_conversion',
      'pg_operator',
    ]) {
      expect(CANONICAL_SQL).toMatch(new RegExp(`FROM ${catalog}\\b`, 'i'));
    }
  });
});
