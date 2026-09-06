import { CHANGE_ORDER_MATERIALIZATION_WITNESS_HASH } from './change-order-materialization-role-plans.js';
import type { QueryFn } from '../database-contracts.js';
import type { WorkOrderCommandRoleNames } from './work-order-command-role-authority.js';

// Closed retained legacy custody. These identities are not active command ports.
// Their frozen bodies remain covered by the independent semantic catalog evidence.
export const FINANCIAL_READINESS_RETAINED_FUNCTIONS = [
  {
    identity: 'public.universal_v1_change_order_recovery_revocation_reason_pre_expiry(uuid)',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: true,
  },
  {
    identity: 'public.claim_universal_v1_change_order_compensation_v1(uuid,uuid,uuid,uuid)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity: 'public.claim_universal_v1_change_order_recovery_v1(uuid,integer,integer,integer)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity: 'public.hxos_finalize_legacy_expiry_compensation_v10(uuid,uuid,uuid,uuid)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity: 'public.hxos_prepare_legacy_expiry_compensation_v10(uuid,text)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity:
      'public.hxos_record_change_order_materialization_command_v1(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,integer,integer,uuid,uuid,uuid,integer,integer,text,timestamptz)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity:
      'public.hxos_record_fake_financial_lifecycle_bridge_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity:
      'public.hxos_record_fake_financial_security_event_v1(uuid,uuid,text,uuid,text,uuid,uuid,uuid,uuid,uuid)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity:
      'public.hxos_record_fake_provider_account_fact_v1(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity:
      'public.hxos_record_fake_reconciliation_bridge_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity:
      'public.hxos_record_fake_reconciliation_fact_v1(uuid,uuid,text,uuid,text,text,uuid,uuid,uuid,uuid,uuid,text)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity:
      'public.hxos_record_fake_terminal_lifecycle_intent_v1(uuid,text,uuid,uuid,uuid,uuid,bigint,integer,text,text,uuid)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity:
      'public.hxos_record_financial_provider_command_v1(uuid,text,uuid,text,text,bigint,text,text,uuid,text,uuid,uuid,uuid,uuid,bigint,text,uuid,text,text,text,text,text,text)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity: 'public.hxos_record_financial_provider_dispatch_attempt_v1(uuid,uuid,uuid,integer)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity: 'public.hxos_record_legacy_expiry_compensation_attempt_v10(uuid)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity: 'public.normalize_financial_provider_observation_v1(uuid)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity:
      'public.record_universal_v1_change_order_compensated_recovery_v1(uuid,uuid,uuid,uuid,uuid)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity:
      'public.record_universal_v1_change_order_materialized_recovery_v1(uuid,uuid,uuid,uuid,uuid)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity:
      'public.record_universal_v1_change_order_no_effect_recovery_v1(uuid,uuid,uuid,uuid,text)',
    securityDefiner: true,
    owner: 'financeOwnerRole',
    financeExecute: false,
  },
  {
    identity: 'public.enforce_legacy_escrow_insert_containment_v1()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.enforce_universal_v1_location_access_expiry_v1()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.legacy_fake_expiry_compensation_operation_id_v9(uuid)',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: true,
  },
  {
    identity: 'public.prepare_fake_financial_legacy_expiry_attempt_v9()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.prepare_fake_financial_legacy_expiry_compensation_v9()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.reject_financial_provider_observation_mutation_v1()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.reject_provider_event_processing_evidence_mutation()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.require_legacy_expiry_compensation_before_terminal_outcome_v9()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity:
      'public.universal_v1_change_order_materialization_request_sha256(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,integer,integer,uuid,uuid,uuid)',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: true,
  },
  {
    identity: 'public.universal_v1_change_order_recovery_lease_is_active_v1(uuid,uuid,uuid)',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: true,
  },
  {
    identity: 'public.universal_v1_change_order_recovery_resolution_v1(uuid)',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: true,
  },
  {
    identity: 'public.universal_v1_change_order_recovery_revocation_reason_v1(uuid)',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: true,
  },
  {
    identity: 'public.universal_v1_change_order_recovery_uuid_v1(text,text)',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: true,
  },
  {
    identity: 'public.universal_v1_reconciliation_snapshot_sha256_v1(uuid)',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: true,
  },
  {
    identity: 'public.validate_fake_financial_legacy_expiry_outcome_v9()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.validate_financial_provider_observation_v1()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.validate_provider_event_processing_attempt()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.validate_provider_event_processing_outcome()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.validate_universal_v1_change_order_recovery_lease()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.validate_universal_v1_fake_reconciliation_bridge()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.prevent_escrow_terminal_mutation()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.prevent_escrow_amount_change()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.enforce_released_requires_completed()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.prevent_release_when_payouts_locked()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.record_task_recommendation_settlement_outcome()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.enqueue_escrow_release_reconciliation()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.enforce_escrow_payout_provider_evidence()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
  {
    identity: 'public.prevent_universal_task_escrow_binding()',
    securityDefiner: false,
    owner: 'migrationRole',
    financeExecute: false,
  },
] as const;
export const FINANCIAL_READINESS_DEFERRED_GUARDS = [
  'public.require_universal_v1_fake_reconciliation_bridge()',
  'public.require_universal_v1_double_entry_ledger_v1()',
] as const;
export const FINANCIAL_READINESS_STORAGE = [
  {
    relation: 'public.escrows',
    kind: 'table',
  },
  {
    relation: 'public.hxos_fake_financial_legacy_expiry_compensation_commands_v9',
    kind: 'table',
  },
  {
    relation: 'public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9',
    kind: 'table',
  },
  {
    relation: 'public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9',
    kind: 'table',
  },
  {
    relation: 'public.provider_event_processing_attempts',
    kind: 'table',
  },
  {
    relation: 'public.provider_event_processing_outcomes',
    kind: 'table',
  },
  {
    relation: 'public.provider_financial_observation_normalizations',
    kind: 'table',
  },
  {
    relation: 'public.provider_financial_observation_backlog_v1',
    kind: 'view',
  },
  {
    relation: 'public.universal_v1_fake_terminal_plan_steps_v1',
    kind: 'view',
  },
  {
    relation: 'public.universal_v1_fake_reconciliation_bridges',
    kind: 'table',
  },
  {
    relation: 'public.task_location_access_log',
    kind: 'table',
  },
] as const;

export const FINANCIAL_READINESS_DIGEST_DEPENDENCIES = [
  'public.digest(text,text)',
  'public.digest(bytea,text)',
] as const;

export function financialReadinessFunctionCustody(roles: WorkOrderCommandRoleNames) {
  return [
    ...FINANCIAL_READINESS_RETAINED_FUNCTIONS.map((p) => ({
      identity: p.identity,
      owner: roles[p.owner],
      security_definer: p.securityDefiner,
      configuration: p.securityDefiner
        ? [
            [
              'public.hxos_finalize_legacy_expiry_compensation_v10(uuid,uuid,uuid,uuid)',
              'public.hxos_prepare_legacy_expiry_compensation_v10(uuid,text)',
              'public.hxos_record_legacy_expiry_compensation_attempt_v10(uuid)',
            ].includes(p.identity)
              ? 'search_path=pg_catalog'
              : 'search_path=pg_catalog, public',
          ]
        : p.identity === CHANGE_ORDER_MATERIALIZATION_WITNESS_HASH
          ? ['search_path=pg_catalog']
          : null,
      allowed_execute: [
        roles[p.owner],
        ...(p.financeExecute ? [roles.financeOwnerRole] : []),
        ...(p.identity === CHANGE_ORDER_MATERIALIZATION_WITNESS_HASH
          ? [roles.commandOwnerRole]
          : []),
      ],
    })),
    ...FINANCIAL_READINESS_DIGEST_DEPENDENCIES.map((identity) => ({
      identity,
      owner: roles.financeOwnerRole,
      security_definer: false,
      configuration: null,
      allowed_execute: [roles.financeOwnerRole],
    })),
    ...FINANCIAL_READINESS_DEFERRED_GUARDS.map((identity) => ({
      identity,
      owner: roles.financeOwnerRole,
      security_definer: true,
      configuration: ['search_path=pg_catalog, public'],
      allowed_execute: [roles.financeOwnerRole],
    })),
  ];
}

export async function readFinancialReadinessCustodyViolations(
  query: QueryFn,
  roles: WorkOrderCommandRoleNames
) {
  const result = await query<{ violation_code: string }>(
    `
    /* financial_readiness_custody_v13 */
    WITH configured AS (SELECT * FROM pg_catalog.jsonb_each_text($1::jsonb)),
    expected_function AS (SELECT * FROM pg_catalog.jsonb_to_recordset($2::jsonb)
      AS x(identity text, owner text, security_definer boolean, configuration text[], allowed_execute jsonb)),
    function_catalog AS (
      SELECT p.*, n.nspname, r.rolname AS owner_name,
        pg_catalog.replace(pg_catalog.replace(pg_catalog.format('%I.%I(%s)',n.nspname,p.proname,
          pg_catalog.oidvectortypes(p.proargtypes)),'timestamp with time zone','timestamptz'),', ',',') AS identity
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    ), expected_relation AS (SELECT * FROM pg_catalog.jsonb_to_recordset($3::jsonb)
      AS x(relation text,kind text)),
    relation_catalog AS (
      SELECT e.*,c.oid,c.relkind,c.relowner,c.relacl,r.rolname AS owner_name
      FROM expected_relation e LEFT JOIN pg_catalog.pg_class c ON
        pg_catalog.format('%I.%I',(SELECT nspname FROM pg_catalog.pg_namespace WHERE oid=c.relnamespace),c.relname)=e.relation
      LEFT JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
    ), database_catalog AS (
      SELECT d.*,r.rolname AS owner_name FROM pg_catalog.pg_database d
      JOIN pg_catalog.pg_roles r ON r.oid=d.datdba WHERE d.datname=pg_catalog.current_database()
    ), violations AS (
      SELECT 'RETAINED_FUNCTION_MISSING_OR_CUSTODY_DRIFT' AS violation_code
      FROM expected_function e LEFT JOIN function_catalog f USING(identity)
      WHERE f.oid IS NULL OR f.owner_name<>e.owner OR f.prosecdef<>e.security_definer
        OR (e.security_definer AND f.proconfig IS DISTINCT FROM e.configuration)
      UNION ALL
      SELECT 'RETAINED_FUNCTION_DEPENDENCY_EXECUTE_MISSING' FROM expected_function e JOIN function_catalog f USING(identity)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(e.allowed_execute) gr(role_name)
      WHERE NOT pg_catalog.has_function_privilege(gr.role_name, f.oid, 'EXECUTE')
      UNION ALL
      SELECT 'DEFERRED_GUARD_MODE_DRIFT' FROM function_catalog f
      WHERE f.identity IN ('public.require_universal_v1_controlled_fake_lifecycle_bridge()',
        'public.require_universal_v1_fake_reconciliation_bridge()',
        'public.require_universal_v1_double_entry_ledger_v1()') AND (
        f.owner_name<>$5 OR NOT f.prosecdef OR f.provolatile<>'v' OR f.proparallel<>'u'
        OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[])
      UNION ALL
      SELECT 'RETAINED_FUNCTION_EXECUTE_GRANT' FROM expected_function e JOIN function_catalog f USING(identity)
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
      LEFT JOIN pg_catalog.pg_roles gr ON gr.oid=a.grantee
      WHERE a.grantee=0 OR NOT(e.allowed_execute ? gr.rolname)
        OR (a.is_grantable AND a.grantee<>f.proowner)
      UNION ALL
      SELECT 'RETAINED_RELATION_CUSTODY_DRIFT' FROM relation_catalog r
      WHERE r.oid IS NULL OR r.owner_name<>$4 OR r.relkind::text<>CASE r.kind WHEN 'view' THEN 'v' ELSE 'r' END
      UNION ALL
      SELECT 'RETAINED_RELATION_GRANT' FROM relation_catalog r
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(r.relacl,pg_catalog.acldefault('r',r.relowner))) a
      WHERE a.grantee<>r.relowner
      UNION ALL
      SELECT 'RETAINED_COLUMN_GRANT' FROM relation_catalog r JOIN pg_catalog.pg_attribute att ON att.attrelid=r.oid
      CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
      LEFT JOIN pg_catalog.pg_roles gr ON gr.oid=a.grantee
      WHERE a.grantee<>r.relowner AND NOT (
        r.relation='public.universal_v1_fake_reconciliation_bridges'
        AND att.attname IN ('reconciliation_fact_id','terminal_intent_id')
        AND gr.rolname=$5 AND a.privilege_type='SELECT' AND NOT a.is_grantable)
      UNION ALL
      SELECT 'DATABASE_CUSTODY_DRIFT' FROM database_catalog WHERE owner_name<>$6
      UNION ALL
      SELECT 'DATABASE_UNSAFE_GRANT' FROM database_catalog d
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a
      WHERE (a.privilege_type='CREATE' AND a.grantee<>d.datdba) OR a.privilege_type='TEMPORARY'
      UNION ALL
      SELECT 'EXTENSION_CUSTODY_DRIFT' WHERE NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_roles r ON r.oid=e.extowner
        JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
        WHERE e.extname='pgcrypto' AND e.extversion='1.3' AND n.nspname='public' AND r.rolname=$6)
      UNION ALL
      SELECT 'SCHEMA_CUSTODY_OR_GRANT_DRIFT' FROM pg_catalog.pg_namespace n
      JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
      WHERE n.nspname IN ('public','hx_authority') AND (
        r.rolname<>CASE n.nspname WHEN 'public' THEN $4 ELSE $7 END
        OR (a.grantee<>n.nspowner AND (a.privilege_type<>'USAGE' OR a.is_grantable
          OR (n.nspname='public' AND a.grantee<>0 AND NOT EXISTS (
            SELECT 1 FROM configured cfg JOIN pg_catalog.pg_roles gr
            ON gr.rolname=cfg.value WHERE gr.oid=a.grantee))
          OR (n.nspname='hx_authority' AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_roles gr WHERE gr.oid=a.grantee
              AND gr.rolname IN ($4,$5,$6,$7,$9))))))
      UNION ALL
      SELECT 'RETAINED_CUSTODIAN_DEFAULT_GRANT' FROM pg_catalog.pg_default_acl d
      JOIN pg_catalog.pg_roles r ON r.oid=d.defaclrole
      CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE r.rolname IN ($4,$5,$6,$7,$8) AND a.grantee<>d.defaclrole
      UNION ALL
      SELECT 'LEGACY_DIGEST_IDENTITY_OR_GRANT_DRIFT' FROM function_catalog f
      WHERE f.identity IN ('public.digest(text,text)','public.digest(bytea,text)') AND (
        f.owner_name<>$5 OR NOT pg_catalog.has_function_privilege($5, f.oid, 'EXECUTE')
        OR f.prosecdef OR f.provolatile<>'i' OR f.proparallel<>'s' OR NOT f.proisstrict
        OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
          WHERE d.classid='pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid=f.oid
            AND d.refclassid='pg_catalog.pg_extension'::pg_catalog.regclass AND d.deptype='e' AND e.extname='pgcrypto')
        OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
          LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
          WHERE a.grantee<>f.proowner))
      UNION ALL
      SELECT 'LEGACY_DIGEST_MISSING' WHERE (SELECT count(*) FROM function_catalog
        WHERE identity IN ('public.digest(text,text)','public.digest(bytea,text)'))<>2
    ) SELECT DISTINCT violation_code FROM violations ORDER BY violation_code`,
    [
      JSON.stringify(roles),
      JSON.stringify(financialReadinessFunctionCustody(roles)),
      JSON.stringify(FINANCIAL_READINESS_STORAGE),
      roles.migrationRole,
      roles.financeOwnerRole,
      roles.commandOwnerRole,
      roles.assertionOwnerRole,
      roles.telemetryOwnerRole,
      roles.workerRole,
    ]
  );
  return result.rows;
}
