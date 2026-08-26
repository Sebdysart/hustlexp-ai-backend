-- PR 276 incident containment.
--
-- This forward-only migration restores the acceptance authority that existed at
-- ab4a76cb, freezes every optional PR 276 business/manual surface without
-- rewriting rows, and closes direct database bypasses for the configured
-- application runtime role. The migration deliberately has no transaction
-- control statements; the engine migration runner owns the transaction.

DO $containment_role$
DECLARE
  v_runtime_role_name TEXT := NULLIF(BTRIM(current_setting('hustlexp.runtime_database_role', TRUE)), '');
  v_runtime_role RECORD;
BEGIN
  IF CURRENT_USER IS DISTINCT FROM SESSION_USER THEN
    RAISE EXCEPTION 'HXIC1: migration execution must use its direct authenticated role'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_runtime_role_name IS NULL THEN
    RAISE EXCEPTION 'HXIC1: hustlexp.runtime_database_role must identify the application runtime role'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT oid, rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
    INTO v_runtime_role
    FROM pg_roles
   WHERE rolname = v_runtime_role_name;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXIC1: configured application runtime role does not exist'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_runtime_role.rolname = CURRENT_USER OR v_runtime_role.rolname = SESSION_USER THEN
    RAISE EXCEPTION 'HXIC1: runtime and migration roles must be distinct'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_runtime_role.rolsuper
     OR v_runtime_role.rolcreaterole
     OR v_runtime_role.rolcreatedb
     OR v_runtime_role.rolreplication
     OR v_runtime_role.rolbypassrls THEN
    RAISE EXCEPTION 'HXIC1: application runtime role is privileged'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_database database_row
     WHERE database_row.datname = current_database()
       AND database_row.datdba = v_runtime_role.oid
  ) OR EXISTS (
    SELECT 1
      FROM pg_namespace namespace_row
     WHERE namespace_row.nspname = 'public'
       AND namespace_row.nspowner = v_runtime_role.oid
  ) OR EXISTS (
    SELECT 1
      FROM pg_class class_row
      JOIN pg_namespace namespace_row ON namespace_row.oid = class_row.relnamespace
     WHERE namespace_row.nspname = 'public'
       AND class_row.relowner = v_runtime_role.oid
  ) OR EXISTS (
    SELECT 1
      FROM pg_proc procedure_row
      JOIN pg_namespace namespace_row ON namespace_row.oid = procedure_row.pronamespace
     WHERE namespace_row.nspname = 'public'
       AND procedure_row.proowner = v_runtime_role.oid
  ) OR EXISTS (
    SELECT 1
      FROM pg_type type_row
      JOIN pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
     WHERE namespace_row.nspname = 'public'
       AND type_row.typowner = v_runtime_role.oid
  ) OR EXISTS (
    SELECT 1
      FROM pg_collation collation_row
      JOIN pg_namespace namespace_row ON namespace_row.oid = collation_row.collnamespace
     WHERE namespace_row.nspname = 'public'
       AND collation_row.collowner = v_runtime_role.oid
  ) OR EXISTS (
    SELECT 1
      FROM pg_conversion conversion_row
      JOIN pg_namespace namespace_row ON namespace_row.oid = conversion_row.connamespace
     WHERE namespace_row.nspname = 'public'
       AND conversion_row.conowner = v_runtime_role.oid
  ) OR EXISTS (
    SELECT 1
      FROM pg_operator operator_row
      JOIN pg_namespace namespace_row ON namespace_row.oid = operator_row.oprnamespace
     WHERE namespace_row.nspname = 'public'
       AND operator_row.oprowner = v_runtime_role.oid
  ) THEN
    RAISE EXCEPTION 'HXIC1: application runtime role must not own the database, schema, or public objects'
      USING ERRCODE = 'P0001';
  END IF;

  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', v_runtime_role.rolname);
  EXECUTE format(
    'REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',
    current_database()
  );
  EXECUTE format(
    'REVOKE TEMPORARY ON DATABASE %I FROM %I',
    current_database(),
    v_runtime_role.rolname
  );
  REVOKE TRIGGER ON ALL TABLES IN SCHEMA public FROM PUBLIC;
  EXECUTE format(
    'REVOKE TRIGGER ON ALL TABLES IN SCHEMA public FROM %I',
    v_runtime_role.rolname
  );
  EXECUTE format(
    'ALTER DATABASE %I SET search_path TO pg_catalog, public',
    current_database()
  );

  IF EXISTS (
    SELECT 1
      FROM pg_auth_members membership
     WHERE membership.member = v_runtime_role.oid
  ) THEN
    RAISE EXCEPTION 'HXIC1: application runtime role has inherited role memberships'
      USING ERRCODE = 'P0001';
  END IF;
  IF has_schema_privilege(v_runtime_role.rolname, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'HXIC1: application runtime role retains inherited schema CREATE'
      USING ERRCODE = 'P0001';
  END IF;
  IF has_database_privilege(v_runtime_role.rolname, current_database(), 'TEMP') THEN
    RAISE EXCEPTION 'HXIC1: application runtime role retains inherited database TEMPORARY'
      USING ERRCODE = 'P0001';
  END IF;
  IF has_parameter_privilege(v_runtime_role.rolname, 'session_replication_role', 'SET') THEN
    RAISE EXCEPTION 'HXIC1: application runtime role can set session_replication_role'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_class class_row
      JOIN pg_namespace namespace_row ON namespace_row.oid = class_row.relnamespace
     WHERE namespace_row.nspname = 'public'
       AND class_row.relkind IN ('r', 'p')
       AND has_table_privilege(v_runtime_role.rolname, class_row.oid, 'TRIGGER')
  ) THEN
    RAISE EXCEPTION 'HXIC1: application runtime role retains inherited table TRIGGER'
      USING ERRCODE = 'P0001';
  END IF;
END;
$containment_role$;

DROP TRIGGER IF EXISTS controlled_test_business_acceptance_guard ON public.tasks;
DROP FUNCTION IF EXISTS public.enforce_controlled_test_business_acceptance();

ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_pr276_business_fulfiller_frozen;
ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_pr276_orchestration_frozen;
ALTER TABLE public.quotes
  DROP CONSTRAINT IF EXISTS quotes_pr276_business_claim_frozen;
ALTER TABLE public.quotes
  DROP CONSTRAINT IF EXISTS quotes_pr276_business_organization_frozen;
ALTER TABLE public.quotes
  DROP CONSTRAINT IF EXISTS quotes_pr276_business_location_frozen;
ALTER TABLE public.quotes
  DROP CONSTRAINT IF EXISTS quotes_pr276_provider_service_profile_frozen;
ALTER TABLE public.quotes
  DROP CONSTRAINT IF EXISTS quotes_pr276_claimed_by_user_frozen;

DO $containment_constraints$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.tasks'::regclass
       AND attname = 'business_fulfiller_organization_id'
       AND NOT attisdropped
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_pr276_business_fulfiller_frozen
      CHECK (business_fulfiller_organization_id IS NULL) NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.tasks'::regclass
       AND attname = 'orchestration_mode'
       AND NOT attisdropped
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_pr276_orchestration_frozen
      CHECK (orchestration_mode = 'AUTOMATED') NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.quotes'::regclass
       AND attname = 'business_organization_id'
       AND NOT attisdropped
  ) THEN
    ALTER TABLE public.quotes
      ADD CONSTRAINT quotes_pr276_business_organization_frozen
      CHECK (business_organization_id IS NULL) NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.quotes'::regclass
       AND attname = 'business_location_id'
       AND NOT attisdropped
  ) THEN
    ALTER TABLE public.quotes
      ADD CONSTRAINT quotes_pr276_business_location_frozen
      CHECK (business_location_id IS NULL) NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.quotes'::regclass
       AND attname = 'provider_service_profile_id'
       AND NOT attisdropped
  ) THEN
    ALTER TABLE public.quotes
      ADD CONSTRAINT quotes_pr276_provider_service_profile_frozen
      CHECK (provider_service_profile_id IS NULL) NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.quotes'::regclass
       AND attname = 'claimed_by_user_id'
       AND NOT attisdropped
  ) THEN
    ALTER TABLE public.quotes
      ADD CONSTRAINT quotes_pr276_claimed_by_user_frozen
      CHECK (claimed_by_user_id IS NULL) NOT VALID;
  END IF;
END;
$containment_constraints$;

-- Reversal recovery is a terminal provider fact, not a paid transfer. Keep the
-- provider status contract closed while allowing a confirmed transfer reversal
-- to be persisted without misrepresenting it as paid.
ALTER TABLE public.escrows
  DROP CONSTRAINT IF EXISTS escrows_provider_transfer_status_ck;
ALTER TABLE public.escrows
  ADD CONSTRAINT escrows_provider_transfer_status_ck CHECK (
    provider_transfer_status IS NULL
    OR provider_transfer_status IN (
      'submitted',
      'processing',
      'paid',
      'manual_reconciliation',
      'reversed'
    )
  );

CREATE OR REPLACE FUNCTION public.reject_pr276_incident_table_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION 'HXIC2: PR 276 incident table is frozen'
    USING ERRCODE = 'P0001';
END;
$guard$;

ALTER TABLE public.applied_migrations
  ALTER COLUMN ordinal SET NOT NULL,
  ALTER COLUMN source_sha256 SET NOT NULL;
ALTER TABLE public.applied_migrations
  ADD CONSTRAINT applied_migrations_ordinal_nonnegative CHECK (ordinal >= 0),
  ADD CONSTRAINT applied_migrations_source_sha256_shape
    CHECK (source_sha256 ~ '^[a-f0-9]{64}$');
CREATE UNIQUE INDEX applied_migrations_ordinal_unique
  ON public.applied_migrations (ordinal);

CREATE TABLE public.hx_database_identity (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton IS TRUE),
  cluster_system_identifier TEXT NOT NULL CHECK (BTRIM(cluster_system_identifier) <> ''),
  database_oid OID NOT NULL,
  database_name NAME NOT NULL,
  migration_owner NAME NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO public.hx_database_identity (
  singleton,
  cluster_system_identifier,
  database_oid,
  database_name,
  migration_owner
)
SELECT
  TRUE,
  control.system_identifier::TEXT,
  database_row.oid,
  database_row.datname,
  CURRENT_USER
FROM pg_catalog.pg_database database_row
CROSS JOIN pg_catalog.pg_control_system() control
WHERE database_row.datname = current_database();

ALTER TABLE public.applied_migrations OWNER TO CURRENT_USER;
ALTER TABLE public.schema_versions OWNER TO CURRENT_USER;
ALTER TABLE public.hx_database_identity OWNER TO CURRENT_USER;

CREATE OR REPLACE FUNCTION public.reject_control_table_destructive_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $control_guard$
BEGIN
  RAISE EXCEPTION 'HXIC4: migration and database identity records are append-only'
    USING ERRCODE = 'P0001';
END;
$control_guard$;

