import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../../db.js';
import { operationsAdminProcedure } from '../../trpc.js';
import { SERVICE_CATEGORY_CODES } from '../../contracts/serviceCategories.js';
import { requireOperationsAuthority, recordBusinessManagementAudit } from '../../services/BusinessManagementAuthority.js';
import { recordOpsAudit } from '../../services/OpsAuditService.js';
import { listBusinessServiceEligibility } from '../../services/BusinessTaskEligibilityService.js';
import { activatePendingBusinessQuotesInTransaction } from '../../services/BusinessQuoteActivationService.js';

const uuid = z.string().uuid();
const category = z.enum(SERVICE_CATEGORY_CODES);
const jurisdiction = z.string().regex(/^US-[A-Z]{2}(-[A-Z0-9_-]+)?$/);
const reason = z.string().trim().min(3).max(2000);
const draftInput = z.object({taskDraftId:uuid}).strict();
const policyStatus = z.enum(['UNRESTRICTED','CREDENTIAL_REQUIRED','MANUAL_REVIEW_REQUIRED','DISABLED']);
export const categoryCorrectionInput = draftInput.extend({category,reason}).strict();
export const categoryPolicyInput = z.object({category,jurisdictionCode:jurisdiction,status:policyStatus,manualReviewRequired:z.boolean(),
  requiredCredentialTypeIds:z.array(uuid).max(30),reason,effectiveFrom:z.string().datetime()}).strict();

