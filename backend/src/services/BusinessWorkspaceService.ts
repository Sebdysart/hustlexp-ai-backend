import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { encryptTaskLocation } from './TaskLocationCrypto.js';
import type { BusinessRole } from './BusinessWorkspacePolicy.js';

const log = logger.child({ service: 'BusinessWorkspaceService' });

export interface BusinessWorkspaceSummary {
  id: string;
  displayName: string;
  providerEnabled: boolean;
  clientEnabled: boolean;
  verificationStatus: 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';
  payoutStatus: 'NOT_STARTED' | 'PENDING' | 'ACTIVE' | 'RESTRICTED' | 'DISABLED';
  role: BusinessRole;
  memberCount: number;
  locationCount: number;
}

export interface BusinessMemberSummary {
  id: string;
  userId: string;
  fullName: string;
  role: BusinessRole;
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
}

export interface BusinessLocationSummary {
  id: string;
  name: string;
  roughLocation: string;
  postalCode: string;
  regionCode: string;
  timezone: string;
  status: 'ACTIVE' | 'CLOSED';
  accessConfigured: boolean;
}

function failure(error: unknown, fallbackCode: string, fallbackMessage: string): ServiceResult<never> {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('HXBUS2')) {
    return { success: false, error: {
      code: 'BUSINESS_PERMISSION_DENIED', message: 'This business action is not permitted.',
    } };
  }
  if (message.includes('HXBUS3')) {
    return { success: false, error: {
      code: 'BUSINESS_OWNER_REQUIRED', message: 'The workspace must retain an active owner.',
    } };
  }
  if (message.includes('HXBUS4')) {
    return { success: false, error: {
      code: 'IDEMPOTENCY_CONFLICT', message: 'That request key was already used for different details.',
    } };
  }
  if (message.includes('HXBUS6')) {
    return { success: false, error: {
      code: 'BUSINESS_MEMBER_NOT_FOUND', message: 'No eligible HustleXP account matched that email.',
    } };
  }
  log.error({ err: message || 'unknown' }, fallbackMessage);
  return { success: false, error: { code: fallbackCode, message: fallbackMessage } };
}

export async function createBusinessWorkspace(input: {
  actorId: string;
  legalName: string;
  displayName: string;
  providerEnabled: boolean;
  clientEnabled: boolean;
  idempotencyKey: string;
}): Promise<ServiceResult<{ id: string; role: 'OWNER' }>> {
  try {
    const result = await db.query<{ organization_id: string; actor_role: 'OWNER' }>(
      `SELECT organization_id,actor_role
       FROM create_business_organization($1,$2,$3,$4,$5,$6)`,
      [
        input.actorId, input.legalName, input.displayName,
        input.providerEnabled, input.clientEnabled, input.idempotencyKey,
      ],
    );
    const row = result.rows[0];
    if (!row) return failure(null, 'BUSINESS_CREATE_FAILED', 'The business workspace was not created.');
    return { success: true, data: { id: row.organization_id, role: row.actor_role } };
  } catch (error) {
    return failure(error, 'BUSINESS_CREATE_FAILED', 'The business workspace was not created.');
  }
}

export async function listBusinessWorkspaces(
  actorId: string,
): Promise<ServiceResult<BusinessWorkspaceSummary[]>> {
  try {
    const result = await db.query<{
      id: string; display_name: string; provider_enabled: boolean; client_enabled: boolean;
      verification_status: BusinessWorkspaceSummary['verificationStatus'];
      payout_status: BusinessWorkspaceSummary['payoutStatus']; role: BusinessRole;
      member_count: number | string; location_count: number | string;
    }>(
      `SELECT organization.id,organization.display_name,organization.provider_enabled,
              organization.client_enabled,organization.verification_status,
              organization.payout_status,membership.role,
              (SELECT COUNT(*) FROM business_memberships members
               WHERE members.organization_id=organization.id AND members.status='ACTIVE') AS member_count,
              (SELECT COUNT(*) FROM business_locations locations
               WHERE locations.organization_id=organization.id AND locations.status='ACTIVE') AS location_count
       FROM business_memberships membership
       JOIN business_organizations organization ON organization.id=membership.organization_id
       WHERE membership.user_id=$1 AND membership.status='ACTIVE' AND organization.status='ACTIVE'
       ORDER BY organization.created_at DESC`,
      [actorId],
    );
    return { success: true, data: result.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      providerEnabled: row.provider_enabled,
      clientEnabled: row.client_enabled,
      verificationStatus: row.verification_status,
      payoutStatus: row.payout_status,
      role: row.role,
      memberCount: Number(row.member_count),
      locationCount: Number(row.location_count),
    })) };
  } catch (error) {
    return failure(error, 'BUSINESS_LIST_FAILED', 'Business workspaces could not be loaded.');
  }
}