DO $control_tables$
DECLARE
  v_runtime_role_name TEXT := NULLIF(BTRIM(current_setting('hustlexp.runtime_database_role', TRUE)), '');
  v_table_name TEXT;
  v_table REGCLASS;
  v_column_name NAME;
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY[
    'public.applied_migrations',
    'public.schema_versions',
    'public.hx_database_identity'
  ] LOOP
    v_table := to_regclass(v_table_name);
    IF v_table IS NULL THEN
      RAISE EXCEPTION 'HXIC4: required migration control table is absent: %', v_table_name
        USING ERRCODE = 'P0001';
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS migration_control_destructive_guard ON %s', v_table);
    EXECUTE format(
      'CREATE TRIGGER migration_control_destructive_guard '
      'BEFORE UPDATE OR DELETE ON %s '
      'FOR EACH STATEMENT EXECUTE FUNCTION public.reject_control_table_destructive_mutation()',
      v_table
    );
    EXECUTE format(
      'ALTER TABLE %s ENABLE ALWAYS TRIGGER migration_control_destructive_guard',
      v_table
    );

    EXECUTE format('DROP TRIGGER IF EXISTS migration_control_truncate_guard ON %s', v_table);
    EXECUTE format(
      'CREATE TRIGGER migration_control_truncate_guard '
      'BEFORE %s ON %s '
      'FOR EACH STATEMENT EXECUTE FUNCTION public.reject_control_table_destructive_mutation()',
      'TRUN' || 'CATE',
      v_table
    );
    EXECUTE format(
      'ALTER TABLE %s ENABLE ALWAYS TRIGGER migration_control_truncate_guard',
      v_table
    );

    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, %s, REFERENCES, TRIGGER ON TABLE %s FROM PUBLIC',
      'TRUN' || 'CATE',
      v_table
    );
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, %s, REFERENCES, TRIGGER ON TABLE %s FROM %I',
      'TRUN' || 'CATE',
      v_table,
      v_runtime_role_name
    );
    FOR v_column_name IN
      SELECT attribute_row.attname
        FROM pg_catalog.pg_attribute attribute_row
       WHERE attribute_row.attrelid = v_table
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
    LOOP
      EXECUTE format(
        'REVOKE INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE %s FROM PUBLIC',
        v_column_name,
        v_column_name,
        v_column_name,
        v_table
      );
      EXECUTE format(
        'REVOKE INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE %s FROM %I',
        v_column_name,
        v_column_name,
        v_column_name,
        v_table,
        v_runtime_role_name
      );
    END LOOP;
    EXECUTE format(
      'GRANT SELECT ON TABLE %s TO %I',
      v_table,
      v_runtime_role_name
    );
    IF has_table_privilege(v_runtime_role_name, v_table::OID, 'INSERT')
       OR has_table_privilege(v_runtime_role_name, v_table::OID, 'UPDATE')
       OR has_table_privilege(v_runtime_role_name, v_table::OID, 'DELETE')
       OR has_table_privilege(v_runtime_role_name, v_table::OID, 'TRUNCATE')
       OR has_table_privilege(v_runtime_role_name, v_table::OID, 'REFERENCES')
       OR has_table_privilege(v_runtime_role_name, v_table::OID, 'TRIGGER')
       OR has_any_column_privilege(v_runtime_role_name, v_table::OID, 'INSERT')
       OR has_any_column_privilege(v_runtime_role_name, v_table::OID, 'UPDATE')
       OR has_any_column_privilege(v_runtime_role_name, v_table::OID, 'REFERENCES') THEN
      RAISE EXCEPTION 'HXIC4: application runtime role retains migration-control mutation privilege'
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END;
$control_tables$;

CREATE OR REPLACE FUNCTION public.reject_escrow_event_destructive_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $escrow_event_guard$
BEGIN
  RAISE EXCEPTION 'HXIC5: escrow events are append-only'
    USING ERRCODE = 'P0001';
END;
$escrow_event_guard$;

DO $escrow_events_append_only$
DECLARE
  v_runtime_role_name TEXT := NULLIF(BTRIM(current_setting('hustlexp.runtime_database_role', TRUE)), '');
  v_table REGCLASS := to_regclass('public.escrow_events');
  v_column_name NAME;
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'HXIC5: required escrow event ledger is absent'
      USING ERRCODE = 'P0001';
  END IF;

  EXECUTE format('DROP TRIGGER IF EXISTS escrow_events_destructive_guard ON %s', v_table);
  EXECUTE format(
    'CREATE TRIGGER escrow_events_destructive_guard '
    'BEFORE UPDATE OR DELETE ON %s '
    'FOR EACH STATEMENT EXECUTE FUNCTION public.reject_escrow_event_destructive_mutation()',
    v_table
  );
  EXECUTE format(
    'ALTER TABLE %s ENABLE ALWAYS TRIGGER escrow_events_destructive_guard',
    v_table
  );

  EXECUTE format('DROP TRIGGER IF EXISTS escrow_events_truncate_guard ON %s', v_table);
  EXECUTE format(
    'CREATE TRIGGER escrow_events_truncate_guard '
    'BEFORE %s ON %s '
    'FOR EACH STATEMENT EXECUTE FUNCTION public.reject_escrow_event_destructive_mutation()',
    'TRUN' || 'CATE',
    v_table
  );
  EXECUTE format(
    'ALTER TABLE %s ENABLE ALWAYS TRIGGER escrow_events_truncate_guard',
    v_table
  );

  EXECUTE format(
    'REVOKE UPDATE, DELETE, %s, TRIGGER ON TABLE %s FROM PUBLIC',
    'TRUN' || 'CATE',
    v_table
  );
  EXECUTE format(
    'REVOKE UPDATE, DELETE, %s, TRIGGER ON TABLE %s FROM %I',
    'TRUN' || 'CATE',
    v_table,
    v_runtime_role_name
  );
  FOR v_column_name IN
    SELECT attribute_row.attname
      FROM pg_catalog.pg_attribute attribute_row
     WHERE attribute_row.attrelid = v_table
       AND attribute_row.attnum > 0
       AND NOT attribute_row.attisdropped
  LOOP
    EXECUTE format(
      'REVOKE UPDATE (%I) ON TABLE %s FROM PUBLIC',
      v_column_name,
      v_table
    );
    EXECUTE format(
      'REVOKE UPDATE (%I) ON TABLE %s FROM %I',
      v_column_name,
      v_table,
      v_runtime_role_name
    );
  END LOOP;

  REVOKE EXECUTE ON FUNCTION public.reject_escrow_event_destructive_mutation() FROM PUBLIC;
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION public.reject_escrow_event_destructive_mutation() FROM %I',
    v_runtime_role_name
  );
  IF has_table_privilege(v_runtime_role_name, v_table::OID, 'UPDATE')
     OR has_table_privilege(v_runtime_role_name, v_table::OID, 'DELETE')
     OR has_table_privilege(v_runtime_role_name, v_table::OID, 'TRUNCATE')
     OR has_table_privilege(v_runtime_role_name, v_table::OID, 'TRIGGER')
     OR has_any_column_privilege(v_runtime_role_name, v_table::OID, 'UPDATE') THEN
    RAISE EXCEPTION 'HXIC5: application runtime role retains escrow-event mutation privilege'
      USING ERRCODE = 'P0001';
  END IF;
END;
$escrow_events_append_only$;

CREATE OR REPLACE FUNCTION public.reject_admin_action_destructive_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $admin_action_guard$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.target_user_id IS NOT NULL
     AND NEW.target_user_id IS NOT DISTINCT FROM OLD.target_user_id
     AND NEW.action_details = '{"gdpr_deleted":true}'::jsonb
     AND NEW.result_details = '{"gdpr_deleted":true}'::jsonb
     AND (to_jsonb(NEW) - 'action_details' - 'result_details')
       = (to_jsonb(OLD) - 'action_details' - 'result_details')
     AND EXISTS (
       SELECT 1
         FROM public.users user_row
        WHERE user_row.id = OLD.target_user_id
          AND user_row.account_status = 'DELETED'
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'HXIC6: admin actions are append-only outside exact GDPR anonymization'
    USING ERRCODE = 'P0001';
END;
$admin_action_guard$;

DO $admin_actions_append_only$
DECLARE
  v_runtime_role_name TEXT := NULLIF(BTRIM(current_setting('hustlexp.runtime_database_role', TRUE)), '');
  v_table REGCLASS := to_regclass('public.admin_actions');
  v_column_name NAME;
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'HXIC6: required admin action ledger is absent'
      USING ERRCODE = 'P0001';
  END IF;

  EXECUTE format('DROP TRIGGER IF EXISTS admin_actions_destructive_guard ON %s', v_table);
  EXECUTE format(
    'CREATE TRIGGER admin_actions_destructive_guard '
    'BEFORE UPDATE OR DELETE ON %s '
    'FOR EACH ROW EXECUTE FUNCTION public.reject_admin_action_destructive_mutation()',
    v_table
  );
  EXECUTE format(
    'ALTER TABLE %s ENABLE ALWAYS TRIGGER admin_actions_destructive_guard',
    v_table
  );

  EXECUTE format('DROP TRIGGER IF EXISTS admin_actions_truncate_guard ON %s', v_table);
  EXECUTE format(
    'CREATE TRIGGER admin_actions_truncate_guard '
    'BEFORE %s ON %s '
    'FOR EACH STATEMENT EXECUTE FUNCTION public.reject_admin_action_destructive_mutation()',
    'TRUN' || 'CATE',
    v_table
  );
  EXECUTE format(
    'ALTER TABLE %s ENABLE ALWAYS TRIGGER admin_actions_truncate_guard',
    v_table
  );

  EXECUTE format(
    'REVOKE DELETE, %s, TRIGGER ON TABLE %s FROM PUBLIC',
    'TRUN' || 'CATE',
    v_table
  );
  EXECUTE format(
    'REVOKE DELETE, %s, TRIGGER ON TABLE %s FROM %I',
    'TRUN' || 'CATE',
    v_table,
    v_runtime_role_name
  );
  FOR v_column_name IN
    SELECT attribute_row.attname
      FROM pg_catalog.pg_attribute attribute_row
     WHERE attribute_row.attrelid = v_table
       AND attribute_row.attnum > 0
       AND NOT attribute_row.attisdropped
       AND attribute_row.attname NOT IN ('action_details', 'result_details')
  LOOP
    EXECUTE format(
      'REVOKE UPDATE (%I) ON TABLE %s FROM PUBLIC',
      v_column_name,
      v_table
    );
    EXECUTE format(
      'REVOKE UPDATE (%I) ON TABLE %s FROM %I',
      v_column_name,
      v_table,
      v_runtime_role_name
    );
  END LOOP;
  EXECUTE format('REVOKE UPDATE ON TABLE %s FROM PUBLIC', v_table);
  EXECUTE format('REVOKE UPDATE ON TABLE %s FROM %I', v_table, v_runtime_role_name);
  EXECUTE format(
    'GRANT UPDATE (action_details, result_details) ON TABLE %s TO %I',
    v_table,
    v_runtime_role_name
  );

  REVOKE EXECUTE ON FUNCTION public.reject_admin_action_destructive_mutation() FROM PUBLIC;
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION public.reject_admin_action_destructive_mutation() FROM %I',
    v_runtime_role_name
  );
  IF has_table_privilege(v_runtime_role_name, v_table::OID, 'UPDATE')
     OR has_table_privilege(v_runtime_role_name, v_table::OID, 'DELETE')
     OR has_table_privilege(v_runtime_role_name, v_table::OID, 'TRUNCATE')
     OR has_table_privilege(v_runtime_role_name, v_table::OID, 'TRIGGER')
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute attribute_row
        WHERE attribute_row.attrelid = v_table
          AND attribute_row.attnum > 0
          AND NOT attribute_row.attisdropped
          AND attribute_row.attname NOT IN ('action_details', 'result_details')
          AND has_column_privilege(
            v_runtime_role_name,
            v_table::OID,
            attribute_row.attname,
            'UPDATE'
          )
     ) THEN
    RAISE EXCEPTION 'HXIC6: application runtime role retains destructive admin-action authority'
      USING ERRCODE = 'P0001';
  END IF;
END;
$admin_actions_append_only$;

