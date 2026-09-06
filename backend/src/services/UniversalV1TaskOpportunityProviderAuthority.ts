import type { QueryFn } from '../db.js';
import {
  fail,
  type ActiveProviderIdentityRow,
  type ProviderAuthority,
  type ProviderAuthorityRow,
  type UniversalV1TaskOpportunityProviderClass,
  type UniversalV1TaskOpportunityProviderSelection,
  universalV1TaskOpportunityProviderClasses,
} from './UniversalV1TaskOpportunityModel.js';

async function loadProviderAuthorityRow(
  query: QueryFn,
  providerUserId: string,
  providerOrganizationId: string | null,
  businessCredentialId: string | null
): Promise<ProviderAuthorityRow | undefined> {
  const result = await query<ProviderAuthorityRow>(
    `SELECT actor.account_status,
            actor.is_minor,
            COALESCE(actor.is_banned, FALSE) AS is_banned,
            profile.provider_class AS profile_provider_class,
            profile.updated_at AS profile_updated_at,
            organization.provider_class AS organization_provider_class,
            organization.status AS organization_status,
            organization.verification_status AS organization_verification_status,
            organization.provider_enabled AS organization_provider_enabled,
            EXISTS (
              SELECT 1
              FROM public.business_memberships membership
              WHERE membership.organization_id = $2::UUID
                AND membership.user_id = actor.id
                AND membership.status = 'ACTIVE'
                AND membership.role IN ('OWNER', 'ADMIN', 'DISPATCHER', 'CREW')
            ) AS active_membership,
            EXISTS (
              SELECT 1
              FROM public.current_verified_trade_qualifications qualification
              WHERE qualification.provider_user_id = actor.id
                AND qualification.organization_id = $2::UUID
                AND qualification.business_credential_id = $3::UUID
            ) AS current_trade_credential
     FROM public.users actor
     LEFT JOIN public.capability_profiles profile ON profile.user_id = actor.id
     LEFT JOIN public.business_organizations organization ON organization.id = $2::UUID
     WHERE actor.id = $1::UUID
     LIMIT 1`,
    [providerUserId, providerOrganizationId, businessCredentialId]
  );
  return result.rows[0];
}

function identitySelection(
  row: ProviderAuthorityRow | undefined,
  providerOrganizationId: string | null,
  businessCredentialId: string | null
): ProviderAuthority | null {
  if (!row || row.account_status !== 'ACTIVE' || row.is_minor !== false || row.is_banned === true) {
    return { state: 'HELD', blockerCodes: ['PROVIDER_IDENTITY_UNAVAILABLE'] };
  }
  if (
    !row.profile_updated_at ||
    !universalV1TaskOpportunityProviderClasses.includes(
      row.profile_provider_class as UniversalV1TaskOpportunityProviderClass
    )
  ) {
    return { state: 'HELD', blockerCodes: ['PROVIDER_CAPABILITY_UNRESOLVED'] };
  }
  if (providerOrganizationId) return null;
  if (businessCredentialId) {
    return { state: 'HELD', blockerCodes: ['ORGANIZATION_REQUIRED_FOR_TRADE_CREDENTIAL'] };
  }
  if (row.profile_provider_class !== 'GENERAL_SERVICE_PROVIDER') {
    return { state: 'HELD', blockerCodes: ['VERIFIED_TRADE_BUSINESS_SELECTION_REQUIRED'] };
  }
  return {
    state: 'READY',
    providerClass: 'GENERAL_SERVICE_PROVIDER',
    providerOrganizationId: null,
    businessCredentialId: null,
  };
}

function generalBusinessSelection(
  row: ProviderAuthorityRow,
  providerOrganizationId: string,
  businessCredentialId: string | null
): ProviderAuthority {
  if (businessCredentialId || row.profile_provider_class !== 'GENERAL_SERVICE_PROVIDER') {
    return { state: 'HELD', blockerCodes: ['GENERAL_PROVIDER_BUSINESS_SELECTION_INCONSISTENT'] };
  }
  return {
    state: 'READY',
    providerClass: 'GENERAL_SERVICE_PROVIDER',
    providerOrganizationId,
    businessCredentialId: null,
  };
}

function tradeBusinessSelection(
  row: ProviderAuthorityRow,
  providerOrganizationId: string,
  businessCredentialId: string | null
): ProviderAuthority {
  if (
    !businessCredentialId ||
    row.profile_provider_class !== 'VERIFIED_TRADE_BUSINESS' ||
    row.current_trade_credential !== true
  ) {
    return { state: 'HELD', blockerCodes: ['CURRENT_TRADE_QUALIFICATION_UNRESOLVED'] };
  }
  return {
    state: 'READY',
    providerClass: 'VERIFIED_TRADE_BUSINESS',
    providerOrganizationId,
    businessCredentialId,
  };
}

function organizationSelection(
  row: ProviderAuthorityRow,
  providerOrganizationId: string,
  businessCredentialId: string | null
): ProviderAuthority {
  const organizationReady = row.organization_status === 'ACTIVE'
    && row.organization_verification_status === 'VERIFIED'
    && row.organization_provider_enabled === true
    && row.active_membership === true;
  if (!organizationReady) {
    return { state: 'HELD', blockerCodes: ['PROVIDER_BUSINESS_AUTHORITY_UNRESOLVED'] };
  }
  if (row.organization_provider_class === 'GENERAL_SERVICE_PROVIDER') {
    return generalBusinessSelection(row, providerOrganizationId, businessCredentialId);
  }
  if (row.organization_provider_class === 'VERIFIED_TRADE_BUSINESS') {
    return tradeBusinessSelection(row, providerOrganizationId, businessCredentialId);
  }
  return { state: 'HELD', blockerCodes: ['PROVIDER_BUSINESS_CLASS_UNRESOLVED'] };
}

export async function resolveProviderAuthority(
  query: QueryFn,
  providerUserId: string,
  selection: UniversalV1TaskOpportunityProviderSelection
): Promise<ProviderAuthority> {
  const providerOrganizationId = selection.providerOrganizationId ?? null;
  const businessCredentialId = selection.businessCredentialId ?? null;
  const row = await loadProviderAuthorityRow(
    query,
    providerUserId,
    providerOrganizationId,
    businessCredentialId
  );
  const identity = identitySelection(row, providerOrganizationId, businessCredentialId);
  if (identity) return identity;
  return organizationSelection(row!, providerOrganizationId!, businessCredentialId);
}

export async function assertActiveProviderIdentity(
  query: QueryFn,
  providerUserId: string
): Promise<void> {
  const result = await query<ActiveProviderIdentityRow>(
    `SELECT EXISTS (
       SELECT 1
       FROM public.users actor
       WHERE actor.id = $1::UUID
         AND actor.account_status = 'ACTIVE'
         AND actor.is_minor IS FALSE
         AND COALESCE(actor.is_banned, FALSE) IS FALSE
     ) AS active_provider_identity`,
    [providerUserId]
  );
  if (result.rows[0]?.active_provider_identity !== true) {
    return fail('PRECONDITION_FAILED', 'Current active adult provider identity is required.');
  }
}