export async function readTaskDraftCategoryReview(query:QueryFn,taskDraftId:string) {
  const draft=(await query<{category:string;task_id:string|null;has_business_quote:boolean}>(`SELECT d.category,d.task_id,
    EXISTS(SELECT 1 FROM quotes q WHERE q.task_draft_id=d.id AND q.business_organization_id IS NOT NULL) AS has_business_quote
    FROM task_drafts d WHERE d.id=$1 FOR UPDATE OF d`,[taskDraftId])).rows[0];
  if(!draft) throw new TRPCError({code:'NOT_FOUND',message:'Task draft not found.'});
  const history=await query<{id:string;previous_category:string;new_category:string;reason:string;changed_by:string;changed_at:Date}>(
    'SELECT id,previous_category,new_category,reason,changed_by,changed_at FROM task_draft_category_corrections WHERE task_draft_id=$1 ORDER BY changed_at DESC,id DESC',[taskDraftId]);
  const canCorrect=!draft.task_id&&!draft.has_business_quote;
  return {category:draft.category,canCorrect,blockedReason:canCorrect?null:'Category is fixed after a business quote or task has been created.',
    history:history.rows.map(h=>({id:h.id,previousCategory:h.previous_category,newCategory:h.new_category,reason:h.reason,changedBy:h.changed_by,changedAt:new Date(h.changed_at).toISOString()}))};
}
export async function correctTaskDraftCategory(actorId:string,input:z.infer<typeof categoryCorrectionInput>) {
  return db.transaction(async(query)=>{
    await requireOperationsAuthority(query,actorId);
    const before=await readTaskDraftCategoryReview(query,input.taskDraftId);
    if(!before.canCorrect) throw new TRPCError({code:'PRECONDITION_FAILED',message:before.blockedReason!});
    if(before.category===input.category) throw new TRPCError({code:'BAD_REQUEST',message:'Choose a different primary category.'});
    await query('UPDATE task_drafts SET category=$2,updated_at=NOW() WHERE id=$1',[input.taskDraftId,input.category]);
    await query(`INSERT INTO task_draft_category_corrections(task_draft_id,previous_category,new_category,changed_by,reason)
      VALUES($1,$2,$3,$4,$5)`,[input.taskDraftId,before.category,input.category,actorId,input.reason]);
    await recordOpsAudit({actorUserId:actorId,action:'task_draft_category_corrected',targetType:'task_draft',targetId:input.taskDraftId,
      meta:{previousCategory:before.category,newCategory:input.category,reason:input.reason}},query,true);
    return readTaskDraftCategoryReview(query,input.taskDraftId);
  });
}
export async function setServiceCategoryPolicy(actorId:string,input:z.infer<typeof categoryPolicyInput>) {
  return db.transaction(async(query)=>{
    await requireOperationsAuthority(query,actorId);
    const selected=(await query<{id:string}>("SELECT id FROM service_categories WHERE code=$1 AND status='ACTIVE' FOR UPDATE",[input.category])).rows[0];
    if(!selected) throw new TRPCError({code:'BAD_REQUEST',message:'Select an active canonical category.'});
    if(input.category==='other'&&(input.status!=='MANUAL_REVIEW_REQUIRED'||!input.manualReviewRequired)) throw new TRPCError({code:'BAD_REQUEST',message:'Other requires manual review and task category correction.'});
    const required=[...new Set(input.requiredCredentialTypeIds)].sort();
    if(required.length!==input.requiredCredentialTypeIds.length || (input.status==='CREDENTIAL_REQUIRED'&&!required.length)) throw new TRPCError({code:'BAD_REQUEST',message:'Configure distinct required credentials for this policy.'});
    const types=await query<{id:string}>("SELECT id FROM credential_types WHERE id=ANY($1::uuid[]) AND status='ACTIVE' AND (jurisdiction_code IS NULL OR jurisdiction_code=$2) FOR SHARE",[required,input.jurisdictionCode]);
    if(types.rows.length!==required.length) throw new TRPCError({code:'BAD_REQUEST',message:'Every credential type must be active and match the policy jurisdiction.'});
    const previous=(await query<{id:string;policy_version:number;effective_from:Date;effective_to:Date|null}>(`SELECT id,policy_version,effective_from,effective_to FROM service_category_policies
      WHERE service_category_id=$1 AND jurisdiction_code=$2 ORDER BY policy_version DESC LIMIT 1 FOR UPDATE`,[selected.id,input.jurisdictionCode])).rows[0];
    const requested=new Date(input.effectiveFrom);
    // Browser immediate-publish timestamps can be slightly earlier than arrival;
    // publishing never retroactively changes policy for already-committed work.
    const effectiveFrom=new Date(Math.max(Date.now(),requested.getTime()));
    if(previous && (previous.effective_to || new Date(previous.effective_from)>=effectiveFrom)) throw new TRPCError({code:'CONFLICT',message:'A later policy is already configured. Refresh before publishing another version.'});
    if(previous) await query('UPDATE service_category_policies SET effective_to=$2 WHERE id=$1',[previous.id,effectiveFrom]);
    const saved=await query<{id:string}>(`INSERT INTO service_category_policies(service_category_id,jurisdiction_code,policy_status,policy_version,effective_from,manual_review_required,notes,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[selected.id,input.jurisdictionCode,input.status,(previous?.policy_version??0)+1,effectiveFrom,input.manualReviewRequired,input.reason,actorId]);
    const id=saved.rows[0]?.id;
    if(!id) throw new Error('Category policy persistence failed');
    for(const credentialTypeId of required) await query('INSERT INTO service_credential_requirements(service_category_policy_id,credential_type_id,required) VALUES($1,$2,TRUE)',[id,credentialTypeId]);
    await recordOpsAudit({actorUserId:actorId,action:'service_category_policy_published',targetType:'service_category_policy',targetId:id,
      meta:{category:input.category,jurisdictionCode:input.jurisdictionCode,version:(previous?.policy_version??0)+1,status:input.status,requiredCredentialTypeIds:required,reason:input.reason}},query,true);
    return {id};
  });
}
const reviewServiceInput=z.object({organizationId:uuid,expectedPolicyId:uuid,category,jurisdictionCode:jurisdiction,decision:z.enum(['APPROVE','BLOCK']),reason}).strict();
export async function reviewBusinessService(actorId:string,input:z.infer<typeof reviewServiceInput>) {
  return db.transaction(async(query)=>{
    await requireOperationsAuthority(query,actorId);
    const org=await query("SELECT id FROM business_organizations WHERE id=$1 AND status='ACTIVE' FOR UPDATE",[input.organizationId]);
    if(!org.rows[0]) throw new TRPCError({code:'NOT_FOUND',message:'Active business not found.'});
    const summary=(await listBusinessServiceEligibility(query,input.organizationId,input.jurisdictionCode)).find(s=>s.category===input.category);
    if(!summary?.selected||!summary.serviceProfileId) throw new TRPCError({code:'PRECONDITION_FAILED',message:'The business must first select this service.'});
    if(summary.policy?.id!==input.expectedPolicyId) throw new TRPCError({code:'CONFLICT',message:'The policy changed since this review. Refresh before deciding.'});
    if(!summary.policy || (input.decision==='APPROVE'&&(input.category==='other'||summary.policy.status==='DISABLED'))) throw new TRPCError({code:'PRECONDITION_FAILED',message:'This category policy cannot be approved. Resolve the policy or task category first.'});
    await query(`UPDATE business_service_profiles SET eligibility_status=$2,eligibility_reason=$3,eligibility_reviewed_by=$4,
      eligibility_reviewed_at=NOW(),eligibility_reviewed_policy_id=$5,updated_at=NOW() WHERE id=$1`,
      [summary.serviceProfileId,input.decision==='APPROVE'?'ELIGIBLE':'BLOCKED',input.reason,actorId,summary.policy.id]);
    await recordBusinessManagementAudit(query,{actorId,organizationId:input.organizationId,action:'business_service_reviewed',objectType:'business_service_profile',
      objectId:summary.serviceProfileId,after:{decision:input.decision,category:input.category,policyId:summary.policy.id,reason:input.reason},ops:true});
    // Approval satisfies only manual review; current credential requirements and
    // expiry remain authoritative every time the shared gate is evaluated.
    return {success:true as const};
  });
}

// A legacy pending quote can outlive organization verification while its service
// still needs review. Ops can retry the existing activation path after resolving
// readiness, without changing verification or bypassing quote validity checks.
export async function recheckBusinessQuoteEligibility(actorId: string, organizationId: string) {
  return db.transaction(async (query) => {
    await requireOperationsAuthority(query, actorId);
    const organization = await query(
      `SELECT id FROM business_organizations WHERE id=$1 AND status='ACTIVE'
        AND provider_enabled AND verification_status='VERIFIED' FOR UPDATE`, [organizationId]);
    if (!organization.rows[0]) throw new TRPCError({
      code: 'PRECONDITION_FAILED', message: 'An active, verified provider organization is required before publishing pending quotes.',
    });
    const activated = await activatePendingBusinessQuotesInTransaction(query, organizationId);
    await recordOpsAudit({actorUserId: actorId, action: 'business_pending_quotes_rechecked',
      targetType: 'business_organization', targetId: organizationId, meta: {activated}}, query, true);
    return {activated};
  });
}
export const opsBusinessEligibilityProcedures={
  recheckBusinessQuoteEligibility: operationsAdminProcedure.input(z.object({organizationId:uuid}).strict())
    .mutation(({ctx,input})=>recheckBusinessQuoteEligibility(ctx.user.id,input.organizationId)),
  getTaskDraftCategoryReview:operationsAdminProcedure.input(draftInput).query(({ctx,input})=>db.transaction(async(query)=>{
    await requireOperationsAuthority(query,ctx.user.id); return readTaskDraftCategoryReview(query,input.taskDraftId);
  })),
  correctTaskDraftCategory:operationsAdminProcedure.input(categoryCorrectionInput).mutation(({ctx,input})=>correctTaskDraftCategory(ctx.user.id,input)),
  reviewBusinessService:operationsAdminProcedure.input(reviewServiceInput).mutation(({ctx,input})=>reviewBusinessService(ctx.user.id,input)),
  setServiceCategoryPolicy:operationsAdminProcedure.input(categoryPolicyInput).mutation(({ctx,input})=>setServiceCategoryPolicy(ctx.user.id,input)),
  createCredentialType:operationsAdminProcedure.input(z.object({code:z.string().regex(/^[A-Z0-9_]{2,80}$/),displayName:z.string().trim().min(1).max(200),
    credentialKind:z.string().trim().min(1).max(80),issuingAuthority:z.string().trim().min(1).max(200).optional(),jurisdictionCode:jurisdiction.optional(),
    supportsExpiration:z.boolean(),requiresNumber:z.boolean(),requiresEvidence:z.boolean()}).strict()).mutation(({ctx,input})=>db.transaction(async(query)=>{
    await requireOperationsAuthority(query,ctx.user.id);
    const saved=await query<{id:string}>(`INSERT INTO credential_types(code,display_name,credential_kind,issuing_authority,jurisdiction_code,supports_expiration,requires_number,requires_evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(code) DO NOTHING RETURNING id`,[input.code,input.displayName,input.credentialKind,input.issuingAuthority??null,input.jurisdictionCode??null,input.supportsExpiration,input.requiresNumber,input.requiresEvidence]);
    if(!saved.rows[0]) throw new TRPCError({code:'CONFLICT',message:'That credential type code already exists.'});
    await recordOpsAudit({actorUserId:ctx.user.id,action:'credential_type_created',targetType:'credential_type',targetId:saved.rows[0].id,meta:input},query,true);
    return {...input,id:saved.rows[0].id,jurisdictionCode:input.jurisdictionCode??null};
  })),
  getServiceCategoryConfiguration:operationsAdminProcedure.input(z.object({}).strict()).query(({ctx})=>db.transaction(async(query)=>{
    await requireOperationsAuthority(query,ctx.user.id);
    const categories=await query<{code:string;display_name:string}>("SELECT code,display_name FROM service_categories WHERE status='ACTIVE' ORDER BY code");
    const credentialTypes=await query<{id:string;code:string;display_name:string;requires_number:boolean;requires_evidence:boolean;supports_expiration:boolean;jurisdiction_code:string|null}>("SELECT * FROM credential_types WHERE status='ACTIVE' ORDER BY code");
    const policies=await query<{id:string;category:string;jurisdiction_code:string;policy_status:string;policy_version:number;effective_from:Date;effective_to:Date|null;manual_review_required:boolean;notes:string|null;required_credential_type_ids:string[]}>(`SELECT p.*,c.code AS category,
      COALESCE((SELECT array_agg(r.credential_type_id ORDER BY r.credential_type_id) FROM service_credential_requirements r WHERE r.service_category_policy_id=p.id AND r.required),'{}'::uuid[]) AS required_credential_type_ids
      FROM service_category_policies p JOIN service_categories c ON c.id=p.service_category_id ORDER BY c.code,p.jurisdiction_code,p.policy_version DESC`);
    return {categories:categories.rows.map(c=>({code:c.code,displayName:c.display_name})),credentialTypes:credentialTypes.rows.map(t=>({id:t.id,code:t.code,displayName:t.display_name,requiresNumber:t.requires_number,requiresEvidence:t.requires_evidence,supportsExpiration:t.supports_expiration,jurisdictionCode:t.jurisdiction_code})),
      policies:policies.rows.map(p=>({id:p.id,category:p.category,jurisdictionCode:p.jurisdiction_code,status:p.policy_status,version:p.policy_version,effectiveFrom:new Date(p.effective_from).toISOString(),effectiveTo:p.effective_to?new Date(p.effective_to).toISOString():null,manualReviewRequired:p.manual_review_required,notes:p.notes,requiredCredentialTypeIds:p.required_credential_type_ids}))};
  })),
};