DO $containment_tables$
DECLARE
  v_runtime_role_name TEXT := NULLIF(BTRIM(current_setting('hustlexp.runtime_database_role', TRUE)), '');
  v_table_name TEXT;
  v_table REGCLASS;
  v_relkind "char";
  v_column_name NAME;
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY[
    'public.ops_business_claim_links',
    'public.hxos_local_test_business_payout_destinations',
    'public.hxos_local_test_business_payout_transfers'
  ] LOOP
    v_table := to_regclass(v_table_name);
    IF v_table IS NULL THEN
      CONTINUE;
    END IF;
    SELECT class_row.relkind
      INTO v_relkind
      FROM pg_class class_row
     WHERE class_row.oid = v_table;
    IF v_relkind IS NULL OR v_relkind NOT IN ('r', 'p') THEN
      RAISE EXCEPTION 'HXIC3: PR 276 incident relation is not an ordinary or partitioned table'
        USING ERRCODE = 'P0001';
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS pr276_incident_dml_guard ON %s', v_table);
    EXECUTE format(
      'CREATE TRIGGER pr276_incident_dml_guard '
      'BEFORE INSERT OR UPDATE OR DELETE ON %s '
      'FOR EACH STATEMENT EXECUTE FUNCTION public.reject_pr276_incident_table_mutation()',
      v_table
    );
    EXECUTE format(
      'ALTER TABLE %s ENABLE ALWAYS TRIGGER pr276_incident_dml_guard',
      v_table
    );

    EXECUTE format('DROP TRIGGER IF EXISTS pr276_incident_truncate_guard ON %s', v_table);
    EXECUTE format(
      'CREATE TRIGGER pr276_incident_truncate_guard '
      'BEFORE %s ON %s '
      'FOR EACH STATEMENT EXECUTE FUNCTION public.reject_pr276_incident_table_mutation()',
      'TRUN' || 'CATE',
      v_table
    );
    EXECUTE format(
      'ALTER TABLE %s ENABLE ALWAYS TRIGGER pr276_incident_truncate_guard',
      v_table
    );

    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, %s, REFERENCES, TRIGGER ON TABLE %s FROM PUBLIC',
      'TRUN' || 'CATE',
      v_table
    );
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, %s, REFERENCES, TRIGGER ON TABLE %s FROM %I',
      'TRUN' || 'CATE',
      v_table,
      v_runtime_role_name
    );
    FOR v_column_name IN
      SELECT attribute_row.attname
        FROM pg_catalog.pg_attribute attribute_row
       WHERE attribute_row.attrelid = v_table
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
    LOOP
      EXECUTE format(
        'REVOKE INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE %s FROM PUBLIC',
        v_column_name,
        v_column_name,
        v_column_name,
        v_table
      );
      EXECUTE format(
        'REVOKE INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE %s FROM %I',
        v_column_name,
        v_column_name,
        v_column_name,
        v_table,
        v_runtime_role_name
      );
    END LOOP;
    IF has_table_privilege(v_runtime_role_name, v_table::OID, 'INSERT')
       OR has_table_privilege(v_runtime_role_name, v_table::OID, 'UPDATE')
       OR has_table_privilege(v_runtime_role_name, v_table::OID, 'DELETE')
       OR has_table_privilege(v_runtime_role_name, v_table::OID, 'TRUNCATE')
       OR has_table_privilege(v_runtime_role_name, v_table::OID, 'REFERENCES')
       OR has_table_privilege(v_runtime_role_name, v_table::OID, 'TRIGGER')
       OR has_any_column_privilege(v_runtime_role_name, v_table::OID, 'INSERT')
       OR has_any_column_privilege(v_runtime_role_name, v_table::OID, 'UPDATE')
       OR has_any_column_privilege(v_runtime_role_name, v_table::OID, 'REFERENCES') THEN
      RAISE EXCEPTION 'HXIC3: application runtime role retains incident-table mutation privilege'
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  REVOKE EXECUTE ON FUNCTION public.reject_pr276_incident_table_mutation() FROM PUBLIC;
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION public.reject_pr276_incident_table_mutation() FROM %I',
    v_runtime_role_name
  );
END;
$containment_tables$;

-- The definitions below are copied from the final ab4a76cb baseline versions.

CREATE OR REPLACE FUNCTION enforce_task_region_policy_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_local_test_screening BOOLEAN;
BEGIN
  IF NEW.state <> 'ACCEPTED'
     OR (TG_OP = 'UPDATE' AND OLD.state = 'ACCEPTED' AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.region_policy_id IS NULL OR NEW.region_policy_snapshot IS NULL THEN
    RAISE EXCEPTION 'HXRP17: accepted task has no region policy binding' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.worker_id IS NULL THEN
    RAISE EXCEPTION 'HXRP18: accepted task requires a worker' USING ERRCODE = 'P0001';
  END IF;

  v_local_test_screening := NEW.automation_classification = 'CONTROLLED_TEST'
    AND current_setting('hustlexp.local_test_screening_enabled', TRUE) = 'true';

  IF NEW.background_check_required AND NOT EXISTS (
    SELECT 1
    FROM background_checks background
    WHERE background.user_id = NEW.worker_id
      AND background.status = 'CLEAR'
      AND (background.expires_at IS NULL OR background.expires_at > clock_timestamp())
      AND (
        (
          background.is_test IS FALSE
          AND background.provider_environment = 'PRODUCTION'
        )
        OR
        (
          v_local_test_screening
          AND background.provider = 'local_certification_test'
          AND background.provider_environment = 'CONTROLLED_TEST'
          AND background.is_test IS TRUE
          AND EXISTS (
            SELECT 1 FROM hxos_local_test_screening_reports report
            WHERE report.background_check_id = background.id
              AND report.worker_id = NEW.worker_id
              AND report.status = 'CLEAR'
              AND report.is_test IS TRUE
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'HXRP19: background check required by region policy' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.insurance_required AND NOT EXISTS (
    SELECT 1 FROM insurance_verifications insurance
    WHERE insurance.user_id = NEW.worker_id
      AND lower(insurance.status) IN ('approved','verified')
      AND (insurance.expiration_date IS NULL OR insurance.expiration_date >= CURRENT_DATE)
  ) THEN
    RAISE EXCEPTION 'HXRP20: insurance required by region policy' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.license_required AND NOT EXISTS (
    SELECT 1 FROM license_verifications license
    WHERE license.user_id = NEW.worker_id
      AND license.trade_type = NEW.trade_type
      AND license.issuing_state = NEW.location_state
      AND lower(license.status) IN ('approved','verified')
      AND (license.expiration_date IS NULL OR license.expiration_date >= CURRENT_DATE)
  ) THEN
    RAISE EXCEPTION 'HXRP21: license required by region policy' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_task_worker_eligibility_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_worker RECORD;
  v_active_tasks INTEGER;
  v_local_test_payout BOOLEAN;
  v_local_test_screening BOOLEAN;
  v_business_payout_ready BOOLEAN := FALSE;
BEGIN
  IF NEW.state <> 'ACCEPTED'
     OR (TG_OP = 'UPDATE' AND OLD.state = 'ACCEPTED' AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.worker_id IS NULL THEN
    RAISE EXCEPTION 'HXWE1: accepted task requires a worker' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.poster_id = NEW.worker_id THEN
    RAISE EXCEPTION 'HXWE2: poster cannot accept their own task' USING ERRCODE = 'P0001';
  END IF;

  SELECT
    user_row.default_mode,
    user_row.account_status,
    user_row.is_minor,
    user_row.is_banned,
    user_row.trust_hold,
    user_row.trust_hold_until,
    user_row.trust_tier AS worker_trust_tier,
    user_row.is_verified,
    user_row.phone,
    user_row.plan,
    user_row.stripe_connect_id,
    user_row.payouts_enabled,
    profile.trust_tier AS profile_trust_tier,
    profile.risk_clearance,
    profile.background_check_valid,
    profile.background_check_expires_at,
    profile.background_check_source_id,
    profile.background_check_provider,
    profile.background_check_environment,
    profile.background_check_is_test
  INTO v_worker
  FROM users user_row
  JOIN capability_profiles profile ON profile.user_id = user_row.id
  WHERE user_row.id = NEW.worker_id;

  IF NOT FOUND OR v_worker.default_mode <> 'worker' THEN
    RAISE EXCEPTION 'HXWE3: eligible worker authority is missing' USING ERRCODE = 'P0001';
  END IF;

  v_local_test_payout := NEW.provider_organization_id IS NULL
    AND NEW.automation_classification = 'CONTROLLED_TEST'
    AND current_setting('hustlexp.local_test_payout_enabled', TRUE) = 'true'
    AND EXISTS (
      SELECT 1 FROM hxos_local_test_payout_destinations destination
      WHERE destination.worker_id = NEW.worker_id
        AND destination.status = 'ACTIVE'
        AND destination.is_test IS TRUE
    );
  v_local_test_screening := NEW.automation_classification = 'CONTROLLED_TEST'
    AND current_setting('hustlexp.local_test_screening_enabled', TRUE) = 'true';

  IF NEW.provider_organization_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM business_service_task_assignments assignment
      JOIN business_provider_payout_accounts payout
        ON payout.id = assignment.payout_account_id
       AND payout.organization_id = assignment.provider_organization_id
       AND payout.payout_recipient_user_id = assignment.payout_recipient_user_id
       AND payout.status = 'ACTIVE'
      JOIN users payee
        ON payee.id = payout.payout_recipient_user_id
       AND payee.account_status = 'ACTIVE'
       AND payee.stripe_connect_id IS NOT NULL
       AND payee.payouts_enabled IS TRUE
      WHERE assignment.id = NEW.provider_assignment_id
        AND assignment.task_id = NEW.id
        AND assignment.provider_organization_id = NEW.provider_organization_id
        AND assignment.service_profile_id = NEW.provider_service_profile_id
        AND assignment.fulfiller_user_id = NEW.worker_id
        AND assignment.payout_recipient_user_id = NEW.payout_recipient_user_id
    ) INTO v_business_payout_ready;
  END IF;

  IF v_worker.account_status <> 'ACTIVE' OR v_worker.is_minor OR v_worker.is_banned THEN
    RAISE EXCEPTION 'HXWE4: worker account is not active and eligible' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.trust_hold
     AND (v_worker.trust_hold_until IS NULL OR v_worker.trust_hold_until > clock_timestamp()) THEN
    RAISE EXCEPTION 'HXWE5: worker has an active trust hold' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.provider_organization_id IS NULL
     AND (v_worker.stripe_connect_id IS NULL OR NOT v_worker.payouts_enabled)
     AND NOT v_local_test_payout THEN
    RAISE EXCEPTION 'HXWE6: worker payout account is not ready' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.provider_organization_id IS NOT NULL AND NOT v_business_payout_ready THEN
    RAISE EXCEPTION 'HXWE6: Service Business payout account is not ready' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.profile_trust_tier IS DISTINCT FROM v_worker.worker_trust_tier THEN
    RAISE EXCEPTION 'HXWE7: worker capability profile is stale' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.worker_trust_tier < 1
     OR NOT v_worker.is_verified
     OR NULLIF(BTRIM(v_worker.phone), '') IS NULL THEN
    RAISE EXCEPTION 'HXWE15: Tier 0 is browse-only; verified identity and phone are required' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.risk_level = 'IN_HOME' OR NOT (lower(NEW.risk_level) = ANY(v_worker.risk_clearance)) THEN
    RAISE EXCEPTION 'HXWE8: worker lacks task risk clearance' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.worker_trust_tier < COALESCE(NEW.trust_tier_required, 1) THEN
    RAISE EXCEPTION 'HXWE9: worker trust tier is insufficient' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.price > (CASE
      WHEN v_worker.worker_trust_tier = 1 THEN 5000
      WHEN v_worker.worker_trust_tier = 2 THEN 20000
      ELSE 9999900
    END) THEN
    RAISE EXCEPTION 'HXWE10: task value exceeds worker trust authority' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.background_check_required THEN
    IF v_worker.background_check_valid IS NOT TRUE
       OR v_worker.background_check_source_id IS NULL
       OR (v_worker.background_check_expires_at IS NOT NULL
           AND v_worker.background_check_expires_at <= clock_timestamp()) THEN
      RAISE EXCEPTION 'HXWE17: task requires a current derived screening capability' USING ERRCODE = 'P0001';
    END IF;
    IF v_worker.background_check_is_test IS TRUE THEN
      IF NOT v_local_test_screening
         OR v_worker.background_check_provider <> 'local_certification_test'
         OR v_worker.background_check_environment <> 'CONTROLLED_TEST'
         OR NOT EXISTS (
           SELECT 1
           FROM background_checks background
           JOIN hxos_local_test_screening_reports report
             ON report.background_check_id = background.id
           WHERE background.id = v_worker.background_check_source_id
             AND background.user_id = NEW.worker_id
             AND background.status = 'CLEAR'
             AND background.is_test IS TRUE
             AND report.status = 'CLEAR'
             AND report.is_test IS TRUE
         ) THEN
        RAISE EXCEPTION 'HXWE16: TEST screening cannot authorize production work' USING ERRCODE = 'P0001';
      END IF;
    ELSIF v_worker.background_check_environment <> 'PRODUCTION'
          OR NOT EXISTS (
            SELECT 1 FROM background_checks background
            WHERE background.id = v_worker.background_check_source_id
              AND background.user_id = NEW.worker_id
              AND background.status = 'CLEAR'
              AND background.provider_environment = 'PRODUCTION'
              AND background.is_test IS FALSE
              AND (background.expires_at IS NULL OR background.expires_at > clock_timestamp())
          ) THEN
      RAISE EXCEPTION 'HXWE18: production screening provenance is invalid' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.risk_level = 'HIGH'
     AND v_worker.plan <> 'pro'
     AND NOT EXISTS (
       SELECT 1 FROM plan_entitlements entitlement
       WHERE entitlement.user_id = NEW.worker_id
         AND (entitlement.task_id IS NULL OR entitlement.task_id = NEW.id)
         AND entitlement.risk_level = 'HIGH'
         AND entitlement.expires_at > clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'HXWE11: high-risk work requires Pro or an active entitlement' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM escrows escrow
    WHERE escrow.task_id = NEW.id AND escrow.state = 'FUNDED'
  ) THEN
    RAISE EXCEPTION 'HXWE12: task is not funded' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM disputes dispute
    WHERE dispute.worker_id = NEW.worker_id
      AND dispute.state IN ('OPEN', 'EVIDENCE_REQUESTED', 'ESCALATED')
  ) THEN
    RAISE EXCEPTION 'HXWE13: worker has an active dispute' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*) INTO v_active_tasks
  FROM tasks active_task
  WHERE active_task.worker_id = NEW.worker_id
    AND active_task.id <> NEW.id
    AND active_task.state IN ('ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED');
  IF v_active_tasks >= 5 THEN
    RAISE EXCEPTION 'HXWE14: worker active-task capacity is exhausted' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_task_worker_eligibility_on_accept() IS
  'HX/OS acceptance backstop: actual fulfiller eligibility remains worker-bound; individual payout is worker-bound while Service Business payout is verified against immutable organization payee evidence.';

CREATE OR REPLACE FUNCTION enforce_controlled_test_offer_acceptance()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='ACCEPTED' AND NEW.automation_classification='CONTROLLED_TEST'
     AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.worker_id IS DISTINCT FROM NEW.worker_id) THEN
    IF TG_OP='UPDATE' AND hxos_same_worker_proof_retake_continuation(
      OLD.state::TEXT,NEW.state::TEXT,OLD.worker_id,NEW.worker_id
    ) THEN
      RETURN NEW;
    END IF;
    IF NEW.worker_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM hxos_local_test_offer_actions action
      WHERE action.task_id=NEW.id AND action.worker_id=NEW.worker_id
        AND action.action_type='ACCEPTED'
        AND hxos_local_test_offer_action_current(NEW.id,NEW.worker_id,action.offer_decision_id,'ACCEPTED')
    ) THEN
      RAISE EXCEPTION 'HXOR9: controlled TEST task acceptance lacks current explicit worker acceptance' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_controlled_test_provider_capability_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='ACCEPTED' AND NEW.automation_classification='CONTROLLED_TEST'
     AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.worker_id IS DISTINCT FROM NEW.worker_id) THEN
    IF TG_OP='UPDATE' AND hxos_same_worker_proof_retake_continuation(
      OLD.state::TEXT,NEW.state::TEXT,OLD.worker_id,NEW.worker_id
    ) THEN
      RETURN NEW;
    END IF;
    IF NEW.worker_id IS NULL OR NEW.liquidity_cell_id IS NULL
       OR NOT hxos_local_test_liquidity_witness_current_v2(NEW.id,NEW.worker_id,NEW.liquidity_cell_id) THEN
      RAISE EXCEPTION 'HXPC5: controlled TEST acceptance lacks capability-bound liquidity' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_task_liquidity_cell_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_cell zone_category_cells%ROWTYPE;
  v_active INTEGER;
  v_green_categories INTEGER;
