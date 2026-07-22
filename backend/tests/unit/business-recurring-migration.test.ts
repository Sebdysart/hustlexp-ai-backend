import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('../../database/migrations/20260718_business_recurring_contract.sql', import.meta.url),
  'utf8',
);

describe('business recurring database contract', () => {
  it('binds organization recurrence to Business organization and location scope', () => {
    expect(sql).toContain('business_organization_id');
    expect(sql).toContain('business_location_id');
    expect(sql).toContain("membership.role IN ('OWNER','ADMIN','DISPATCHER','REQUESTER')");
    expect(sql).toContain('organization.client_enabled=TRUE');
    expect(sql).toContain('HXBUSREC1');
  });

  it('requires each organization occurrence to reconcile to approved canonical demand', () => {
    expect(sql).toContain('business_approval_request_id');
    expect(sql).toContain("approval.status IN ('AUTO_APPROVED','APPROVED')");
    expect(sql).toContain('approval.canonical_task_id=NEW.task_id');
    expect(sql).toContain('task.parent_series_id=v_series.id');
    expect(sql).toContain('HXBUSREC3');
  });

  it('prevents Business authority from being smuggled onto household recurrence', () => {
    expect(sql).toContain('HXBUSREC2');
    expect(sql).toContain('HXBUSREC4');
  });

  it('pauses recurrence when live Business authority is withdrawn', () => {
    expect(sql).toContain('business_location_recurring_pause');
    expect(sql).toContain("'LOCATION_CLOSED'");
    expect(sql).toContain('business_membership_recurring_pause');
    expect(sql).toContain("'BUSINESS_AUTHORITY_REVOKED'");
    expect(sql).toContain('business_workspace_recurring_pause');
    expect(sql).toContain("'BUSINESS_WORKSPACE_INACTIVE'");
  });
});