export async function setBusinessMemberRole(input: {
  actorId: string;
  organizationId: string;
  memberUserId: string;
  role: BusinessRole;
}): Promise<ServiceResult<{ id: string; role: BusinessRole }>> {
  try {
    const result = await db.query<{ membership_id: string; member_role: BusinessRole }>(
      `SELECT membership_id,member_role
       FROM set_business_member_role($1,$2,$3,$4)`,
      [input.organizationId, input.actorId, input.memberUserId, input.role],
    );
    const row = result.rows[0];
    if (!row) return failure(null, 'BUSINESS_MEMBER_FAILED', 'The business member was not updated.');
    return { success: true, data: { id: row.membership_id, role: row.member_role } };
  } catch (error) {
    return failure(error, 'BUSINESS_MEMBER_FAILED', 'The business member was not updated.');
  }
}

export async function setBusinessMemberRoleByEmail(input: {
  actorId: string;
  organizationId: string;
  memberEmail: string;
  role: BusinessRole;
}): Promise<ServiceResult<{ id: string; role: BusinessRole }>> {
  try {
    const result = await db.query<{ membership_id: string; member_role: BusinessRole }>(
      `SELECT membership_id,member_role
       FROM set_business_member_role_by_email($1,$2,$3,$4)`,
      [
        input.organizationId,
        input.actorId,
        input.memberEmail.trim().toLowerCase(),
        input.role,
      ],
    );
    const row = result.rows[0];
    if (!row) return failure(null, 'BUSINESS_MEMBER_FAILED', 'The business member was not updated.');
    return { success: true, data: { id: row.membership_id, role: row.member_role } };
  } catch (error) {
    return failure(error, 'BUSINESS_MEMBER_FAILED', 'The business member was not updated.');
  }
}

export async function listBusinessMembers(
  actorId: string,
  organizationId: string,
): Promise<ServiceResult<BusinessMemberSummary[]>> {
  try {
    const result = await db.query<{
      id: string; user_id: string; full_name: string; role: BusinessRole;
      status: BusinessMemberSummary['status'];
    }>(
      `WITH authority AS (
         SELECT business_require_action($1,$2,'READ_WORKSPACE')
       )
       SELECT membership.id,membership.user_id,account.full_name,membership.role,membership.status
       FROM business_memberships membership
       JOIN users account ON account.id=membership.user_id
       CROSS JOIN authority
       WHERE membership.organization_id=$1
       ORDER BY membership.created_at ASC`,
      [organizationId, actorId],
    );
    return { success: true, data: result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      fullName: row.full_name,
      role: row.role,
      status: row.status,
    })) };
  } catch (error) {
    return failure(error, 'BUSINESS_MEMBER_LIST_FAILED', 'Business members could not be loaded.');
  }
}

function deterministicLocationId(organizationId: string, idempotencyKey: string): string {
  const hex = createHash('sha256')
    .update(`hustlexp:business-location:v1:${organizationId}:${idempotencyKey}`, 'utf8')
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export async function createBusinessLocation(input: {
  actorId: string;
  organizationId: string;
  name: string;
  roughLocation: string;
  postalCode: string;
  regionCode: string;
  timezone: string;
  exactAddress: string;
  accessProcedure: string;
  idempotencyKey: string;
}): Promise<ServiceResult<{ id: string }>> {
  try {
    const locationId = deterministicLocationId(input.organizationId, input.idempotencyKey);
    const exactAddress = encryptTaskLocation(locationId, input.exactAddress);
    const access = encryptTaskLocation(`${locationId}:access`, input.accessProcedure);
    const result = await db.query<{ location_id: string }>(
      `SELECT location_id
       FROM create_business_location($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
      [
        input.organizationId, input.actorId, locationId, input.name, input.roughLocation,
        input.postalCode, input.regionCode, input.timezone,
        JSON.stringify(exactAddress), JSON.stringify(access), input.idempotencyKey,
      ],
    );
    const row = result.rows[0];
    if (!row) return failure(null, 'BUSINESS_LOCATION_FAILED', 'The business location was not created.');
    return { success: true, data: { id: row.location_id } };
  } catch (error) {
    return failure(error, 'BUSINESS_LOCATION_FAILED', 'The business location was not created.');
  }
}

export async function listBusinessLocations(
  actorId: string,
  organizationId: string,
): Promise<ServiceResult<BusinessLocationSummary[]>> {
  try {
    const result = await db.query<{
      id: string; name: string; rough_location: string; postal_code: string;
      region_code: string; timezone: string; status: BusinessLocationSummary['status'];
      access_configured: boolean;
    }>(
      `WITH authority AS (
         SELECT business_require_action($1,$2,'READ_WORKSPACE')
       )
       SELECT location.id,location.name,location.rough_location,location.postal_code,
              location.region_code,location.timezone,location.status,TRUE AS access_configured
       FROM business_locations location
       CROSS JOIN authority
       WHERE location.organization_id=$1
       ORDER BY location.created_at DESC`,
      [organizationId, actorId],
    );
    return { success: true, data: result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      roughLocation: row.rough_location,
      postalCode: row.postal_code,
      regionCode: row.region_code,
      timezone: row.timezone,
      status: row.status,
      accessConfigured: row.access_configured,
    })) };
  } catch (error) {
    return failure(error, 'BUSINESS_LOCATION_LIST_FAILED', 'Business locations could not be loaded.');
  }
}