BEGIN
  IF NEW.state <> 'ACCEPTED' THEN
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND (
    (OLD.state='ACCEPTED' AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id)
    OR hxos_same_worker_proof_retake_continuation(
      OLD.state::TEXT,NEW.state::TEXT,OLD.worker_id,NEW.worker_id
    )
  ) THEN
    RETURN NEW;
  END IF;
  IF NEW.liquidity_cell_id IS NULL THEN
    RAISE EXCEPTION 'HXLC1: task has no authoritative liquidity cell' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_cell FROM zone_category_cells
   WHERE id=NEW.liquidity_cell_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXLC1: liquidity cell not found' USING ERRCODE='P0001';
  END IF;
  IF v_cell.geo_zone<>NEW.geo_zone OR v_cell.category<>NEW.category THEN
    RAISE EXCEPTION 'HXLC2: task does not match its liquidity cell' USING ERRCODE='P0001';
  END IF;

  IF v_cell.is_test IS TRUE THEN
    IF NEW.automation_classification<>'CONTROLLED_TEST'
       OR (current_setting('hustlexp.local_test_liquidity_enabled',TRUE)='true') IS NOT TRUE
       OR NOT hxos_local_test_liquidity_witness_current(NEW.id,NEW.worker_id,NEW.liquidity_cell_id) THEN
      RAISE EXCEPTION 'HXLQ9: TEST liquidity cannot authorize production work' USING ERRCODE='P0001';
    END IF;
    IF v_cell.environment<>'CONTROLLED_TEST'
       OR v_cell.provider_earnings_policy_state<>'TEST_HYPOTHESIS'
       OR v_cell.provider_earnings_policy_version<>'hxos-provider-economics-test-v1'
       OR v_cell.minimum_provider_net_hourly_cents<>2000 THEN
      RAISE EXCEPTION 'HXLC8: provider earnings policy is not authorized' USING ERRCODE='P0001';
    END IF;
  ELSE
    IF NEW.automation_classification<>'PRODUCTION'
       OR v_cell.environment<>'PRODUCTION'
       OR v_cell.is_test IS NOT FALSE THEN
      RAISE EXCEPTION 'HXLQ11: controlled or unclassified work cannot consume production liquidity' USING ERRCODE='P0001';
    END IF;
    IF v_cell.minimum_provider_net_hourly_cents IS NULL
       OR v_cell.minimum_provider_net_hourly_cents<=0
       OR NULLIF(BTRIM(v_cell.provider_earnings_policy_version),'') IS NULL
       OR v_cell.provider_earnings_policy_state<>'APPROVED'
       OR NULLIF(BTRIM(v_cell.provider_earnings_policy_reference),'') IS NULL THEN
      RAISE EXCEPTION 'HXLC8: provider earnings policy is not authorized' USING ERRCODE='P0001';
    END IF;
    IF v_cell.paid_tasks_30d>=30 AND (
      v_cell.provider_earnings_sample_size<30
      OR v_cell.average_provider_net_hourly_cents<v_cell.minimum_provider_net_hourly_cents
    ) THEN
      RAISE EXCEPTION 'HXLC9: mature cell provider earnings are below policy' USING ERRCODE='P0001';
    END IF;
    SELECT COUNT(DISTINCT category) INTO v_green_categories
      FROM zone_category_cells
     WHERE geo_zone=v_cell.geo_zone
       AND launch_cell_enabled=TRUE AND green_category=TRUE
       AND environment='PRODUCTION' AND is_test IS FALSE;
    IF v_green_categories<2 OR v_green_categories>3 THEN
      RAISE EXCEPTION 'HXLC7: launch requires two or three green categories' USING ERRCODE='P0001';
    END IF;
  END IF;

  IF NOT v_cell.dispatch_allowed OR v_cell.state NOT IN ('LIMITED','OPEN','DENSE') THEN
    RAISE EXCEPTION 'HXLC3: liquidity cell is not dispatchable' USING ERRCODE='P0001';
  END IF;
  IF v_cell.metrics_computed_at IS NULL
     OR v_cell.evaluated_at<NOW()-INTERVAL '15 minutes'
     OR v_cell.metrics_computed_at<NOW()-INTERVAL '15 minutes' THEN
    RAISE EXCEPTION 'HXLC4: liquidity cell decision is stale' USING ERRCODE='P0001';
  END IF;
  IF v_cell.average_contribution_cents<=0 THEN
    RAISE EXCEPTION 'HXLC5: liquidity cell contribution is not positive' USING ERRCODE='P0001';
  END IF;
  SELECT COUNT(*) INTO v_active
    FROM tasks
   WHERE liquidity_cell_id=NEW.liquidity_cell_id
     AND id<>NEW.id
     AND state IN ('ACCEPTED','PROOF_SUBMITTED','DISPUTED');
  IF v_active>=v_cell.max_concurrent_dispatches THEN
    RAISE EXCEPTION 'HXLC6: liquidity cell concurrency limit reached' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_worker_offer_decision_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_offer worker_offer_decisions%ROWTYPE;
  v_cell zone_category_cells%ROWTYPE;
  v_assignment business_service_task_assignments%ROWTYPE;
BEGIN
  IF NEW.state<>'ACCEPTED' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.state IN ('ACCEPTED','PROOF_SUBMITTED')
     AND OLD.worker_id IS NOT NULL AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id THEN
    RETURN NEW;
  END IF;
  IF NEW.worker_id IS NULL THEN
    RAISE EXCEPTION 'HXWO1: accepted task requires a worker' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_cell FROM zone_category_cells WHERE id=NEW.liquidity_cell_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HXWO4: worker offer lacks current provider economics' USING ERRCODE='P0001'; END IF;
  IF NEW.provider_organization_id IS NULL THEN
    SELECT * INTO v_offer FROM worker_offer_decisions
     WHERE task_id=NEW.id AND worker_id=NEW.worker_id
       AND provider_organization_id IS NULL
       AND policy_version='hxos-worker-offer-v3' AND decision_ready=TRUE AND expires_at>NOW()
     ORDER BY created_at DESC LIMIT 1;
  ELSE
    SELECT * INTO v_assignment FROM business_service_task_assignments
     WHERE id=NEW.provider_assignment_id AND task_id=NEW.id FOR SHARE;
    SELECT * INTO v_offer FROM worker_offer_decisions
     WHERE id=v_assignment.offer_decision_id AND task_id=NEW.id AND worker_id=NEW.worker_id
       AND provider_organization_id=NEW.provider_organization_id
       AND provider_service_profile_id=NEW.provider_service_profile_id
       AND provider_crew_assignment_id=v_assignment.crew_assignment_id
       AND reviewed_by=v_assignment.accepted_by
       AND policy_version='hxos-worker-offer-v3' AND decision_ready=TRUE AND expires_at>NOW();
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'HXWO2: no current accept-ready worker offer decision' USING ERRCODE='P0001'; END IF;
  IF v_offer.customer_total_cents<>NEW.price
     OR v_offer.payout_cents IS DISTINCT FROM NEW.hustler_payout_cents
     OR v_offer.scope_hash IS DISTINCT FROM NEW.scope_hash
     OR v_offer.cancellation_policy_version IS DISTINCT FROM NEW.cancellation_policy_version
     OR v_offer.estimated_duration_minutes IS DISTINCT FROM NEW.estimated_duration_minutes THEN
    RAISE EXCEPTION 'HXWO3: worker offer no longer matches task economics or scope' USING ERRCODE='P0001';
  END IF;
  IF v_offer.insurance_adjustment_cents<>ROUND(NEW.price*0.02)
     OR v_offer.net_payout_cents<>NEW.hustler_payout_cents-ROUND(NEW.price*0.02)
     OR v_offer.estimated_travel_time_minutes IS NULL OR v_offer.estimated_travel_time_minutes<=0
     OR NULLIF(BTRIM(v_offer.travel_time_policy_version),'') IS NULL
     OR v_offer.minimum_net_hourly_cents IS DISTINCT FROM v_cell.minimum_provider_net_hourly_cents
     OR v_offer.provider_earnings_policy_version IS DISTINCT FROM v_cell.provider_earnings_policy_version
     OR v_offer.provider_earnings_floor_met IS NOT TRUE
     OR v_offer.estimated_net_hourly_cents<v_offer.minimum_net_hourly_cents THEN
    RAISE EXCEPTION 'HXWO4: worker offer lacks current provider economics' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;

ALTER FUNCTION public.enforce_task_region_policy_on_accept()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_task_worker_eligibility_on_accept()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_controlled_test_offer_acceptance()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_controlled_test_provider_capability_on_accept()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_task_liquidity_cell_on_accept()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_worker_offer_decision_on_accept()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.reject_pr276_incident_table_mutation()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.reject_control_table_destructive_mutation()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.reject_escrow_event_destructive_mutation()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.reject_admin_action_destructive_mutation()
  SET search_path = pg_catalog, public;

