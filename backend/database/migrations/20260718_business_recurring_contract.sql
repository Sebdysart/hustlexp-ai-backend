-- HustleXP Business recurring work contract v1.
-- Organization templates remain on the canonical recurring/task/escrow rails,
-- but every occurrence must first pass Business role, location, and spend policy.

BEGIN;

ALTER TABLE recurring_task_series
  ADD COLUMN IF NOT EXISTS business_organization_id UUID
    REFERENCES business_organizations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS business_location_id UUID
    REFERENCES business_locations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS recurring_po_number TEXT,
  ADD COLUMN IF NOT EXISTS recurring_cost_center TEXT;

CREATE INDEX IF NOT EXISTS recurring_business_org_next_idx
  ON recurring_task_series(business_organization_id,next_occurrence_at)
  WHERE business_organization_id IS NOT NULL AND status='active';

ALTER TABLE recurring_task_occurrences
  ADD COLUMN IF NOT EXISTS business_approval_request_id UUID
    REFERENCES business_approval_requests(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS recurring_business_approval_unique
  ON recurring_task_occurrences(business_approval_request_id)
  WHERE business_approval_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_business_recurring_template_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.contract_version < 2 THEN RETURN NEW; END IF;
  IF NEW.client_principal_type='ORGANIZATION' THEN
    IF NEW.business_organization_id IS NULL
       OR NEW.business_location_id IS NULL
       OR NEW.client_principal_id IS DISTINCT FROM NEW.business_organization_id
       OR NOT EXISTS (
         SELECT 1 FROM business_locations location
         WHERE location.id=NEW.business_location_id
           AND location.organization_id=NEW.business_organization_id
       )
       OR ((TG_OP='INSERT' OR NEW.status='active') AND NOT EXISTS (
         SELECT 1
         FROM business_organizations organization
         JOIN business_locations location
           ON location.organization_id=organization.id
         JOIN business_memberships membership
           ON membership.organization_id=organization.id
         WHERE organization.id=NEW.business_organization_id
           AND organization.status='ACTIVE'
           AND organization.client_enabled=TRUE
           AND location.id=NEW.business_location_id
           AND location.status='ACTIVE'
           AND membership.user_id=NEW.poster_id
           AND membership.status='ACTIVE'
           AND membership.role IN ('OWNER','ADMIN','DISPATCHER','REQUESTER')
       ))
    THEN
      RAISE EXCEPTION 'HXBUSREC1: organization recurring scope is unauthorized';
    END IF;
  ELSIF NEW.business_organization_id IS NOT NULL OR NEW.business_location_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXBUSREC2: household recurrence cannot carry Business authority';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS recurring_business_template_scope_guard ON recurring_task_series;
CREATE TRIGGER recurring_business_template_scope_guard
BEFORE INSERT OR UPDATE ON recurring_task_series
FOR EACH ROW EXECUTE FUNCTION enforce_business_recurring_template_scope();

CREATE OR REPLACE FUNCTION enforce_business_recurring_occurrence_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_series recurring_task_series%ROWTYPE;
BEGIN
  SELECT * INTO v_series FROM recurring_task_series WHERE id=NEW.series_id;
  IF v_series.client_principal_type='ORGANIZATION' THEN
    IF NEW.business_approval_request_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM business_approval_requests approval
      JOIN tasks task ON task.id=approval.canonical_task_id
      WHERE approval.id=NEW.business_approval_request_id
        AND approval.organization_id=v_series.business_organization_id
        AND approval.location_id=v_series.business_location_id
        AND approval.requester_id=v_series.poster_id
        AND approval.status IN ('AUTO_APPROVED','APPROVED')
        AND approval.canonical_task_id=NEW.task_id
        AND task.business_organization_id=v_series.business_organization_id
        AND task.business_location_id=v_series.business_location_id
        AND task.business_approval_request_id=approval.id
        AND task.parent_series_id=v_series.id
    ) THEN
      RAISE EXCEPTION 'HXBUSREC3: occurrence lacks canonically bound Business approval';
    END IF;
  ELSIF NEW.business_approval_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXBUSREC4: household occurrence cannot carry Business approval';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS recurring_business_occurrence_scope_guard ON recurring_task_occurrences;
CREATE TRIGGER recurring_business_occurrence_scope_guard
BEFORE INSERT OR UPDATE ON recurring_task_occurrences
FOR EACH ROW EXECUTE FUNCTION enforce_business_recurring_occurrence_scope();

CREATE OR REPLACE FUNCTION pause_business_recurrence_on_location_close()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_template RECORD;
BEGIN
  IF NEW.status='CLOSED' AND OLD.status IS DISTINCT FROM NEW.status THEN
    FOR v_template IN
      SELECT id FROM recurring_task_series
      WHERE business_location_id=NEW.id AND status='active' AND contract_version>=2
    LOOP
      PERFORM pause_recurring_template(
        v_template.id,'LOCATION_CLOSED',jsonb_build_object('business_location_id',NEW.id),NULL
      );
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS business_location_recurring_pause ON business_locations;
CREATE TRIGGER business_location_recurring_pause
AFTER UPDATE OF status ON business_locations
FOR EACH ROW EXECUTE FUNCTION pause_business_recurrence_on_location_close();

CREATE OR REPLACE FUNCTION pause_business_recurrence_on_authority_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_template RECORD;
BEGIN
  IF NOT business_membership_has_action(NEW.organization_id,NEW.user_id,'CREATE_WORK_ORDER') THEN
    FOR v_template IN
      SELECT id FROM recurring_task_series
      WHERE business_organization_id=NEW.organization_id AND poster_id=NEW.user_id
        AND status='active' AND contract_version>=2
    LOOP
      PERFORM pause_recurring_template(
        v_template.id,'BUSINESS_AUTHORITY_REVOKED',
        jsonb_build_object('membership_id',NEW.id,'role',NEW.role,'status',NEW.status),NULL
      );
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS business_membership_recurring_pause ON business_memberships;
CREATE TRIGGER business_membership_recurring_pause
AFTER UPDATE OF role,status ON business_memberships
FOR EACH ROW EXECUTE FUNCTION pause_business_recurrence_on_authority_change();

CREATE OR REPLACE FUNCTION pause_business_recurrence_on_workspace_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_template RECORD;
BEGIN
  IF NEW.status<>'ACTIVE' OR NEW.client_enabled IS NOT TRUE THEN
    FOR v_template IN
      SELECT id FROM recurring_task_series
      WHERE business_organization_id=NEW.id AND status='active' AND contract_version>=2
    LOOP
      PERFORM pause_recurring_template(
        v_template.id,'BUSINESS_WORKSPACE_INACTIVE',
        jsonb_build_object('organization_status',NEW.status,'client_enabled',NEW.client_enabled),NULL
      );
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS business_workspace_recurring_pause ON business_organizations;
CREATE TRIGGER business_workspace_recurring_pause
AFTER UPDATE OF status,client_enabled ON business_organizations
FOR EACH ROW EXECUTE FUNCTION pause_business_recurrence_on_workspace_change();

REVOKE ALL ON FUNCTION pause_business_recurrence_on_location_close() FROM PUBLIC;
REVOKE ALL ON FUNCTION pause_business_recurrence_on_authority_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION pause_business_recurrence_on_workspace_change() FROM PUBLIC;

COMMIT;
