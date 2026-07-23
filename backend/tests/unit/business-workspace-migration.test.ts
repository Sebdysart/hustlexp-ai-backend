import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260718_business_workspace_contract.sql'),
  'utf8',
);

describe('business workspace database contract', () => {
  it('models one organization that can operate in either or both business modes', () => {
    expect(sql).toContain('business_organizations');
    expect(sql).toContain('provider_enabled');
    expect(sql).toContain('client_enabled');
    expect(sql).toContain('business_organization_requires_mode');
  });

  it('stores membership-backed roles and protects the last active owner', () => {
    expect(sql).toContain('business_memberships');
    for (const role of [
      'OWNER', 'ADMIN', 'DISPATCHER', 'APPROVER', 'REQUESTER', 'VIEWER', 'CREW',
    ]) expect(sql).toContain(`'${role}'`);
    expect(sql).toContain('business_membership_has_action');
    expect(sql).toContain('protect_business_last_owner');
    expect(sql).toContain('HXBUS3');
  });

  it('stores only encrypted exact location and access instructions', () => {
    expect(sql).toContain('business_locations');
    for (const field of [
      'exact_address_ciphertext', 'exact_address_nonce', 'exact_address_auth_tag',
      'exact_address_key_id', 'access_ciphertext', 'access_nonce',
      'access_auth_tag', 'access_key_id',
    ]) expect(sql).toContain(field);
    expect(sql).not.toMatch(/\bexact_address\s+TEXT\b/i);
    expect(sql).not.toMatch(/\baccess_instructions\s+TEXT\b/i);
  });

  it('makes membership, location, and organization writes auditable', () => {
    expect(sql).toContain('business_audit_events');
    expect(sql).toContain('prevent_business_audit_mutation');
    expect(sql).toContain('create_business_organization');
    expect(sql).toContain('set_business_member_role');
    expect(sql).toContain('set_business_member_role_by_email');
    expect(sql).toContain('create_business_location');
  });

  it('does not grant direct public access to authority-changing functions', () => {
    for (const fn of [
      'create_business_organization', 'set_business_member_role',
      'set_business_member_role_by_email', 'create_business_location',
    ]) expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}`, 'i'));
  });
});