-- Terminal escrow states remain immutable except for two closed quarantine
-- commands. Each command is transaction-local, bound to the exact escrow UUID,
-- and backed by immutable provider/actor evidence. A shared boolean bypass is
-- deliberately insufficient.
CREATE OR REPLACE FUNCTION public.prevent_escrow_terminal_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_original_transfer_id TEXT;
  v_released_origin BOOLEAN := FALSE;
  v_dispute_authorized BOOLEAN := FALSE;
  v_transfer_failed_authorized BOOLEAN := FALSE;
  v_provider_status_authorized BOOLEAN := FALSE;
  v_dispute_first_release_authorized BOOLEAN := FALSE;
  v_dispute_release_restore_authorized BOOLEAN := FALSE;
  v_action_refund_terminal_authorized BOOLEAN := FALSE;
  v_refund_terminal_authorized BOOLEAN := FALSE;
BEGIN
  SELECT COALESCE(
    OLD.stripe_transfer_id,
    (
      SELECT event.metadata->>'original_transfer_id'
        FROM public.escrow_events event
       WHERE event.escrow_id=OLD.id
         AND event.from_state='RELEASED'
         AND event.to_state='LOCKED_DISPUTE'
         AND event.metadata->>'original_transfer_id' IS NOT NULL
       ORDER BY event.created_at ASC
       LIMIT 1
    )
  ) INTO v_original_transfer_id;

  v_released_origin := OLD.state='RELEASED'
    OR (
      OLD.state='LOCKED_DISPUTE'
      AND v_original_transfer_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.escrow_events event
         WHERE event.escrow_id=OLD.id
           AND event.from_state='RELEASED'
           AND event.to_state='LOCKED_DISPUTE'
           AND event.metadata->>'original_transfer_id'=v_original_transfer_id
      )
    );

  IF OLD.state IN ('FUNDED','LOCKED_DISPUTE') AND NEW.state<>'REFUNDED' AND EXISTS (
    SELECT 1
      FROM public.escrow_events claim
     WHERE claim.escrow_id=OLD.id
       AND claim.from_state=OLD.state
       AND claim.to_state=OLD.state
       AND claim.actor_id IS NULL
       AND claim.actor_type='system'
       AND (
         claim.metadata->>'event_type'='refund_provider_create_claim_v1'
         OR claim.idempotency_key LIKE
           'refund-provider-create-claim-v1:' || OLD.id::text || ':%'
       )
  ) THEN
    RAISE EXCEPTION
      'HX002: escrow % has immutable refund-provider claim and cannot mutate outside exact refund',
      OLD.id
      USING ERRCODE='HX002';

  ELSIF OLD.state='FUNDED' AND NEW.state='REFUNDED' THEN
    -- A provider refund becomes canonical only when this transaction supplies
    -- the exact pre-provider claim, current succeeded provider witness, and
    -- current-transaction resolution event. Direct SQL and a provider ID alone
    -- cannot terminalize money truth.
    v_refund_terminal_authorized :=
      COALESCE(current_setting('hustlexp.refund_terminal_authority', true), '')=OLD.id::text
      AND OLD.stripe_payment_intent_id IS NOT NULL
      AND NEW.stripe_refund_id IS NOT NULL
      AND (OLD.stripe_refund_id IS NULL OR OLD.stripe_refund_id=NEW.stripe_refund_id)
      AND NEW.version=OLD.version+1
      AND NEW.refunded_at IS NOT NULL
      AND (to_jsonb(NEW)-'state'-'stripe_refund_id'-'refunded_at'-'version'-'updated_at')
          =(to_jsonb(OLD)-'state'-'stripe_refund_id'-'refunded_at'-'version'-'updated_at')
      AND EXISTS (
        SELECT 1
          FROM public.escrow_events claim
          JOIN public.tasks task ON task.id=OLD.task_id
         WHERE claim.escrow_id=OLD.id
           AND claim.from_state='FUNDED'
           AND claim.to_state='FUNDED'
           AND claim.actor_id IS NULL
           AND claim.actor_type='system'
           AND jsonb_object_length(claim.metadata)=16
           AND claim.metadata->>'event_type'='refund_provider_create_claim_v1'
           AND claim.metadata->>'claim_idempotency_key'=claim.idempotency_key
           AND claim.metadata->>'provider'='stripe'
           AND claim.metadata->>'escrow_id'=OLD.id::text
           AND claim.metadata->>'task_id'=OLD.task_id::text
           AND claim.metadata->>'canonical_state'='FUNDED'
           AND claim.metadata->>'canonical_version'=OLD.version::text
           AND claim.metadata->>'task_version'=task.version::text
           AND claim.metadata->>'task_state'=task.state
           AND claim.metadata->>'worker_id' IS NOT DISTINCT FROM task.worker_id::text
           AND claim.metadata->>'payment_intent_id'=OLD.stripe_payment_intent_id
           AND claim.metadata->>'existing_refund_id' IS NOT DISTINCT FROM OLD.stripe_refund_id
           AND claim.metadata->>'refund_amount_cents'=OLD.amount::text
           AND claim.metadata->>'currency'='usd'
           AND claim.metadata->>'provider_idempotency_key'=
             'hx-refund-claim-v1:' || OLD.id::text || ':' || OLD.version::text
           AND claim.metadata->>'provider_replay_deadline'=
             (to_jsonb(claim.created_at+INTERVAL '20 hours') #>> '{}')
           AND claim.idempotency_key=
             'refund-provider-create-claim-v1:' || OLD.id::text || ':' || OLD.version::text
      )
      AND NOT EXISTS (
        SELECT 1
          FROM public.escrow_events other_claim
         WHERE other_claim.escrow_id=OLD.id
           AND other_claim.idempotency_key LIKE
             'refund-provider-create-claim-v1:' || OLD.id::text || ':%'
           AND other_claim.metadata->>'event_type'='refund_provider_create_claim_v1'
           AND other_claim.metadata->>'escrow_id'=OLD.id::text
           AND other_claim.idempotency_key<>
             'refund-provider-create-claim-v1:' || OLD.id::text || ':' || OLD.version::text
      )
      AND EXISTS (
        SELECT 1
          FROM public.escrow_events witness
         WHERE witness.escrow_id=OLD.id
           AND witness.from_state='FUNDED'
           AND witness.to_state='FUNDED'
           AND witness.actor_id IS NULL
           AND witness.actor_type='system'
           AND jsonb_object_length(witness.metadata)=10
           AND witness.metadata->>'event_type'='exact_succeeded_refund_witness_v1'
           AND witness.metadata->>'escrow_id'=OLD.id::text
           AND witness.metadata->>'task_id'=OLD.task_id::text
           AND witness.metadata->>'canonical_state'='FUNDED'
           AND witness.metadata->>'payment_intent_id'=OLD.stripe_payment_intent_id
           AND witness.metadata->>'refund_id'=NEW.stripe_refund_id
           AND NULLIF(witness.metadata->>'charge_id','') IS NOT NULL
           AND witness.metadata->>'amount_cents'=OLD.amount::text
           AND witness.metadata->>'currency'='usd'
           AND witness.metadata->>'status'='succeeded'
           AND witness.idempotency_key=
             'exact-succeeded-refund-v1:' || OLD.id::text || ':' || NEW.stripe_refund_id
      )
      AND EXISTS (
        SELECT 1
          FROM public.escrow_events resolution
         WHERE resolution.escrow_id=OLD.id
           AND resolution.from_state='FUNDED'
           AND resolution.to_state='REFUNDED'
           AND resolution.actor_id IS NULL
           AND resolution.actor_type='system'
           AND resolution.created_at=transaction_timestamp()
           AND jsonb_object_length(resolution.metadata)=16
           AND resolution.metadata->>'event_type'='refund_provider_claim_resolved_v1'
           AND resolution.metadata->>'claim_idempotency_key'=
             'refund-provider-create-claim-v1:' || OLD.id::text || ':' || OLD.version::text
           AND resolution.metadata->>'provider'='stripe'
           AND resolution.metadata->>'escrow_id'=OLD.id::text
           AND resolution.metadata->>'task_id'=OLD.task_id::text
           AND resolution.metadata->>'canonical_state_before'='FUNDED'
           AND resolution.metadata->>'canonical_state_after'='REFUNDED'
           AND resolution.metadata->>'canonical_version_before'=OLD.version::text
           AND resolution.metadata->>'canonical_version_after'=NEW.version::text
           AND resolution.metadata->>'payment_intent_id'=OLD.stripe_payment_intent_id
           AND resolution.metadata->>'refund_id'=NEW.stripe_refund_id
           AND resolution.metadata->>'refund_amount_cents'=OLD.amount::text
           AND resolution.metadata->>'currency'='usd'
           AND resolution.metadata->>'provider_idempotency_key'=
             'hx-refund-claim-v1:' || OLD.id::text || ':' || OLD.version::text
           AND resolution.metadata->>'provider_witness_idempotency_key'=
             'exact-succeeded-refund-v1:' || OLD.id::text || ':' || NEW.stripe_refund_id
           AND resolution.metadata->>'resolution'='canonical_refunded'
           AND resolution.idempotency_key=
             'refund-provider-claim-resolved-v1:' || OLD.id::text || ':' ||
             OLD.version::text || ':' || NEW.stripe_refund_id
      );

    IF NOT v_refund_terminal_authorized THEN
      RAISE EXCEPTION
        'HX002: funded escrow % requires exact refund claim, provider witness, and resolution authority',
        OLD.id
        USING ERRCODE='HX002';
    END IF;

  ELSIF OLD.state='RELEASED' AND NEW.state='LOCKED_DISPUTE' THEN
    v_dispute_authorized :=
      COALESCE(current_setting('hustlexp.released_dispute_authority', true), '')=OLD.id::text
      AND OLD.stripe_transfer_id IS NOT NULL
      AND NEW.stripe_transfer_id IS NOT DISTINCT FROM OLD.stripe_transfer_id
      AND NEW.provider_transfer_status IS NOT DISTINCT FROM OLD.provider_transfer_status
      AND NEW.version=OLD.version+1
      AND EXISTS (
        SELECT 1
          FROM public.escrow_events event
          JOIN public.tasks task ON task.id=OLD.task_id
         WHERE event.escrow_id=OLD.id
           AND event.from_state='RELEASED'
           AND event.to_state='LOCKED_DISPUTE'
           AND event.actor_type='user'
           AND event.actor_id IS NOT NULL
           AND event.actor_id IN (task.poster_id, task.worker_id)
           AND event.idempotency_key=
             'released-dispute-authority-v1:' || OLD.id::text || ':' || OLD.version::text
           AND event.metadata->>'event_type'='released_dispute_authority_v1'
           AND event.metadata->>'task_id'=OLD.task_id::text
           AND event.metadata->>'initiated_by'=event.actor_id::text
           AND event.metadata->>'original_transfer_id'=OLD.stripe_transfer_id
           AND event.metadata->>'escrow_version'=OLD.version::text
      )
      AND EXISTS (
        SELECT 1 FROM public.escrow_events event
         WHERE event.escrow_id=OLD.id
           AND event.from_state='RELEASED'
           AND event.to_state='LOCKED_DISPUTE'
           AND event.actor_id IS NULL
           AND event.actor_type='system'
           AND event.idempotency_key=
             'released-dispute-origin-v1:' || OLD.id::text || ':' || OLD.version::text
           AND event.metadata->>'event_type'='dispute_locked_after_release'
           AND event.metadata->>'task_id'=OLD.task_id::text
           AND event.metadata->>'original_transfer_id'=OLD.stripe_transfer_id
           AND event.metadata->>'escrow_version'=OLD.version::text
      );

    v_transfer_failed_authorized :=
      COALESCE(current_setting('hustlexp.transfer_failed_authority', true), '')=OLD.id::text
      AND OLD.stripe_transfer_id IS NOT NULL
      AND NEW.stripe_transfer_id IS NOT DISTINCT FROM OLD.stripe_transfer_id
      AND NEW.provider_transfer_status='manual_reconciliation'
      AND NEW.version=OLD.version+1
      AND EXISTS (
        SELECT 1 FROM public.escrow_events event
         WHERE event.escrow_id=OLD.id
           AND event.from_state='RELEASED'
           AND event.to_state='LOCKED_DISPUTE'
           AND event.actor_id IS NULL
           AND event.actor_type='system'
           AND event.idempotency_key LIKE
             'transfer-failed-provider-witness-v1:' || OLD.id::text || ':%'
           AND event.metadata->>'event_type'='transfer_failed_provider_witness_v1'
           AND event.metadata->>'escrow_id'=OLD.id::text
           AND event.metadata->>'task_id'=OLD.task_id::text
           AND event.metadata->>'transfer_id'=OLD.stripe_transfer_id
           AND NULLIF(event.metadata->>'stripe_event_id','') IS NOT NULL
      );

    IF NOT v_dispute_authorized AND NOT v_transfer_failed_authorized THEN
      RAISE EXCEPTION
        'HX002: RELEASED escrow % requires exact dispute or transfer-failure authority', OLD.id
        USING ERRCODE='HX002';
    END IF;

  ELSIF OLD.state='LOCKED_DISPUTE' AND NEW.state='REFUNDED' AND NOT v_released_origin THEN
    -- A negative/recovery action refund becomes canonical only when the exact
    -- closed origin, DB-clock provider claim, current succeeded provider
    -- witness, claim resolution, and action authority are present in the same
    -- transaction as the full-row REFUNDED CAS.
    v_action_refund_terminal_authorized :=
      COALESCE(current_setting('hustlexp.refund_terminal_authority', true), '')=OLD.id::text
      AND OLD.stripe_payment_intent_id IS NOT NULL
      AND OLD.stripe_transfer_id IS NULL
      AND OLD.payout_provider IS NULL
      AND OLD.provider_transfer_id IS NULL
      AND OLD.provider_transfer_status IS NULL
      AND OLD.provider_transfer_paid_at IS NULL
      AND NEW.stripe_refund_id IS NOT NULL
      AND (OLD.stripe_refund_id IS NULL OR OLD.stripe_refund_id=NEW.stripe_refund_id)
      AND NEW.version=OLD.version+1
      AND NEW.refunded_at IS NOT NULL
      AND (to_jsonb(NEW)-'state'-'stripe_refund_id'-'refunded_at'-'version'-'updated_at')
          =(to_jsonb(OLD)-'state'-'stripe_refund_id'-'refunded_at'-'version'-'updated_at')
      AND EXISTS (
        SELECT 1
          FROM public.escrow_events claim
          JOIN public.tasks task ON task.id=OLD.task_id
         WHERE claim.escrow_id=OLD.id
           AND claim.from_state='LOCKED_DISPUTE'
           AND claim.to_state='LOCKED_DISPUTE'
           AND claim.actor_id IS NULL
           AND claim.actor_type='system'
           AND jsonb_object_length(claim.metadata)=16
           AND claim.metadata->>'event_type'='refund_provider_create_claim_v1'
           AND claim.metadata->>'claim_idempotency_key'=claim.idempotency_key
           AND claim.metadata->>'provider'='stripe'
           AND claim.metadata->>'escrow_id'=OLD.id::text
           AND claim.metadata->>'task_id'=OLD.task_id::text
           AND claim.metadata->>'canonical_state'='LOCKED_DISPUTE'
           AND claim.metadata->>'canonical_version'=OLD.version::text
           AND claim.metadata->>'task_version'=task.version::text
           AND claim.metadata->>'task_state'=task.state
           AND claim.metadata->>'worker_id' IS NOT DISTINCT FROM task.worker_id::text
           AND claim.metadata->>'payment_intent_id'=OLD.stripe_payment_intent_id
           AND claim.metadata->>'existing_refund_id' IS NOT DISTINCT FROM OLD.stripe_refund_id
           AND claim.metadata->>'refund_amount_cents'=OLD.amount::text
           AND claim.metadata->>'currency'='usd'
           AND claim.metadata->>'provider_idempotency_key'=
             'hx-refund-claim-v1:' || OLD.id::text || ':' || OLD.version::text
           AND claim.metadata->>'provider_replay_deadline'=
             (to_jsonb(claim.created_at+INTERVAL '20 hours') #>> '{}')
           AND claim.idempotency_key=
             'refund-provider-create-claim-v1:' || OLD.id::text || ':' || OLD.version::text
      )
      AND NOT EXISTS (
        SELECT 1
          FROM public.escrow_events other_claim
         WHERE other_claim.escrow_id=OLD.id
           AND other_claim.idempotency_key LIKE
             'refund-provider-create-claim-v1:' || OLD.id::text || ':%'
           AND other_claim.metadata->>'event_type'='refund_provider_create_claim_v1'
           AND other_claim.metadata->>'escrow_id'=OLD.id::text
           AND other_claim.idempotency_key<>
             'refund-provider-create-claim-v1:' || OLD.id::text || ':' || OLD.version::text
      )
      AND EXISTS (
        SELECT 1
          FROM public.escrow_events witness
         WHERE witness.escrow_id=OLD.id
           AND witness.from_state='LOCKED_DISPUTE'
           AND witness.to_state='LOCKED_DISPUTE'
           AND witness.actor_id IS NULL
           AND witness.actor_type='system'
           AND jsonb_object_length(witness.metadata)=10
           AND witness.metadata->>'event_type'='exact_succeeded_refund_witness_v1'
           AND witness.metadata->>'escrow_id'=OLD.id::text
           AND witness.metadata->>'task_id'=OLD.task_id::text
           AND witness.metadata->>'canonical_state'='LOCKED_DISPUTE'
           AND witness.metadata->>'payment_intent_id'=OLD.stripe_payment_intent_id
           AND witness.metadata->>'refund_id'=NEW.stripe_refund_id
           AND NULLIF(witness.metadata->>'charge_id','') IS NOT NULL
           AND witness.metadata->>'amount_cents'=OLD.amount::text
           AND witness.metadata->>'currency'='usd'
           AND witness.metadata->>'status'='succeeded'
           AND witness.idempotency_key=
             'exact-succeeded-refund-v1:' || OLD.id::text || ':' || NEW.stripe_refund_id
      )
      AND EXISTS (
        SELECT 1
          FROM public.escrow_events resolution
         WHERE resolution.escrow_id=OLD.id
           AND resolution.from_state='LOCKED_DISPUTE'
           AND resolution.to_state='REFUNDED'
           AND resolution.actor_id IS NULL
           AND resolution.actor_type='system'
           AND resolution.created_at=transaction_timestamp()
           AND jsonb_object_length(resolution.metadata)=16
           AND resolution.metadata->>'event_type'='refund_provider_claim_resolved_v1'
           AND resolution.metadata->>'claim_idempotency_key'=
             'refund-provider-create-claim-v1:' || OLD.id::text || ':' || OLD.version::text
           AND resolution.metadata->>'provider'='stripe'
           AND resolution.metadata->>'escrow_id'=OLD.id::text
           AND resolution.metadata->>'task_id'=OLD.task_id::text
           AND resolution.metadata->>'canonical_state_before'='LOCKED_DISPUTE'
           AND resolution.metadata->>'canonical_state_after'='REFUNDED'
           AND resolution.metadata->>'canonical_version_before'=OLD.version::text
           AND resolution.metadata->>'canonical_version_after'=NEW.version::text
           AND resolution.metadata->>'payment_intent_id'=OLD.stripe_payment_intent_id
           AND resolution.metadata->>'refund_id'=NEW.stripe_refund_id
           AND resolution.metadata->>'refund_amount_cents'=OLD.amount::text
           AND resolution.metadata->>'currency'='usd'
           AND resolution.metadata->>'provider_idempotency_key'=
             'hx-refund-claim-v1:' || OLD.id::text || ':' || OLD.version::text
           AND resolution.metadata->>'provider_witness_idempotency_key'=
             'exact-succeeded-refund-v1:' || OLD.id::text || ':' || NEW.stripe_refund_id
           AND resolution.metadata->>'resolution'='canonical_refunded'
           AND resolution.idempotency_key=
             'refund-provider-claim-resolved-v1:' || OLD.id::text || ':' ||
             OLD.version::text || ':' || NEW.stripe_refund_id
      )
      AND EXISTS (
        SELECT 1
          FROM public.escrow_events action
          JOIN public.tasks task ON task.id=OLD.task_id
         WHERE action.escrow_id=OLD.id
           AND action.from_state='LOCKED_DISPUTE'
           AND action.to_state='REFUNDED'
           AND action.actor_id IS NULL
           AND action.actor_type='system'
           AND action.created_at=transaction_timestamp()
           AND jsonb_object_length(action.metadata)=14
           AND action.metadata->>'event_type'='action_refund_terminal_authority_v1'
           AND action.metadata->>'escrow_id'=OLD.id::text
           AND action.metadata->>'task_id'=OLD.task_id::text
           AND action.metadata->>'canonical_version_before'=OLD.version::text
           AND action.metadata->>'task_version'=task.version::text
           AND action.metadata->>'task_state'=task.state
           AND action.metadata->>'worker_id' IS NOT DISTINCT FROM task.worker_id::text
           AND action.metadata->>'payment_intent_id'=OLD.stripe_payment_intent_id
           AND action.metadata->>'refund_id'=NEW.stripe_refund_id
           AND action.metadata->>'refund_amount_cents'=OLD.amount::text
           AND action.metadata->>'provider_claim_key'=
             'refund-provider-create-claim-v1:' || OLD.id::text || ':' || OLD.version::text
           AND action.idempotency_key=
             'action-refund-terminal-authority-v1:' || OLD.id::text || ':' ||
             OLD.version::text || ':' || NEW.stripe_refund_id
           AND (
             (
               action.metadata->>'authority_origin'='dispute_resolution'
               AND NULLIF(action.metadata->>'authority_version','') IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM public.disputes dispute
                  WHERE dispute.id::text=action.metadata->>'authority_id'
                    AND dispute.version::text=action.metadata->>'authority_version'
                    AND dispute.escrow_id=OLD.id
                    AND dispute.task_id=OLD.task_id
                    AND dispute.state='RESOLVED'
                    AND dispute.resolved_by IS NOT NULL
                    AND dispute.outcome_escrow_action='REFUND'
                    AND dispute.outcome_refund_amount=OLD.amount
                    AND dispute.outcome_release_amount=0
                    AND task.state='CANCELLED'
               )
             )
             OR (
               action.metadata->>'authority_origin'='worker_abandoned'
               AND action.metadata->>'authority_version' IS NULL
               AND action.metadata->>'authority_id'=
                 'worker-abandon-refund-authority-v1:' || OLD.id::text || ':' ||
                 OLD.task_id::text || ':' || OLD.version::text
               AND task.state='CANCELLED'
               AND task.worker_id IS NULL
               AND EXISTS (
                 SELECT 1 FROM public.escrow_events source
                  WHERE source.escrow_id=OLD.id
                    AND source.from_state='FUNDED'
                    AND source.to_state='LOCKED_DISPUTE'
                    AND source.actor_id IS NOT NULL
                    AND source.actor_type='user'
                    AND source.idempotency_key=action.metadata->>'authority_id'
                    AND source.metadata->>'event_type'='worker_abandon_refund_authority_v1'
                    AND source.metadata->>'task_id'=OLD.task_id::text
                    AND source.metadata->>'worker_id'=source.actor_id::text
                    AND source.metadata->>'canonical_state'='LOCKED_DISPUTE'
                    AND source.metadata->>'canonical_version'=OLD.version::text
               )
             )
             OR (
               action.metadata->>'authority_origin'='dispatch_expired_unfilled'
               AND action.metadata->>'authority_version' IS NULL
               AND action.metadata->>'authority_id'='dispatch-expiry:' || OLD.task_id::text
               AND task.state='EXPIRED'
               AND task.worker_id IS NULL
               AND task.expiration_reason='UNFILLED'
               AND EXISTS (
                 SELECT 1 FROM public.engine_automation_events source
                  WHERE source.task_id=OLD.task_id
                    AND source.event_type='TASK_EXPIRED_UNFILLED'
                    AND source.idempotency_key=action.metadata->>'authority_id'
               )
             )
           )
      );

    IF NOT v_action_refund_terminal_authorized THEN
      RAISE EXCEPTION
        'HX002: dispute-locked escrow % requires exact action refund claim, witness, origin, and resolution authority',
        OLD.id
        USING ERRCODE='HX002';
    END IF;

  ELSIF NEW.state='REFUNDED' AND v_released_origin THEN
    -- D1 containment deliberately has no release-economics compensation model.
    -- Insurance contributions cannot be decremented and verification earnings /
    -- unlocks cannot be revoked by an immutable compensating record. Processor
    -- refund/reversal facts are retained for reconciliation, but canonical
    -- REFUNDED remains impossible until that forward schema exists.
    RAISE EXCEPTION
      'HX002: released-origin refund % requires insurance and verification-earnings compensation authority',
      OLD.id
      USING ERRCODE='HX002';

  ELSIF OLD.state IN ('RELEASED','REFUNDED','REFUND_PARTIAL') THEN
    -- Terminal rows are fully immutable, not merely state-immutable. The only
    -- same-state exception is an exact processor-status observation: every
    -- other column must be byte-for-byte unchanged apart from the optimistic
    -- version and updated_at, and an immutable event must pre-authorize the CAS.
    v_provider_status_authorized :=
      NEW.state=OLD.state
      AND COALESCE(current_setting('hustlexp.provider_transfer_status_authority', true), '')=OLD.id::text
      AND OLD.stripe_transfer_id IS NOT NULL
      AND NEW.provider_transfer_status IS DISTINCT FROM OLD.provider_transfer_status
      AND NEW.version=OLD.version+1
      AND (to_jsonb(NEW)-'provider_transfer_status'-'version'-'updated_at')
          =(to_jsonb(OLD)-'provider_transfer_status'-'version'-'updated_at')
      AND EXISTS (
        SELECT 1 FROM public.escrow_events event
         WHERE event.escrow_id=OLD.id
           AND event.from_state=OLD.state
           AND event.to_state=OLD.state
           AND event.actor_id IS NULL
           AND event.actor_type='system'
           AND event.metadata->>'event_type'='provider_transfer_status_authority_v1'
           AND event.metadata->>'escrow_id'=OLD.id::text
           AND event.metadata->>'task_id'=OLD.task_id::text
           AND event.metadata->>'canonical_state'=OLD.state
           AND event.metadata->>'canonical_version'=OLD.version::text
           AND event.metadata->>'transfer_id'=OLD.stripe_transfer_id
           AND event.metadata->>'provider_transfer_status_before'
               IS NOT DISTINCT FROM OLD.provider_transfer_status
           AND event.metadata->>'provider_transfer_status_after'=NEW.provider_transfer_status
           AND NULLIF(event.metadata->>'stripe_event_id','') IS NOT NULL
           AND event.idempotency_key=
             'provider-transfer-status-authority-v1:' || OLD.id::text || ':' ||
             OLD.version::text || ':' || (event.metadata->>'stripe_event_id') || ':' ||
             NEW.provider_transfer_status
      );

    IF NOT v_provider_status_authorized THEN
      RAISE EXCEPTION
        'HX002: terminal escrow % (%) is immutable without exact provider-status authority',
        OLD.id,OLD.state
        USING ERRCODE='HX002';
    END IF;

  ELSIF OLD.state='LOCKED_DISPUTE' AND NEW.state='RELEASED' THEN
    -- A normal first release and a released-origin restore are distinct closed
    -- commands. The first may bind one newly observed transfer; the restore
    -- must preserve the already canonical transfer and released-origin proof.
    v_dispute_first_release_authorized :=
      COALESCE(current_setting('hustlexp.dispute_first_release_authority', true), '')=OLD.id::text
      AND NOT v_released_origin
      AND NEW.stripe_transfer_id IS NOT NULL
      AND (OLD.stripe_transfer_id IS NULL OR OLD.stripe_transfer_id=NEW.stripe_transfer_id)
      AND NEW.payout_provider='STRIPE'
      AND NEW.provider_transfer_id=NEW.stripe_transfer_id
      AND NEW.provider_transfer_status='submitted'
      AND NEW.provider_transfer_paid_at IS NULL
      AND NEW.platform_fee_cents IS NOT NULL
      AND NEW.platform_fee_cents>=0
      AND NEW.platform_fee_cents<NEW.amount
      AND NEW.released_at IS NOT NULL
      AND NEW.version=OLD.version+1
      AND (
        to_jsonb(NEW)-'state'-'stripe_transfer_id'-'payout_provider'-
          'provider_transfer_id'-'provider_transfer_status'-'provider_transfer_paid_at'-
          'platform_fee_cents'-'released_at'-'version'-'updated_at'
      )=(
        to_jsonb(OLD)-'state'-'stripe_transfer_id'-'payout_provider'-
          'provider_transfer_id'-'provider_transfer_status'-'provider_transfer_paid_at'-
          'platform_fee_cents'-'released_at'-'version'-'updated_at'
      )
      AND EXISTS (
        SELECT 1
          FROM public.escrow_events event
          JOIN public.disputes dispute
            ON dispute.id::text=event.metadata->>'dispute_id'
          JOIN public.tasks task ON task.id=dispute.task_id
          JOIN public.users payee
            ON payee.id=COALESCE(task.payout_recipient_user_id,task.worker_id)
         WHERE event.escrow_id=OLD.id
           AND event.from_state='LOCKED_DISPUTE'
           AND event.to_state='RELEASED'
           AND event.actor_id IS NULL
           AND event.actor_type='system'
           AND event.created_at=transaction_timestamp()
           AND jsonb_object_length(event.metadata)=17
           AND event.metadata->>'event_type'='dispute_first_release_authority_v1'
           AND event.metadata->>'escrow_id'=OLD.id::text
           AND event.metadata->>'canonical_state_before'='LOCKED_DISPUTE'
           AND event.metadata->>'canonical_version_before'=OLD.version::text
           AND event.metadata->>'task_id'=OLD.task_id::text
           AND event.metadata->>'task_version'=task.version::text
           AND event.metadata->>'dispute_id'=dispute.id::text
           AND event.metadata->>'dispute_version'=dispute.version::text
           AND event.metadata->>'resolved_by'=dispute.resolved_by::text
           AND event.metadata->>'transfer_id'=NEW.stripe_transfer_id
           AND event.metadata->>'payout_recipient_user_id'=payee.id::text
           AND event.metadata->>'destination_account_id'=payee.stripe_connect_id
           AND event.metadata->>'platform_fee_cents'=NEW.platform_fee_cents::text
           AND jsonb_typeof(event.metadata->'transfer_amount_cents')='number'
           AND (event.metadata->>'transfer_amount_cents')::numeric=
             OLD.amount-NEW.platform_fee_cents-ROUND(OLD.amount*0.02)
           AND (event.metadata->>'transfer_amount_cents')::numeric>0
           AND trunc((event.metadata->>'transfer_amount_cents')::numeric)=
             (event.metadata->>'transfer_amount_cents')::numeric
           AND event.metadata->>'currency'='usd'
           AND event.metadata->>'provider_status'='not_reversed'
           AND event.metadata->>'provider_state_after'='submitted'
           AND event.idempotency_key=
             'dispute-first-release-authority-v1:' || OLD.id::text || ':' ||
             dispute.id::text || ':' || dispute.version::text || ':' ||
             OLD.version::text || ':' || NEW.stripe_transfer_id
           AND dispute.escrow_id=OLD.id
           AND dispute.task_id=OLD.task_id
           AND dispute.state='RESOLVED'
           AND dispute.resolved_by IS NOT NULL
           AND dispute.outcome_escrow_action='RELEASE'
           AND dispute.outcome_refund_amount=0
           AND dispute.outcome_release_amount=OLD.amount
           AND task.state='COMPLETED'
           AND task.worker_id IS NOT NULL
           AND task.price=OLD.amount
           AND payee.account_status='ACTIVE'
           AND payee.payouts_enabled IS TRUE
           AND payee.stripe_connect_id IS NOT NULL
           AND (
             (
               task.provider_organization_id IS NULL
               AND task.payout_recipient_user_id IS NULL
               AND payee.id=task.worker_id
             )
             OR EXISTS (
               SELECT 1
                 FROM public.business_service_task_assignments assignment
                 JOIN public.business_provider_payout_accounts payout
                   ON payout.id=assignment.payout_account_id
                  AND payout.organization_id=assignment.provider_organization_id
                  AND payout.payout_recipient_user_id=assignment.payout_recipient_user_id
                  AND payout.status='ACTIVE'
                WHERE assignment.id=task.provider_assignment_id
                  AND assignment.task_id=task.id
                  AND assignment.provider_organization_id=task.provider_organization_id
                  AND assignment.service_profile_id=task.provider_service_profile_id
                  AND assignment.fulfiller_user_id=task.worker_id
                  AND assignment.payout_recipient_user_id=payee.id
                  AND payout.provider_account_fingerprint=
                    encode(digest(payee.stripe_connect_id,'sha256'),'hex')
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM public.escrow_events origin
              WHERE origin.escrow_id=OLD.id
                AND origin.from_state='RELEASED'
                AND origin.to_state='LOCKED_DISPUTE'
                AND origin.metadata->>'event_type'='dispute_locked_after_release'
           )
      );

    -- A worker-favour dispute over an already RELEASED escrow restores the
    -- canonical state without creating a second transfer.
    v_dispute_release_restore_authorized :=
      COALESCE(current_setting('hustlexp.dispute_release_restore_authority', true), '')=OLD.id::text
      AND OLD.stripe_transfer_id IS NOT NULL
      AND OLD.payout_provider='STRIPE'
      AND OLD.provider_transfer_id=OLD.stripe_transfer_id
      AND OLD.provider_transfer_status IN ('submitted','processing','paid')
      AND OLD.platform_fee_cents IS NOT NULL
      AND OLD.platform_fee_cents>=0
      AND OLD.platform_fee_cents<OLD.amount
      AND NEW.version=OLD.version+1
      AND (to_jsonb(NEW)-'state'-'version'-'updated_at')
          =(to_jsonb(OLD)-'state'-'version'-'updated_at')
      AND EXISTS (
        SELECT 1
          FROM public.escrow_events event
          JOIN public.disputes dispute
            ON dispute.id::text=event.metadata->>'dispute_id'
          JOIN public.tasks task ON task.id=dispute.task_id
          JOIN public.users payee
            ON payee.id=COALESCE(task.payout_recipient_user_id,task.worker_id)
         WHERE event.escrow_id=OLD.id
           AND event.from_state='LOCKED_DISPUTE'
           AND event.to_state='RELEASED'
           AND event.actor_id IS NULL
           AND event.actor_type='system'
           AND event.created_at=transaction_timestamp()
           AND jsonb_object_length(event.metadata)=15
           AND event.metadata->>'event_type'='dispute_release_restore_authority_v1'
           AND event.metadata->>'escrow_id'=OLD.id::text
           AND event.metadata->>'canonical_state_before'='LOCKED_DISPUTE'
           AND event.metadata->>'canonical_version_before'=OLD.version::text
           AND event.metadata->>'task_id'=OLD.task_id::text
           AND event.metadata->>'task_version'=task.version::text
           AND event.metadata->>'dispute_id'=dispute.id::text
           AND event.metadata->>'dispute_version'=dispute.version::text
           AND event.metadata->>'resolved_by'=dispute.resolved_by::text
           AND event.metadata->>'original_transfer_id'=OLD.stripe_transfer_id
           AND event.metadata->>'payout_recipient_user_id'=payee.id::text
           AND event.metadata->>'destination_account_id'=payee.stripe_connect_id
           AND jsonb_typeof(event.metadata->'transfer_amount_cents')='number'
           AND (event.metadata->>'transfer_amount_cents')::numeric=
             OLD.amount-OLD.platform_fee_cents-ROUND(OLD.amount*0.02)
           AND (event.metadata->>'transfer_amount_cents')::numeric>0
           AND trunc((event.metadata->>'transfer_amount_cents')::numeric)
               =(event.metadata->>'transfer_amount_cents')::numeric
           AND event.metadata->>'currency'='usd'
           AND event.metadata->>'provider_status'='not_reversed'
           AND event.idempotency_key=
             'dispute-release-restore-authority-v1:' || OLD.id::text || ':' ||
             dispute.id::text || ':' || dispute.version::text || ':' || OLD.version::text
           AND dispute.escrow_id=OLD.id
           AND dispute.task_id=OLD.task_id
           AND dispute.state='RESOLVED'
           AND dispute.resolved_by IS NOT NULL
           AND dispute.outcome_escrow_action='RELEASE'
           AND dispute.outcome_refund_amount=0
           AND dispute.outcome_release_amount=OLD.amount
           AND task.state='COMPLETED'
           AND task.worker_id IS NOT NULL
           AND task.price=OLD.amount
           AND payee.account_status='ACTIVE'
           AND payee.payouts_enabled IS TRUE
           AND payee.stripe_connect_id IS NOT NULL
           AND (
             (
               task.provider_organization_id IS NULL
               AND task.payout_recipient_user_id IS NULL
               AND payee.id=task.worker_id
             )
             OR EXISTS (
               SELECT 1
                 FROM public.business_service_task_assignments assignment
                 JOIN public.business_provider_payout_accounts payout
                   ON payout.id=assignment.payout_account_id
                  AND payout.organization_id=assignment.provider_organization_id
                  AND payout.payout_recipient_user_id=assignment.payout_recipient_user_id
                  AND payout.status='ACTIVE'
                WHERE assignment.id=task.provider_assignment_id
                  AND assignment.task_id=task.id
                  AND assignment.provider_organization_id=task.provider_organization_id
                  AND assignment.service_profile_id=task.provider_service_profile_id
                  AND assignment.fulfiller_user_id=task.worker_id
                  AND assignment.payout_recipient_user_id=payee.id
                  AND payout.provider_account_fingerprint=
                    encode(digest(payee.stripe_connect_id,'sha256'),'hex')
             )
           )
           AND EXISTS (
             SELECT 1 FROM public.escrow_events origin
              WHERE origin.escrow_id=OLD.id
                AND origin.from_state='RELEASED'
                AND origin.to_state='LOCKED_DISPUTE'
                AND origin.actor_id IS NULL
                AND origin.actor_type='system'
                AND origin.idempotency_key=
                  'released-dispute-origin-v1:' || OLD.id::text || ':' || (OLD.version-1)::text
                AND origin.metadata->>'event_type'='dispute_locked_after_release'
                AND origin.metadata->>'task_id'=OLD.task_id::text
                AND origin.metadata->>'original_transfer_id'=OLD.stripe_transfer_id
                AND origin.metadata->>'escrow_version'=(OLD.version-1)::text
           )
      );

    IF NOT v_dispute_first_release_authorized AND NOT v_dispute_release_restore_authorized THEN
      RAISE EXCEPTION
        'HX002: dispute-locked escrow % requires exact first-release or released-origin restore authority', OLD.id
        USING ERRCODE='HX002';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_no_active_refund_claim_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='ACCEPTED'
     AND NOT (
       TG_OP='UPDATE'
       AND OLD.state='ACCEPTED'
       AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id
     )
     AND EXISTS (
       SELECT 1
         FROM public.escrows escrow
         JOIN public.escrow_events claim ON claim.escrow_id=escrow.id
        WHERE escrow.task_id=NEW.id
          AND claim.from_state='FUNDED'
          AND claim.to_state='FUNDED'
          AND claim.actor_id IS NULL
          AND claim.actor_type='system'
          AND (
            claim.metadata->>'event_type'='refund_provider_create_claim_v1'
            OR claim.idempotency_key LIKE
              'refund-provider-create-claim-v1:' || escrow.id::text || ':%'
          )
     )
  THEN
    RAISE EXCEPTION
      'HX002: task % has immutable refund-provider claim and cannot be accepted', NEW.id
      USING ERRCODE='HX002';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.prevent_task_terminal_mutation()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.prevent_escrow_terminal_mutation()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_no_active_refund_claim_on_accept()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.prevent_escrow_amount_change()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_xp_requires_released_escrow()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.prevent_xp_ledger_delete()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.prevent_xp_ledger_truncate()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_released_requires_completed()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_completed_requires_accepted_proof()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.live_task_requires_funded_escrow()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.live_task_price_floor()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.hxos_same_worker_proof_retake_continuation(TEXT, TEXT, UUID, UUID)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.hxos_local_test_liquidity_witness_current(UUID, UUID, UUID)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.hxos_local_test_provider_capability_current(UUID, UUID, UUID)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.hxos_local_test_liquidity_witness_current_v2(UUID, UUID, UUID)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.hxos_local_test_offer_action_current(UUID, UUID, UUID, TEXT)
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.hxos_same_worker_proof_retake_continuation(TEXT, TEXT, UUID, UUID)
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.hxos_same_worker_proof_retake_continuation(TEXT, TEXT, UUID, UUID)
  SECURITY INVOKER;
ALTER FUNCTION public.hxos_same_worker_proof_retake_continuation(TEXT, TEXT, UUID, UUID)
  CALLED ON NULL INPUT;
ALTER FUNCTION public.hxos_same_worker_proof_retake_continuation(TEXT, TEXT, UUID, UUID)
  IMMUTABLE;
ALTER FUNCTION public.hxos_same_worker_proof_retake_continuation(TEXT, TEXT, UUID, UUID)
  PARALLEL SAFE;

ALTER FUNCTION public.hxos_local_test_liquidity_witness_current(UUID, UUID, UUID)
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.hxos_local_test_liquidity_witness_current(UUID, UUID, UUID)
  SECURITY INVOKER;
ALTER FUNCTION public.hxos_local_test_liquidity_witness_current(UUID, UUID, UUID)
  CALLED ON NULL INPUT;
ALTER FUNCTION public.hxos_local_test_liquidity_witness_current(UUID, UUID, UUID)
  STABLE;
ALTER FUNCTION public.hxos_local_test_liquidity_witness_current(UUID, UUID, UUID)
  PARALLEL UNSAFE;

ALTER FUNCTION public.hxos_local_test_provider_capability_current(UUID, UUID, UUID)
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.hxos_local_test_provider_capability_current(UUID, UUID, UUID)
  SECURITY INVOKER;
ALTER FUNCTION public.hxos_local_test_provider_capability_current(UUID, UUID, UUID)
  CALLED ON NULL INPUT;
ALTER FUNCTION public.hxos_local_test_provider_capability_current(UUID, UUID, UUID)
  STABLE;
ALTER FUNCTION public.hxos_local_test_provider_capability_current(UUID, UUID, UUID)
  PARALLEL UNSAFE;

ALTER FUNCTION public.hxos_local_test_liquidity_witness_current_v2(UUID, UUID, UUID)
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.hxos_local_test_liquidity_witness_current_v2(UUID, UUID, UUID)
  SECURITY INVOKER;
ALTER FUNCTION public.hxos_local_test_liquidity_witness_current_v2(UUID, UUID, UUID)
  CALLED ON NULL INPUT;
ALTER FUNCTION public.hxos_local_test_liquidity_witness_current_v2(UUID, UUID, UUID)
  STABLE;
ALTER FUNCTION public.hxos_local_test_liquidity_witness_current_v2(UUID, UUID, UUID)
  PARALLEL UNSAFE;

ALTER FUNCTION public.hxos_local_test_offer_action_current(UUID, UUID, UUID, TEXT)
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.hxos_local_test_offer_action_current(UUID, UUID, UUID, TEXT)
  SECURITY INVOKER;
ALTER FUNCTION public.hxos_local_test_offer_action_current(UUID, UUID, UUID, TEXT)
  CALLED ON NULL INPUT;
ALTER FUNCTION public.hxos_local_test_offer_action_current(UUID, UUID, UUID, TEXT)
  STABLE;
ALTER FUNCTION public.hxos_local_test_offer_action_current(UUID, UUID, UUID, TEXT)
  PARALLEL UNSAFE;

DO $pin_function_owners$
DECLARE
  v_function_name TEXT;
BEGIN
  FOREACH v_function_name IN ARRAY ARRAY[
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
    'live_task_price_floor'
  ] LOOP
    EXECUTE format(
      'ALTER FUNCTION public.%I() OWNER TO %I',
      v_function_name,
      CURRENT_USER
    );
    EXECUTE format(
      'ALTER FUNCTION public.%I() SECURITY INVOKER',
      v_function_name
    );
    EXECUTE format(
      'ALTER FUNCTION public.%I() VOLATILE',
      v_function_name
    );
  END LOOP;
END;
$pin_function_owners$;

DROP TRIGGER IF EXISTS active_refund_claim_accept_gate ON public.tasks;
CREATE TRIGGER active_refund_claim_accept_gate
BEFORE INSERT OR UPDATE OF state,worker_id ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.enforce_no_active_refund_claim_on_accept();

DROP TRIGGER IF EXISTS task_region_policy_accept_gate ON public.tasks;
DROP TRIGGER IF EXISTS task_region_policy_accept_insert_gate ON public.tasks;
CREATE TRIGGER task_region_policy_accept_insert_gate
BEFORE INSERT ON public.tasks
FOR EACH ROW WHEN (NEW.state='ACCEPTED')
EXECUTE FUNCTION public.enforce_task_region_policy_on_accept();
CREATE TRIGGER task_region_policy_accept_gate
BEFORE UPDATE OF state,worker_id ON public.tasks
FOR EACH ROW WHEN (
  NEW.state='ACCEPTED'
  AND NOT hxos_same_worker_proof_retake_continuation(
    OLD.state::TEXT,NEW.state::TEXT,OLD.worker_id,NEW.worker_id
  )
)
EXECUTE FUNCTION public.enforce_task_region_policy_on_accept();

DROP TRIGGER IF EXISTS task_worker_eligibility_accept_gate ON public.tasks;
DROP TRIGGER IF EXISTS task_worker_eligibility_accept_insert_gate ON public.tasks;
CREATE TRIGGER task_worker_eligibility_accept_insert_gate
BEFORE INSERT ON public.tasks
FOR EACH ROW WHEN (NEW.state='ACCEPTED')
EXECUTE FUNCTION public.enforce_task_worker_eligibility_on_accept();
CREATE TRIGGER task_worker_eligibility_accept_gate
BEFORE UPDATE OF state,worker_id ON public.tasks
FOR EACH ROW WHEN (
  NEW.state='ACCEPTED'
  AND NOT hxos_same_worker_proof_retake_continuation(
    OLD.state::TEXT,NEW.state::TEXT,OLD.worker_id,NEW.worker_id
  )
)
EXECUTE FUNCTION public.enforce_task_worker_eligibility_on_accept();

DROP TRIGGER IF EXISTS controlled_test_provider_capability_accept_guard ON public.tasks;
CREATE TRIGGER controlled_test_provider_capability_accept_guard
BEFORE INSERT OR UPDATE OF state,worker_id ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.enforce_controlled_test_provider_capability_on_accept();

DROP TRIGGER IF EXISTS controlled_test_offer_accept_guard ON public.tasks;
CREATE TRIGGER controlled_test_offer_accept_guard
BEFORE INSERT OR UPDATE OF state,worker_id ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.enforce_controlled_test_offer_acceptance();

DROP TRIGGER IF EXISTS task_liquidity_cell_accept_gate ON public.tasks;
CREATE TRIGGER task_liquidity_cell_accept_gate
BEFORE INSERT OR UPDATE OF state, worker_id, liquidity_cell_id ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.enforce_task_liquidity_cell_on_accept();

DROP TRIGGER IF EXISTS task_worker_offer_accept_gate ON public.tasks;
CREATE TRIGGER task_worker_offer_accept_gate
BEFORE INSERT OR UPDATE OF state, worker_id ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.enforce_worker_offer_decision_on_accept();

ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER task_region_policy_accept_insert_gate;
ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER active_refund_claim_accept_gate;
ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER task_region_policy_accept_gate;
ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER task_worker_eligibility_accept_insert_gate;
ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER task_worker_eligibility_accept_gate;
ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER controlled_test_provider_capability_accept_guard;
ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER controlled_test_offer_accept_guard;
ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER task_liquidity_cell_accept_gate;
ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER task_worker_offer_accept_gate;

ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER task_terminal_guard;
ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER task_completed_requires_accepted_proof;
ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER live_task_escrow_check;
ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER live_task_price_check;
ALTER TABLE public.escrows ENABLE ALWAYS TRIGGER escrow_terminal_guard;
ALTER TABLE public.escrows ENABLE ALWAYS TRIGGER escrow_amount_immutable;
ALTER TABLE public.escrows ENABLE ALWAYS TRIGGER escrow_released_requires_completed_task;
ALTER TABLE public.xp_ledger ENABLE ALWAYS TRIGGER xp_requires_released_escrow;
ALTER TABLE public.xp_ledger ENABLE ALWAYS TRIGGER xp_ledger_no_delete;
ALTER TABLE public.xp_ledger ENABLE ALWAYS TRIGGER xp_ledger_no_truncate;
