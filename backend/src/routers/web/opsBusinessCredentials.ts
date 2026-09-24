import { z } from 'zod';
import { operationsAdminProcedure } from '../../trpc.js';
import { db } from '../../db.js';
import { readBusinessCredentials, reviewBusinessCredential, getCredentialEvidence } from '../../services/BusinessCredentialService.js';
import { requireOperationsAuthority } from '../../services/BusinessManagementAuthority.js';
import { listBusinessServiceEligibility } from '../../services/BusinessTaskEligibilityService.js';

const uuid=z.string().uuid();
const organizationInput=z.object({organizationId:uuid}).strict();

/** Spread into the existing webOps router; no parallel admin capability. */
export const opsBusinessCredentialProcedures={
  getBusinessCredentials:operationsAdminProcedure.input(organizationInput)
    .query(({ctx,input})=>readBusinessCredentials(ctx.user.id,input.organizationId,true)),
  reviewBusinessCredential:operationsAdminProcedure.input(z.object({
    organizationId:uuid,credentialId:uuid,versionId:uuid,decision:z.enum(['APPROVE','REJECT','REVOKE']),reason:z.string().trim().min(3).max(2000),
  }).strict()).mutation(({ctx,input})=>reviewBusinessCredential({...input,actorId:ctx.user.id})),
  getBusinessCredentialEvidence:operationsAdminProcedure.input(z.object({organizationId:uuid,credentialId:uuid,evidenceId:uuid}).strict())
    .query(({ctx,input})=>getCredentialEvidence({...input,actorId:ctx.user.id},true)),
  getBusinessServiceEligibility:operationsAdminProcedure.input(organizationInput).query(({ctx,input})=>db.transaction(async(query)=>{
    await requireOperationsAuthority(query,ctx.user.id);
    const address=await query<{region_code:string}>("SELECT region_code FROM business_locations WHERE organization_id=$1 AND purpose='BUSINESS_ADDRESS' AND status='ACTIVE'",[input.organizationId]);
    const jurisdictionCode=address.rows[0]?.region_code??null;
    return {organizationId:input.organizationId,jurisdictionCode,services:await listBusinessServiceEligibility(query,input.organizationId,jurisdictionCode)};
  })),
};
