import { createHash } from 'node:crypto';
import type { QueryFn } from '../db.js';
import { SERVICE_CATEGORY_CODES, SERVICE_CATEGORY_LABELS, isServiceCategoryCode } from '../contracts/serviceCategories.js';
import { isServiceJurisdiction } from '../contracts/serviceJurisdiction.js';

export const BUSINESS_ELIGIBILITY_VERSION = 'stage1-v1';
export type CategoryPolicyStatus = 'UNRESTRICTED' | 'CREDENTIAL_REQUIRED' | 'MANUAL_REVIEW_REQUIRED' | 'DISABLED';
export type ServiceEligibilityStatus = 'DECLARED' | 'PENDING_REVIEW' | 'ELIGIBLE' | 'BLOCKED';
type DateValue = Date | string | null;
export interface CategoryRow { id: string; code: string; display_name: string; status: string }
export interface ProfileRow {
  id: string; service_code: string; service_category_id: string; selected_by_business: boolean;
  eligibility_status: ServiceEligibilityStatus; eligibility_reviewed_policy_id: string | null;
  eligibility_reviewed_at: DateValue; eligibility_reviewed_by: string | null;
}
export interface PolicyRow {
  id: string; service_category_id: string; jurisdiction_code: string; policy_status: CategoryPolicyStatus;
  policy_version: number; effective_from: DateValue; effective_to: DateValue; manual_review_required: boolean;
}
export interface RequirementRow {
  id: string; service_category_policy_id: string; credential_type_id: string; required: boolean;
  code: string; display_name: string; status: string; jurisdiction_code: string | null;
  requires_number: boolean; requires_evidence: boolean; supports_expiration: boolean;
}
export interface EligibilityCredentialRow {
  id: string; credential_type_id: string; membership_id: string | null; status: string;
  current_version_id: string | null; expires_at: DateValue; verified_at: DateValue; verified_by: string | null;
  issued_at: DateValue; jurisdiction_code: string | null; credential_number: string | null;
  evidence_count: number; version_snapshot: Record<string, unknown> | null;
}
export interface EligibilityContext {
  categories: CategoryRow[]; profiles: ProfileRow[]; policies: PolicyRow[];
  requirements: RequirementRow[]; credentials: EligibilityCredentialRow[]; evaluatedAt: Date;
}
export interface EligibilityReason { code: string; message: string; credentialTypeCode?: string }
export interface BusinessServiceEligibilitySummary {
  category: string; displayName: string; selected: boolean; serviceProfileId: string | null;
  eligible: boolean; eligibilityStatus: ServiceEligibilityStatus;
  policy: { id: string; status: CategoryPolicyStatus; jurisdictionCode: string; version: number; manualReviewRequired: boolean } | null;
  reasons: EligibilityReason[];
  requirements: Array<{credentialTypeId: string; credentialTypeCode: string; displayName: string; required: boolean;
    requiresNumber: boolean; requiresEvidence: boolean; supportsExpiration: boolean; satisfied: boolean;
    credentialId: string | null; credentialStatus: string | null }>;
  evaluatedAt: string;
}
export interface BusinessTaskEligibility extends BusinessServiceEligibilitySummary {
  primaryCategory: string; jurisdictionCode: string | null; policyHash: string;
  serviceProfile: ProfileRow | null;
  credentialEvidence: Array<{credentialId: string; credentialVersionId: string; credentialTypeId: string; credentialTypeCode: string;
    status: string; expiresAt: string | null; verifiedAt: string | null; verifiedBy: string | null;
    jurisdictionCode: string | null; credentialEvidence: Record<string, unknown>}>;
  requiredCredentialSnapshot: RequirementRow[];
}
const reasonMessages: Record<string, string> = {
  SERVICE_NOT_OFFERED: 'Select this service in your business settings before submitting a quote.',
  CATEGORY_DISABLED: 'This category is not currently available for business quotes.',
  MANUAL_REVIEW_REQUIRED: 'Ops must review this category before a business quote can be submitted.',
  SERVICE_PENDING_REVIEW: 'This business service requires Ops review before quoting.',
  REQUIRED_CREDENTIAL_MISSING: 'Submit the required business credentials before quoting this service.',
  CREDENTIAL_PENDING_VERIFICATION: 'A required credential is awaiting Ops verification.',
  CREDENTIAL_REJECTED: 'A required credential was rejected. Review it in business settings.',
  CREDENTIAL_REVOKED: 'A required credential was revoked. Contact Ops before quoting.',
  CREDENTIAL_EXPIRED: 'A required credential has expired. Submit its renewal before quoting.',
  CATEGORY_POLICY_MISSING: 'No unambiguous approved policy is available for this task jurisdiction. Contact Ops.',
};
export const BUSINESS_ELIGIBILITY_APPLICATION_CODES = {
  SERVICE_NOT_OFFERED: 'BUSINESS_SERVICE_NOT_OFFERED', CATEGORY_DISABLED: 'BUSINESS_CATEGORY_DISABLED',
  MANUAL_REVIEW_REQUIRED: 'BUSINESS_CATEGORY_MANUAL_REVIEW_REQUIRED', SERVICE_PENDING_REVIEW: 'BUSINESS_SERVICE_PENDING_REVIEW',
  REQUIRED_CREDENTIAL_MISSING: 'BUSINESS_CREDENTIAL_REQUIRED', CREDENTIAL_PENDING_VERIFICATION: 'BUSINESS_CREDENTIAL_PENDING',
  CREDENTIAL_REJECTED: 'BUSINESS_CREDENTIAL_REJECTED', CREDENTIAL_REVOKED: 'BUSINESS_CREDENTIAL_REVOKED',
  CREDENTIAL_EXPIRED: 'BUSINESS_CREDENTIAL_EXPIRED', CATEGORY_POLICY_MISSING: 'BUSINESS_CATEGORY_POLICY_MISSING',
} as const;
export function businessEligibilityFailure(result: BusinessTaskEligibility) {
  const reason = result.reasons[0] ?? { code: 'CATEGORY_POLICY_MISSING', message: reasonMessages.CATEGORY_POLICY_MISSING };
  return { code: BUSINESS_ELIGIBILITY_APPLICATION_CODES[reason.code as keyof typeof BUSINESS_ELIGIBILITY_APPLICATION_CODES]
    ?? 'BUSINESS_CATEGORY_POLICY_MISSING', message: reason.message };
}
function millis(value: DateValue): number { return value === null ? NaN : new Date(value).getTime(); }
function iso(value: DateValue): string | null { return Number.isFinite(millis(value)) ? new Date(value!).toISOString() : null; }

