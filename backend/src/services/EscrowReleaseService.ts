import { db, getErrorMessage, isInvariantViolation } from '../db.js';
import { escrowLogger } from '../logger.js';
import type { Escrow, ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { localCertificationPayoutEnabled } from './LocalCertificationPayoutProvider.js';
import { runReleaseEffects } from './EscrowReleaseEffects.js';
import { executeReleaseTransaction } from './EscrowReleaseTransaction.js';
import type { ReleaseEscrowParams } from './EscrowServiceShared.js';

function invalidInput(params:ReleaseEscrowParams):ServiceResult<Escrow>|null {
  if (params.adminOverride && !params.reason?.trim()) {
    return { success:false,error:{
      code:ErrorCodes.INVALID_INPUT,message:'Admin escrow release requires an attributable reason',
    } };
  }
  if (!params.adminOverride && Boolean(params.stripeTransferId)===Boolean(params.localTestTransferId)) {
    return { success:false,error:{
      code:ErrorCodes.INVALID_STATE,
      message:'Exactly one verified payout-provider transfer is required to release escrow',
    } };
  }
  if (params.localTestTransferId && !localCertificationPayoutEnabled()) {
    return { success:false,error:{ code:ErrorCodes.INVALID_STATE,message:'Local certification payouts are disabled' } };
  }
  return null;
}

function releaseFailure(error:unknown,escrowId:string):ServiceResult<Escrow> {
  if (isInvariantViolation(error) && (error as {code:string}).code==='HX201') {
    return { success:false,error:{
      code:ErrorCodes.INV_2_VIOLATION,message:getErrorMessage('HX201'),details:{escrowId},
    } };
  }
  escrowLogger.error({ err:error instanceof Error ? error.message : String(error) },'EscrowService DB error');
  return { success:false,error:{ code:'DB_ERROR',message:'A database error occurred. Please try again.' } };
}

export async function releaseEscrow(params:ReleaseEscrowParams):Promise<ServiceResult<Escrow>> {
  const invalid=invalidInput(params);
  if (invalid) return invalid;
  try {
    const result=await db.transaction((query)=>executeReleaseTransaction(query,params));
    if (!result.success) return result;
    await runReleaseEffects({
      escrowId:params.escrowId,post:result.post,
      adminOverride:params.adminOverride ?? false,reason:params.reason,
    });
    return { success:true,data:result.data };
  } catch(error) {
    return releaseFailure(error,params.escrowId);
  }
}
