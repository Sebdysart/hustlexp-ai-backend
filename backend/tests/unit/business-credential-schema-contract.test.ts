import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const sql=readFileSync(new URL('../../database/migrations/20261007_business_credentials_evidence.sql',import.meta.url),'utf8');
describe('credential and business address schema contract',()=>{
  it('keeps one explicit business address without changing legacy operating locations',()=>{
    expect(sql).toContain("DEFAULT 'OPERATING_LOCATION'");
    expect(sql).toContain("WHERE purpose='BUSINESS_ADDRESS' AND status='ACTIVE'");
    expect(sql).not.toMatch(/DROP TABLE|coverage_postal_codes|maximum_travel_miles/);
  });
  it('preserves legacy credential rows and captures their history before normalized replacement',()=>{
    expect(sql).toContain('WHERE c.credential_type=t.code AND c.credential_type_id IS NULL');
    expect(sql).toContain('Legacy credential before versioned submissions');
    expect(sql).toContain('to_jsonb(c)');
    expect(sql).not.toMatch(/ALTER COLUMN membership_id SET NOT NULL/);
  });
  it('binds current versions and evidence to the exact credential and organization',()=>{
    expect(sql).toContain('FOREIGN KEY (current_version_id,id,organization_id)');
    expect(sql).toContain('REFERENCES business_credential_versions(id,credential_id,organization_id)');
    expect(sql).toContain('upload_receipt_id UUID NOT NULL UNIQUE');
    expect(sql).toContain('submission_idempotency_key');
  });
  it('extends purpose without making media public or allowing mixed task/organization targets',()=>{
    expect(sql).toContain("'PROOF','MESSAGE','TASK_DRAFT_PHOTO','BUSINESS_CREDENTIAL'");
    expect(sql).toContain("purpose='BUSINESS_CREDENTIAL' AND task_id IS NULL AND task_draft_id IS NULL AND organization_id IS NOT NULL");
    expect(sql).toContain('NEW.organization_id IS DISTINCT FROM OLD.organization_id');
  });
  it('keeps version, review, evidence, and access history append-only',()=>{
    expect(sql).toContain("ARRAY['business_credential_versions','business_credential_events','business_credential_evidence','business_credential_media_access_log']");
    expect(sql).toContain('BEFORE UPDATE OR DELETE');
    expect(sql).toContain('prevent_business_audit_mutation()');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('REVOKE ALL ON TABLE %I FROM PUBLIC');
  });
});
