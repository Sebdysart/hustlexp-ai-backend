import { createHash, randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { encryptTaskLocation, decryptTaskLocation } from './TaskLocationCrypto.js';
import { requireBusinessManagementAuthority, recordBusinessManagementAudit } from './BusinessManagementAuthority.js';
import type { BusinessRole } from './BusinessWorkspacePolicy.js';
import {
  ensureBusinessTestPayoutDestination,
} from './BusinessTestPayoutDestinationService.js';

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
  washingtonUbi: string;
  federalEin: string;
}): Promise<ServiceResult<{ id: string; role: 'OWNER' }>> {
  try {
    const washingtonUbi = input.washingtonUbi.replace(/\D/g, '');
    const federalEin = input.federalEin.replace(/\D/g, '');

    const result = await db.query<{
      organization_id: string;
      actor_role: 'OWNER';
    }>(
      `
      SELECT
        organization_id,
        actor_role
      FROM create_business_organization(
        $1,$2,$3,$4,$5,$6,$7,$8
      )
      `,
      [
        input.actorId,
        input.legalName,
        input.displayName,
        input.providerEnabled,
        input.clientEnabled,
        input.idempotencyKey,
        washingtonUbi,
        federalEin,
      ],
    );

    const row = result.rows[0];

    if (!row) {
      return failure(
        null,
        'BUSINESS_CREATE_FAILED',
        'The business workspace was not created.',
      );
    }

    if (input.providerEnabled) {
      await ensureBusinessTestPayoutDestination({
        organizationId: row.organization_id,
        payoutRecipientUserId: input.actorId,
      });
    }

    return {
      success: true,
      data: {
        id: row.organization_id,
        role: row.actor_role,
      },
    };
  } catch (error) {
    return failure(
      error,
      'BUSINESS_CREATE_FAILED',
      'The business workspace was not created.',
    );
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

export async function getBusinessAddress(actorId: string, organizationId: string) {
  return db.transaction(async (query) => {
    await requireBusinessManagementAuthority(query,actorId,organizationId,'MANAGE_LOCATIONS');
    const address=await query<{id:string;rough_location:string;postal_code:string;region_code:string;timezone:string;exact_address_ciphertext:string;exact_address_nonce:string;exact_address_auth_tag:string;exact_address_key_id:string}>(
      `SELECT id,rough_location,postal_code,region_code,timezone,exact_address_ciphertext,exact_address_nonce,exact_address_auth_tag,exact_address_key_id
       FROM business_locations WHERE organization_id=$1 AND purpose='BUSINESS_ADDRESS' AND status='ACTIVE'`,[organizationId]);
    const row=address.rows[0];
    if(!row) return null;
    return {id:row.id,roughLocation:row.rough_location,postalCode:row.postal_code,regionCode:row.region_code,timezone:row.timezone,
      exactAddress:decryptTaskLocation(row.id,{location_ciphertext:row.exact_address_ciphertext,location_nonce:row.exact_address_nonce,location_auth_tag:row.exact_address_auth_tag,location_key_id:row.exact_address_key_id})};
  });
}

/** One encrypted business/billing address, independent of service coverage. */
export async function saveBusinessAddress(input:{actorId:string;organizationId:string;exactAddress:string;roughLocation:string;postalCode:string;regionCode:string;timezone:string}) {
  return db.transaction(async(query)=>{
    await query('SELECT id FROM business_organizations WHERE id=$1 FOR UPDATE',[input.organizationId]);
    await requireBusinessManagementAuthority(query,input.actorId,input.organizationId,'MANAGE_LOCATIONS');
    const previous=await query<{id:string}>(`SELECT id FROM business_locations WHERE organization_id=$1 AND purpose='BUSINESS_ADDRESS' AND status='ACTIVE' FOR UPDATE`,[input.organizationId]);
    const id=previous.rows[0]?.id ?? randomUUID();
    const encrypted=encryptTaskLocation(id,input.exactAddress);
    const access=encryptTaskLocation(`${id}:access`,'Business billing address; no customer task access instructions.');
    await query(`INSERT INTO business_locations(id,organization_id,name,rough_location,postal_code,region_code,timezone,purpose,
      exact_address_ciphertext,exact_address_nonce,exact_address_auth_tag,exact_address_key_id,exact_address_fingerprint,
      access_ciphertext,access_nonce,access_auth_tag,access_key_id,access_fingerprint,created_by,creation_idempotency_key)
      VALUES($1,$2,'Business / billing address',$3,$4,$5,$6,'BUSINESS_ADDRESS',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT(id) DO UPDATE SET rough_location=EXCLUDED.rough_location,postal_code=EXCLUDED.postal_code,region_code=EXCLUDED.region_code,timezone=EXCLUDED.timezone,
        exact_address_ciphertext=EXCLUDED.exact_address_ciphertext,exact_address_nonce=EXCLUDED.exact_address_nonce,exact_address_auth_tag=EXCLUDED.exact_address_auth_tag,
        exact_address_key_id=EXCLUDED.exact_address_key_id,exact_address_fingerprint=EXCLUDED.exact_address_fingerprint,updated_at=NOW()`,
      [id,input.organizationId,input.roughLocation,input.postalCode,input.regionCode,input.timezone,encrypted.ciphertext,encrypted.nonce,encrypted.authTag,encrypted.keyId,encrypted.fingerprint,
        access.ciphertext,access.nonce,access.authTag,access.keyId,access.fingerprint,input.actorId,`business-address:${id}`]);
    await recordBusinessManagementAudit(query,{actorId:input.actorId,organizationId:input.organizationId,action:'business_address_saved',objectType:'business_location',objectId:id,after:{purpose:'BUSINESS_ADDRESS',regionCode:input.regionCode}});
    return {id};
  });
}

export async function selectBusinessServices(input:{actorId:string;organizationId:string;serviceCodes:string[]}) {
  return db.transaction(async(query)=>{
    await query('SELECT id FROM business_organizations WHERE id=$1 FOR UPDATE',[input.organizationId]);
    await requireBusinessManagementAuthority(query,input.actorId,input.organizationId,'MANAGE_SERVICES');
    const codes=[...new Set(input.serviceCodes)];
    const categories=await query<{id:string;code:string;display_name:string}>(`SELECT id,code,display_name FROM service_categories WHERE code=ANY($1::text[]) AND status='ACTIVE' FOR SHARE`,[codes]);
    if(categories.rows.length!==codes.length) throw new TRPCError({code:'BAD_REQUEST',message:'Select active canonical service categories.'});
    await query(`UPDATE business_service_profiles SET selected_by_business=false,updated_at=NOW() WHERE organization_id=$1 AND selected_by_business AND NOT(service_code=ANY($2::text[]))`,[input.organizationId,codes]);
    for(const category of categories.rows) {
      await query(`INSERT INTO business_service_profiles(organization_id,service_code,service_category_id,service_name,service_description,
        pricing_mode,response_mode,status,selected_by_business,eligibility_status,created_by,creation_idempotency_key)
        VALUES($1,$2,$3,$4,$5,'QUOTE_REQUIRED','INDIVIDUAL_OFFERS','DRAFT',true,'DECLARED',$6,$7)
        ON CONFLICT(organization_id,service_code) DO UPDATE SET service_category_id=EXCLUDED.service_category_id,selected_by_business=true,updated_at=NOW()`,
        [input.organizationId,category.code,category.id,category.display_name,`Business offers ${category.display_name} services.`,input.actorId,`stage1-service:${category.code}`]);
    }
    await recordBusinessManagementAudit(query,{actorId:input.actorId,organizationId:input.organizationId,action:'business_services_selected',objectType:'business_organization',objectId:input.organizationId,after:{serviceCodes:codes}});
    return {ok:true as const};
  });
}