/** Pure evaluation of server-loaded facts. No secondary intents or operational activation fields. */
export function evaluateServiceEligibility(context: EligibilityContext, primaryCategory: string, jurisdictionCode: string | null): BusinessTaskEligibility {
  const now = context.evaluatedAt.getTime();
  const categories = context.categories.filter(c => c.code === primaryCategory);
  const category = categories.length === 1 ? categories[0] : null;
  const profiles = context.profiles.filter(p => p.service_code === primaryCategory && p.service_category_id === category?.id);
  const profile = profiles.length === 1 ? profiles[0] : null;
  const policies = context.policies.filter(p => p.service_category_id === category?.id && p.jurisdiction_code === jurisdictionCode
    && millis(p.effective_from) <= now && (p.effective_to === null || millis(p.effective_to) > now));
  const policy = policies.length === 1 ? policies[0] : null;
  const reasons: EligibilityReason[] = [];
  const addReason = (code: string, credentialTypeCode?: string) => reasons.push({ code, message: reasonMessages[code], ...(credentialTypeCode ? {credentialTypeCode} : {}) });
  if (!profile?.selected_by_business) addReason('SERVICE_NOT_OFFERED');
  if (category?.status === 'RETIRED' || policy?.policy_status === 'DISABLED') addReason('CATEGORY_DISABLED');
  if (!category || category.status !== 'ACTIVE' || !policy || !isServiceJurisdiction(jurisdictionCode)) addReason('CATEGORY_POLICY_MISSING');
  if (primaryCategory === 'other') addReason('MANUAL_REVIEW_REQUIRED');
  if (profile?.eligibility_status === 'BLOCKED') addReason('SERVICE_PENDING_REVIEW');
  if (policy && (policy.manual_review_required || policy.policy_status === 'MANUAL_REVIEW_REQUIRED') && primaryCategory !== 'other') {
    if (profile?.eligibility_status !== 'ELIGIBLE' || profile.eligibility_reviewed_policy_id !== policy.id ||
      !profile.eligibility_reviewed_by || !Number.isFinite(millis(profile.eligibility_reviewed_at)) || millis(profile.eligibility_reviewed_at) > now) addReason('MANUAL_REVIEW_REQUIRED');
  }
  const requiredCredentialSnapshot = context.requirements.filter(r => r.service_category_policy_id === policy?.id).sort((a,b) => a.credential_type_id.localeCompare(b.credential_type_id));
  if (policy?.policy_status === 'CREDENTIAL_REQUIRED' && !requiredCredentialSnapshot.some(r => r.required)) addReason('CATEGORY_POLICY_MISSING');
  const credentialEvidence: BusinessTaskEligibility['credentialEvidence'] = [];
  const requirements = requiredCredentialSnapshot.map(r => {
    const matching = context.credentials.filter(c => c.credential_type_id === r.credential_type_id && c.membership_id === null && c.jurisdiction_code === jurisdictionCode);
    const credential = matching.length === 1 ? matching[0] : null;
    let problem: string | null = null;
    if (r.status !== 'ACTIVE' || (r.jurisdiction_code && r.jurisdiction_code !== jurisdictionCode)) problem = 'CATEGORY_POLICY_MISSING';
    else if (!credential) problem = 'REQUIRED_CREDENTIAL_MISSING';
    else if (credential.status === 'REVOKED') problem = 'CREDENTIAL_REVOKED';
    else if (credential.status === 'REJECTED') problem = 'CREDENTIAL_REJECTED';
    else if (credential.status === 'EXPIRED' || (credential.expires_at !== null && (!Number.isFinite(millis(credential.expires_at)) || millis(credential.expires_at) <= now))) problem = 'CREDENTIAL_EXPIRED';
    else if (credential.status !== 'ACTIVE' || !credential.current_version_id || !credential.version_snapshot ||
      !credential.verified_by || !Number.isFinite(millis(credential.verified_at)) || millis(credential.verified_at) > now ||
      (credential.issued_at !== null && (!Number.isFinite(millis(credential.issued_at)) || millis(credential.issued_at) > now)) ||
      (r.requires_number && !credential.credential_number?.trim()) || (r.requires_evidence && Number(credential.evidence_count) < 1)) problem = 'CREDENTIAL_PENDING_VERIFICATION';
    if (problem && r.required) addReason(problem,r.code);
    if (!problem && credential) credentialEvidence.push({credentialId:credential.id,credentialVersionId:credential.current_version_id!,
      credentialTypeId:r.credential_type_id,credentialTypeCode:r.code,status:credential.status,expiresAt:iso(credential.expires_at),
      verifiedAt:iso(credential.verified_at),verifiedBy:credential.verified_by,jurisdictionCode:credential.jurisdiction_code,credentialEvidence:credential.version_snapshot!});
    return { credentialTypeId:r.credential_type_id,credentialTypeCode:r.code,displayName:r.display_name,required:r.required,
      requiresNumber:r.requires_number,requiresEvidence:r.requires_evidence,supportsExpiration:r.supports_expiration,
      satisfied:problem === null,credentialId:credential?.id ?? null,credentialStatus:problem === 'CREDENTIAL_EXPIRED' ? 'EXPIRED' : credential?.status ?? null };
  });
  const eligible = reasons.length === 0;
  return {
    category:primaryCategory,primaryCategory,displayName:category?.display_name ?? (isServiceCategoryCode(primaryCategory) ? SERVICE_CATEGORY_LABELS[primaryCategory] : primaryCategory),
    selected:profile?.selected_by_business === true,serviceProfileId:profile?.id ?? null,serviceProfile:profile,jurisdictionCode,
    eligible,eligibilityStatus:eligible ? 'ELIGIBLE' : profile?.eligibility_status === 'BLOCKED' || policy?.policy_status === 'DISABLED' ? 'BLOCKED' : profile?.selected_by_business ? 'PENDING_REVIEW' : 'DECLARED',
    policy:policy ? {id:policy.id,status:policy.policy_status,jurisdictionCode:policy.jurisdiction_code,version:policy.policy_version,manualReviewRequired:policy.manual_review_required} : null,
    policyHash:createHash('sha256').update(JSON.stringify({policy,requirements:requiredCredentialSnapshot})).digest('hex'),
    reasons,requirements,credentialEvidence,requiredCredentialSnapshot,evaluatedAt:context.evaluatedAt.toISOString(),
  };
}

