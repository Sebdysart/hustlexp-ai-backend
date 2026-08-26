import { escrowLogger } from '../logger.js';
import { EarnedVerificationUnlockService } from './EarnedVerificationUnlockService.js';
import { RevenueService } from './RevenueService.js';
import { SelfInsurancePoolService } from './SelfInsurancePoolService.js';
import { logEscrowEvent } from './EscrowServiceShared.js';
import type { ReleasePost } from './EscrowReleaseTypes.js';
import { XPService } from './XPService.js';
import { XPTaxService } from './XPTaxService.js';

async function recordReleaseEvent(
  escrowId: string,
  post: ReleasePost,
  adminOverride: boolean,
  reason?: string,
): Promise<void> {
  await logEscrowEvent(
    escrowId,post.escrowStateBefore,'RELEASED',undefined,adminOverride ? 'admin' : 'system',
    {
      ...(adminOverride && reason ? { adminOverride:true,reason } : {}),
      ...(post.adminManualPayoutRequired ? { admin_manual_payout_required:true } : {}),
      payout_provider:post.payoutProvider,
      payout_recipient_user_id:post.payoutRecipientUserId,
      provider_transfer_id:post.providerTransferId,
      provider_transfer_status:post.payoutProvider==='LOCAL_CERTIFICATION_TEST'
        ? 'paid' : post.payoutProvider==='STRIPE' ? 'submitted' : 'manual_reconciliation',
    },
    `escrow.released:${escrowId}`,
  );
}

function releaseOwnsRevenue(post: ReleasePost, adminOverride: boolean): boolean {
  return (adminOverride && post.adminManualPayoutRequired)
    || post.payoutProvider === 'LOCAL_CERTIFICATION_TEST';
}

async function recordPlatformFee(
  escrowId: string,
  post: ReleasePost,
  adminOverride: boolean,
): Promise<void> {
  if (!releaseOwnsRevenue(post,adminOverride)) return;
  if (post.platformFeeCents <= 0) {
    escrowLogger.warn({ escrowId,platformFeeCents:post.platformFeeCents,grossPayoutCents:post.grossPayoutCents },
      'F-06: Skipping platform_fee ledger entry for admin_override_release — fee rounds to 0 cents');
    return;
  }
  try {
    await RevenueService.logEvent({
      eventType:'platform_fee',userId:post.posterId ?? post.workerId,taskId:post.taskId,
      amountCents:post.platformFeeCents,grossAmountCents:post.grossPayoutCents,
      platformFeeCents:post.platformFeeCents,
      netAmountCents:post.payoutProvider==='LOCAL_CERTIFICATION_TEST'
        ? post.grossPayoutCents-post.platformFeeCents : post.netPayoutCents,
      feeBasisPoints:Math.round(post.platformFeePercent*100),escrowId,
      metadata:post.payoutProvider==='LOCAL_CERTIFICATION_TEST'
        ? { event:'local_certification_test_release',payout_provider:post.payoutProvider,
            provider_transfer_id:post.providerTransferId,is_test:true }
        : { event:'admin_override_release',admin_manual_payout_required:true },
    });
  } catch (error) {
    escrowLogger.error({ err:error instanceof Error ? error.message : String(error),escrowId },
      'F-01: Failed to log platform_fee for admin_override_release — manual reconciliation required');
  }
}

async function recordInsurance(escrowId:string,post:ReleasePost):Promise<void> {
  try {
    await SelfInsurancePoolService.recordContribution(
      post.taskId,post.workerId,post.insuranceContributionCents,
    );
  } catch(error) {
    escrowLogger.warn({ err:error instanceof Error ? error.message : String(error),workerId:post.workerId,escrowId },
      'Failed to record self-insurance contribution — escrow release proceeds');
  }
}

async function recordEarnings(post:ReleasePost,escrowId:string):Promise<void> {
  if (post.serviceBusinessProvider) return;
  await EarnedVerificationUnlockService.recordEarnings(
    post.workerId,post.taskId,escrowId,post.netPayoutCents,
  );
}

async function recordOfflineTax(post:ReleasePost):Promise<void> {
  if (!['offline_cash','offline_venmo','offline_cashapp'].includes(post.paymentMethod)) return;
  await XPTaxService.recordOfflinePayment(
    post.workerId,post.taskId,
    post.paymentMethod as 'offline_cash'|'offline_venmo'|'offline_cashapp',
    post.grossPayoutCents,
  );
}

async function awardXp(post:ReleasePost,escrowId:string):Promise<void> {
  try {
    await XPService.awardXP({
      userId:post.workerId,taskId:post.taskId,escrowId,
      baseXP:Math.round(post.grossPayoutCents/10),
    });
  } catch(error) {
    const taxBlocked=error instanceof Error && error.message.includes('XP-TAX-BLOCK');
    escrowLogger.warn(
      { err:error instanceof Error ? error.message : String(error),workerId:post.workerId,escrowId },
      taxBlocked ? 'XP blocked by tax trigger' : 'Auto-award XP failed after escrow release — worker can retry via escrow.awardXP',
    );
  }
}

export async function runReleaseEffects(input:{
  escrowId:string;post:ReleasePost;adminOverride:boolean;reason?:string;
}):Promise<void> {
  await recordReleaseEvent(input.escrowId,input.post,input.adminOverride,input.reason);
  await recordPlatformFee(input.escrowId,input.post,input.adminOverride);
  await recordInsurance(input.escrowId,input.post);
  await recordEarnings(input.post,input.escrowId);
  await recordOfflineTax(input.post);
  await awardXp(input.post,input.escrowId);
}
