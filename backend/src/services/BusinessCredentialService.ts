import { createHash, randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../db.js';
import { backblazeB2 } from '../storage/backblaze-b2.js';
import { requireBusinessManagementAuthority, requireOperationsAuthority, recordBusinessManagementAudit } from './BusinessManagementAuthority.js';
import { isServiceJurisdiction } from '../contracts/serviceJurisdiction.js';

export type BusinessCredentialStatus = 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'REJECTED' | 'REVOKED';
interface CredentialTypeRow { id: string; code: string; display_name: string; requires_number: boolean; requires_evidence: boolean; supports_expiration: boolean; jurisdiction_code: string | null }
interface CredentialRow {
  id: string; organization_id: string; membership_id: string | null; credential_type_id: string | null;
  credential_type: string; credential_number: string | null; issuing_authority: string | null;
  jurisdiction_code: string | null; issued_at: Date | string | null; expires_at: Date | string | null;
  expiration_date?: string | null;
  status: BusinessCredentialStatus; effective_status: BusinessCredentialStatus;
  current_version_id: string | null; rejection_reason: string | null; verification_notes: string | null;
  submitted_at: Date | string | null; verified_at: Date | string | null; verified_by: string | null;
  evidence: Array<{ id: string; contentType: string; fileSizeBytes: number }>;
  history: Array<{ id: string; status: BusinessCredentialStatus; actorId: string; reason: string | null; createdAt: string; versionId: string | null }>;
}
function dateValue(value: Date | string | null | undefined): string | null { return value instanceof Date ? value.toISOString() : value ?? null; }

export async function readBusinessCredentials(actorId: string, organizationId: string, ops = false) {
  return db.transaction(async (query) => {
    if (ops) await requireOperationsAuthority(query, actorId);
    else await requireBusinessManagementAuthority(query, actorId, organizationId, 'READ_WORKSPACE');
    const types = await query<CredentialTypeRow>(`SELECT id,code,display_name,requires_number,requires_evidence,supports_expiration,jurisdiction_code FROM credential_types WHERE status='ACTIVE' ORDER BY display_name,id`);
    const rows = await query<CredentialRow>(`SELECT c.*,
      (SELECT v.snapshot->>'expiresAt' FROM business_credential_versions v WHERE v.id=c.current_version_id) AS expiration_date,
      CASE WHEN c.status='ACTIVE' AND c.expires_at<=NOW() THEN 'EXPIRED' ELSE c.status END AS effective_status,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'contentType',r.canonical_content_type,'fileSizeBytes',r.canonical_size_bytes) ORDER BY e.created_at,e.id)
        FROM business_credential_evidence e JOIN media_upload_receipts r ON r.id=e.upload_receipt_id
        WHERE e.version_id=c.current_version_id), '[]'::jsonb) AS evidence,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',h.id,'status',h.status,'actorId',h.actor_id,'reason',CASE WHEN $2 THEN h.reason WHEN h.status='REJECTED' THEN h.reason ELSE NULL END,'createdAt',h.created_at,'versionId',h.version_id) ORDER BY h.created_at,h.id)
        FROM business_credential_events h WHERE h.credential_id=c.id), '[]'::jsonb) AS history
      FROM business_credentials c WHERE c.organization_id=$1 ORDER BY c.created_at,c.id`, [organizationId,ops]);
    const reviewSignals=ops ? (await query<{credentialId:string;quoteId:string;taskId:string|null;reason:string;createdAt:Date|string}>(
      `SELECT credential_id AS "credentialId",quote_id AS "quoteId",task_id AS "taskId",reason,created_at AS "createdAt"
       FROM business_credential_review_signals WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,[organizationId])).rows : [];
    return {
      reviewSignals:reviewSignals.map((signal)=>({...signal,createdAt:dateValue(signal.createdAt)!})),
      credentialTypes: types.rows.map((t) => ({ id:t.id,code:t.code,displayName:t.display_name,requiresNumber:t.requires_number,requiresEvidence:t.requires_evidence,supportsExpiration:t.supports_expiration,jurisdictionCode:t.jurisdiction_code })),
      credentials: rows.rows.map((c) => ({ id:c.id,membershipId:c.membership_id,credentialTypeId:c.credential_type_id,credentialType:c.credential_type,
        credentialNumber:c.credential_number,issuingAuthority:c.issuing_authority,jurisdictionCode:c.jurisdiction_code,issuedAt:dateValue(c.issued_at),expiresAt:c.expiration_date ?? dateValue(c.expires_at),
        status:c.status,effectiveStatus:c.effective_status,rejectionReason:c.rejection_reason,verificationNotes:ops ? c.verification_notes : null,
        submittedAt:dateValue(c.submitted_at),verifiedAt:dateValue(c.verified_at),verifiedBy:c.verified_by,currentVersionId:c.current_version_id,evidence:c.evidence,history:c.history })),
    };
  });
}

export interface SubmitOrganizationCredentialInput {
  actorId: string; organizationId: string; membershipId?: string | null; credentialTypeId: string;
  credentialNumber?: string | null; issuingAuthority?: string | null; jurisdictionCode: string;
  issuedAt?: string | null; expiresAt?: string | null; uploadReceiptIds: string[]; idempotencyKey: string;
}

export async function submitOrganizationCredential(input: SubmitOrganizationCredentialInput): Promise<{ id: string; status: 'PENDING'; versionId: string }> {
  if (!isServiceJurisdiction(input.jurisdictionCode)) throw new TRPCError({code:'BAD_REQUEST',message:'Select a valid credential jurisdiction.'});
  return db.transaction(async (query) => {
    // Lock org before membership/credential rows: same ordering as quote gate and Ops review.
    await query('SELECT id FROM business_organizations WHERE id=$1 FOR UPDATE',[input.organizationId]);
    await requireBusinessManagementAuthority(query,input.actorId,input.organizationId,'MANAGE_SERVICES');
    const receiptIds = [...new Set(input.uploadReceiptIds)].sort();
    if (receiptIds.length !== input.uploadReceiptIds.length) throw new TRPCError({ code:'BAD_REQUEST',message:'Each evidence receipt may be used only once.' });
    const payload = { membershipId:input.membershipId ?? null,credentialTypeId:input.credentialTypeId,credentialNumber:input.credentialNumber?.trim() || null,
      issuingAuthority:input.issuingAuthority?.trim() || null,jurisdictionCode:input.jurisdictionCode,issuedAt:input.issuedAt ?? null,expiresAt:input.expiresAt ?? null,uploadReceiptIds:receiptIds };
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const prior = await query<{ id:string;credential_id:string;submission_hash:string }>(`SELECT id,credential_id,submission_hash FROM business_credential_versions WHERE organization_id=$1 AND submitted_by=$2 AND submission_idempotency_key=$3`,[input.organizationId,input.actorId,input.idempotencyKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].submission_hash!==hash) throw new TRPCError({ code:'CONFLICT',message:'This submission key was already used for different credential details.' });
      return {id:prior.rows[0].credential_id,status:'PENDING',versionId:prior.rows[0].id};
    }
    const registry = await query<CredentialTypeRow>(`SELECT id,code,requires_number,requires_evidence,supports_expiration,jurisdiction_code FROM credential_types WHERE id=$1 AND status='ACTIVE' FOR SHARE`,[input.credentialTypeId]);
    const type = registry.rows[0];
    if (!type) throw new TRPCError({code:'BAD_REQUEST',message:'Select an active credential type.'});
    if ((type.requires_number && !payload.credentialNumber) || (type.requires_evidence && !receiptIds.length)) throw new TRPCError({code:'BAD_REQUEST',message:'This credential requires its number and supporting evidence.'});
    if (type.jurisdiction_code && type.jurisdiction_code!==input.jurisdictionCode) throw new TRPCError({code:'BAD_REQUEST',message:'Credential jurisdiction does not match its registered type.'});
    if (!type.supports_expiration && input.expiresAt) throw new TRPCError({code:'BAD_REQUEST',message:'This credential type does not use an expiration date.'});
    if (input.issuedAt && input.expiresAt && input.expiresAt<input.issuedAt) throw new TRPCError({code:'BAD_REQUEST',message:'Expiration must not precede the issue date.'});
    if (input.membershipId) {
      const member = await query(`SELECT id FROM business_memberships WHERE id=$1 AND organization_id=$2 AND status='ACTIVE' FOR SHARE`,[input.membershipId,input.organizationId]);
      if (!member.rows[0]) throw new TRPCError({code:'BAD_REQUEST',message:'Credential member must be active in this business.'});
    }
    const versionId=randomUUID();
    // The old row is updated only after immutable history has captured every prior submission/review.
    const saved=await query<{id:string}>(`INSERT INTO business_credentials(organization_id,membership_id,credential_type,credential_type_id,status,evidence_hash)
      VALUES($1,$2,$3,$4,'PENDING',$5) ON CONFLICT(organization_id,membership_id,credential_type)
      DO UPDATE SET updated_at=business_credentials.updated_at RETURNING id`,[input.organizationId,payload.membershipId,type.code,type.id,hash]);
    const credentialId=saved.rows[0].id;
    const evidence=[];
    for (const receiptId of receiptIds) {
      const evidenceId=randomUUID();
      const consumed=await query<{id:string;canonical_checksum_sha256:string;canonical_content_type:string;canonical_size_bytes:number}>(`UPDATE media_upload_receipts SET status='CONSUMED',consumed_kind='BUSINESS_CREDENTIAL',consumed_id=$4,consumed_at=NOW()
        WHERE id=$1 AND organization_id=$2 AND uploader_id=$3 AND purpose='BUSINESS_CREDENTIAL'
          AND task_id IS NULL AND task_draft_id IS NULL AND status='FINALIZED' AND expires_at>NOW()
          AND canonical_url IS NULL AND canonical_key IS NOT NULL
        RETURNING id,canonical_checksum_sha256,canonical_content_type,canonical_size_bytes`,[receiptId,input.organizationId,input.actorId,evidenceId]);
      if (!consumed.rows[0]) throw new TRPCError({code:'BAD_REQUEST',message:'Credential evidence must be a fresh finalized upload for this business and submitter.'});
      evidence.push({id:evidenceId,uploadReceiptId:receiptId,checksumSha256:consumed.rows[0].canonical_checksum_sha256,contentType:consumed.rows[0].canonical_content_type,fileSizeBytes:Number(consumed.rows[0].canonical_size_bytes)});
    }
    await query(`INSERT INTO business_credential_versions(id,credential_id,organization_id,submitted_by,submission_idempotency_key,submission_hash,snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[versionId,credentialId,input.organizationId,input.actorId,input.idempotencyKey,hash,JSON.stringify({...payload,credentialTypeCode:type.code,evidence})]);
    for(const item of evidence) await query(`INSERT INTO business_credential_evidence(id,credential_id,version_id,organization_id,upload_receipt_id) VALUES($1,$2,$3,$4,$5)`,[item.id,credentialId,versionId,input.organizationId,item.uploadReceiptId]);
    await query(`UPDATE business_credentials SET credential_type_id=$2,credential_number=$3,issuing_authority=$4,jurisdiction_code=$5,issued_at=$6::date,
      expires_at=CASE WHEN $7::date IS NULL THEN NULL ELSE ($7::date+1)::timestamp AT TIME ZONE 'UTC' END,
      status='PENDING',evidence_hash=$8,current_version_id=$9,submitted_at=NOW(),verified_by=NULL,verified_at=NULL,
      verification_notes=NULL,rejection_reason=NULL,revoked_by=NULL,revoked_at=NULL,updated_at=NOW() WHERE id=$1`,[credentialId,type.id,payload.credentialNumber,payload.issuingAuthority,input.jurisdictionCode,input.issuedAt??null,input.expiresAt??null,hash,versionId]);
    await credentialEvent(query,{actorId:input.actorId,organizationId:input.organizationId,credentialId,versionId,status:'PENDING',reason:null});
    await recordBusinessManagementAudit(query,{actorId:input.actorId,organizationId:input.organizationId,action:'credential_submitted',objectType:'business_credential',objectId:credentialId,after:{versionId,credentialTypeId:type.id,membershipId:payload.membershipId,status:'PENDING'}});
    return {id:credentialId,status:'PENDING',versionId};
  });
}

async function credentialEvent(query:QueryFn,input:{actorId:string;organizationId:string;credentialId:string;versionId:string|null;status:BusinessCredentialStatus;reason:string|null}) {
  await query(`INSERT INTO business_credential_events(credential_id,version_id,organization_id,actor_id,status,reason,snapshot)
    SELECT id,$2,organization_id,$3,$4,$5,to_jsonb(c) FROM business_credentials c WHERE id=$1 AND organization_id=$6`,[input.credentialId,input.versionId,input.actorId,input.status,input.reason,input.organizationId]);
}

export async function reviewBusinessCredential(input:{actorId:string;organizationId:string;credentialId:string;versionId:string;decision:'APPROVE'|'REJECT'|'REVOKE';reason:string}) {
  return db.transaction(async(query)=>{
    await requireOperationsAuthority(query,input.actorId);
    const org=await query(`SELECT id FROM business_organizations WHERE id=$1 FOR UPDATE`,[input.organizationId]);
    if(!org.rows[0]) throw new TRPCError({code:'NOT_FOUND',message:'Business not found.'});
    const loaded=await query<CredentialRow>(`SELECT * FROM business_credentials WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[input.credentialId,input.organizationId]);
    const credential=loaded.rows[0];
    if(!credential) throw new TRPCError({code:'NOT_FOUND',message:'Credential not found.'});
    if(credential.current_version_id!==input.versionId) throw new TRPCError({code:'CONFLICT',message:'This credential has been replaced. Refresh before reviewing it.'});
    if(input.decision==='APPROVE' && (credential.status!=='PENDING' || (credential.expires_at && new Date(credential.expires_at).getTime()<=Date.now()))) throw new TRPCError({code:'PRECONDITION_FAILED',message:'Only a current, unexpired pending submission may be approved.'});
    if(input.decision==='REJECT' && credential.status!=='PENDING') throw new TRPCError({code:'PRECONDITION_FAILED',message:'Only a pending submission may be rejected.'});
    if(input.decision==='REVOKE' && !['ACTIVE','EXPIRED'].includes(credential.status)) throw new TRPCError({code:'PRECONDITION_FAILED',message:'Only a previously verified credential may be revoked.'});
    const status:BusinessCredentialStatus=input.decision==='APPROVE'?'ACTIVE':input.decision==='REJECT'?'REJECTED':'REVOKED';
    await query(`UPDATE business_credentials SET status=$2,verification_notes=$3,
      verified_by=CASE WHEN $2='ACTIVE' THEN $4 ELSE verified_by END,verified_at=CASE WHEN $2='ACTIVE' THEN NOW() ELSE verified_at END,
      rejection_reason=CASE WHEN $2='REJECTED' THEN $3 ELSE rejection_reason END,
      revoked_by=CASE WHEN $2='REVOKED' THEN $4 ELSE revoked_by END,revoked_at=CASE WHEN $2='REVOKED' THEN NOW() ELSE revoked_at END,
      updated_at=NOW() WHERE id=$1`,[credential.id,status,input.reason,input.actorId]);
    await credentialEvent(query,{...input,status});
    if(status==='REVOKED') await query(`INSERT INTO business_credential_review_signals(organization_id,credential_id,quote_id,task_id,reason)
      SELECT $1::uuid,$2::uuid,q.id,COALESCE(q.task_id,CASE WHEN d.quote_id=q.id THEN d.task_id END),'CREDENTIAL_REVOKED'
      FROM business_quote_eligibility_decisions decision JOIN quotes q ON q.id=decision.quote_id JOIN task_drafts d ON d.id=q.task_draft_id
      LEFT JOIN tasks t ON t.id=COALESCE(q.task_id,CASE WHEN d.quote_id=q.id THEN d.task_id END)
      WHERE decision.business_organization_id=$1
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(decision.credential_snapshot) c WHERE c->>'credentialId'=$2::uuid::text)
        AND ((t.id IS NOT NULL AND t.state NOT IN ('COMPLETED','CANCELLED','EXPIRED'))
          OR (t.id IS NULL AND q.status IN ('pending_business_verification','submitted','quote_ready','quote_send_ready')))
      ON CONFLICT(credential_id,quote_id) DO NOTHING`,[input.organizationId,credential.id]);
    await recordBusinessManagementAudit(query,{...input,action:`credential_${input.decision.toLowerCase()}`,objectType:'business_credential',objectId:credential.id,before:{status:credential.status,versionId:input.versionId},after:{status,versionId:input.versionId,reason:input.reason},ops:true});
    return {id:credential.id,status};
  });
}

export async function getCredentialEvidence(input:{actorId:string;organizationId:string;credentialId:string;evidenceId:string},ops=false) {
  return db.transaction(async(query)=>{
    if(ops) await requireOperationsAuthority(query,input.actorId);
    else await requireBusinessManagementAuthority(query,input.actorId,input.organizationId,'MANAGE_SERVICES');
    const evidence=await query<{canonical_key:string}>(`SELECT r.canonical_key FROM business_credential_evidence e
      JOIN business_credentials c ON c.id=e.credential_id AND c.organization_id=e.organization_id
      JOIN media_upload_receipts r ON r.id=e.upload_receipt_id AND r.organization_id=e.organization_id
      WHERE e.id=$1 AND e.credential_id=$2 AND e.organization_id=$3
        AND r.status='CONSUMED' AND r.purpose='BUSINESS_CREDENTIAL' AND r.consumed_kind='BUSINESS_CREDENTIAL'
        AND r.consumed_id=e.id AND r.canonical_url IS NULL AND r.canonical_key IS NOT NULL`,[input.evidenceId,input.credentialId,input.organizationId]);
    if(!evidence.rows[0]) throw new TRPCError({code:'NOT_FOUND',message:'Credential evidence is unavailable.'});
    const downloadUrl=await backblazeB2.getSignedUrlForObject(evidence.rows[0].canonical_key,300);
    const parsed=new URL(downloadUrl);
    if(parsed.protocol!=='https:'||parsed.username||parsed.password) throw new Error('Private credential signer returned an unsafe URL.');
    const expiresAt=new Date(Date.now()+300_000).toISOString();
    await query(`INSERT INTO business_credential_media_access_log(evidence_id,organization_id,viewer_id,access_context,signed_url_expires_at) VALUES($1,$2,$3,$4,$5)`,[input.evidenceId,input.organizationId,input.actorId,ops?'OPS':'BUSINESS',expiresAt]);
    return {downloadUrl,expiresAt};
  });
}