async function readEligibilityContext(query: QueryFn, organizationId: string, jurisdictionCode: string | null): Promise<EligibilityContext> {
  // Quote callers hold org + draft locks. Writers serialize on the org; policy
  // writers serialize on category rows. No current mutable state escapes a quote transaction.
  const categories = await query<CategoryRow>('SELECT id,code,display_name,status FROM service_categories ORDER BY code FOR SHARE');
  const profiles = await query<ProfileRow>(`SELECT id,service_code,service_category_id,selected_by_business,eligibility_status,
    eligibility_reviewed_policy_id,eligibility_reviewed_at,eligibility_reviewed_by FROM business_service_profiles WHERE organization_id=$1`,[organizationId]);
  const policies = await query<PolicyRow>(`SELECT id,service_category_id,jurisdiction_code,policy_status,policy_version,effective_from,effective_to,manual_review_required
    FROM service_category_policies WHERE jurisdiction_code=$1 ORDER BY service_category_id,policy_version`,[jurisdictionCode]);
  const requirements = await query<RequirementRow>(`SELECT r.id,r.service_category_policy_id,r.credential_type_id,r.required,
    t.code,t.display_name,t.status,t.jurisdiction_code,t.requires_number,t.requires_evidence,t.supports_expiration
    FROM service_credential_requirements r JOIN credential_types t ON t.id=r.credential_type_id
    JOIN service_category_policies p ON p.id=r.service_category_policy_id WHERE p.jurisdiction_code=$1 ORDER BY r.credential_type_id`,[jurisdictionCode]);
  const credentials = await query<EligibilityCredentialRow>(`SELECT c.id,c.credential_type_id,c.membership_id,c.status,c.current_version_id,c.expires_at,c.verified_at,c.verified_by,
    c.issued_at,c.jurisdiction_code,c.credential_number,v.snapshot AS version_snapshot,
    (SELECT count(*)::int FROM business_credential_evidence e JOIN media_upload_receipts r ON r.id=e.upload_receipt_id
      WHERE e.version_id=c.current_version_id AND e.credential_id=c.id AND e.organization_id=c.organization_id
        AND r.organization_id=c.organization_id AND r.purpose='BUSINESS_CREDENTIAL' AND r.consumed_kind='BUSINESS_CREDENTIAL' AND r.status='CONSUMED' AND r.consumed_id=e.id AND r.canonical_url IS NULL AND r.canonical_key IS NOT NULL) AS evidence_count
    FROM business_credentials c LEFT JOIN business_credential_versions v ON v.id=c.current_version_id AND v.credential_id=c.id AND v.organization_id=c.organization_id
    WHERE c.organization_id=$1 AND c.membership_id IS NULL ORDER BY c.id`,[organizationId]);
  return {categories:categories.rows,profiles:profiles.rows,policies:policies.rows,requirements:requirements.rows,credentials:credentials.rows,evaluatedAt:new Date()};
}
export async function listBusinessServiceEligibility(query: QueryFn, organizationId: string, jurisdictionCode: string | null): Promise<BusinessServiceEligibilitySummary[]> {
  const context = await readEligibilityContext(query,organizationId,jurisdictionCode);
  return SERVICE_CATEGORY_CODES.map(category => {
    const {primaryCategory: _primaryCategory,jurisdictionCode: _jurisdictionCode,policyHash: _policyHash,serviceProfile: _serviceProfile,
      credentialEvidence: _credentialEvidence,requiredCredentialSnapshot: _requiredCredentialSnapshot,...summary} = evaluateServiceEligibility(context,category,jurisdictionCode);
    return summary;
  });
}
export async function evaluateBusinessTaskEligibility(query: QueryFn, input: {organizationId: string; taskDraftId: string; action: 'SUBMIT_QUOTE'}): Promise<BusinessTaskEligibility> {
  await query('SELECT id FROM business_organizations WHERE id=$1 FOR SHARE',[input.organizationId]);
  const draft = (await query<{category:string;region_code:string | null}>('SELECT category,region_code FROM task_drafts WHERE id=$1 FOR UPDATE',[input.taskDraftId])).rows[0];
  const jurisdictionCode = draft?.region_code ?? null;
  return evaluateServiceEligibility(await readEligibilityContext(query,input.organizationId,jurisdictionCode),draft?.category ?? '',jurisdictionCode);
}
export async function persistBusinessQuoteEligibilityDecision(query: QueryFn, result: BusinessTaskEligibility, input: {
  organizationId:string; taskDraftId:string; quoteId:string; quoteVersionId:string;
}): Promise<void> {
  if (!result.eligible || !result.policy || !result.serviceProfile) throw new Error('Cannot persist an allowed decision without successful eligibility');
  // Unique quote_id rejects conflicting replays. Existing quotes return before a
  // new evaluation; historical decisions are never updated for expiry or renewal.
  await query(`INSERT INTO business_quote_eligibility_decisions
    (quote_id,quote_version_id,task_draft_id,business_organization_id,service_profile_id,action,primary_category,jurisdiction_code,
     category_policy_id,policy_version,policy_hash,decision,required_credential_snapshot,credential_snapshot,service_profile_snapshot,evaluated_at,eligibility_service_version)
    VALUES($1,$2,$3,$4,$5,'SUBMIT_QUOTE',$6,$7,$8,$9,$10,'ALLOW',$11::jsonb,$12::jsonb,$13::jsonb,$14,$15) RETURNING id`,
    [input.quoteId,input.quoteVersionId,input.taskDraftId,input.organizationId,result.serviceProfile.id,result.primaryCategory,result.jurisdictionCode,
      result.policy.id,result.policy.version,result.policyHash,JSON.stringify(result.requiredCredentialSnapshot),JSON.stringify(result.credentialEvidence),
      JSON.stringify(result.serviceProfile),result.evaluatedAt,BUSINESS_ELIGIBILITY_VERSION]);
}
