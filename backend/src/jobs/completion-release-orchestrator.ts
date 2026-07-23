import { config } from '../config.js';
import { db, type QueryFn } from '../db.js';
import { computeFeeBreakdown } from '../lib/money.js';
import { notifyPaymentReleased } from '../lib/task-lifecycle-notifications.js';
import { workerLogger } from '../logger.js';
import { notifyAdmins } from '../services/AdminNotificationHelper.js';
import { EscrowService } from '../services/EscrowService.js';
import {
  LocalCertificationPayoutProvider,
  localCertificationPayoutEnabled,
} from '../services/LocalCertificationPayoutProvider.js';
import { StripeService } from '../services/StripeService.js';
import { loadCurrentTaskPayoutDestination } from '../services/TaskPayoutDestinationService.js';
import { ErrorCodes } from '../types.js';

const log = workerLogger.child({ worker: 'completion-release' });
const TERMINAL_ESCROW_STATES = new Set(['RELEASED','REFUNDED','REFUND_PARTIAL']);
const TERMINAL_RELEASE_CODES = new Set<string>([ErrorCodes.ESCROW_TERMINAL,ErrorCodes.INVALID_STATE]);
const STRIPE_ACCOUNT_RESTRICTION_CODES = new Set([
  'account_closed','account_invalid','account_deauthorized','transfer_not_reversible',
]);

interface EscrowSnapshot {
  id:string; task_id:string; state:string; version:number; amount:number;
  platform_fee_cents:number|null; stripe_transfer_id:string|null;
}
interface TaskSnapshot {
  state:string; worker_id:string|null; payout_recipient_user_id:string|null;
  payment_method:string|null; poster_id:string|null; automation_classification:string|null;
}
type CompletionContext =
  | { action:'noop' }
  | { action:'proceed'; escrow:EscrowSnapshot; task:TaskSnapshot };

function stripeRestrictionCode(error:unknown):string|null {
  if (!(error instanceof Error) || !('code' in error)) return null;
  const code=(error as Error & {code?:string}).code;
  return code && STRIPE_ACCOUNT_RESTRICTION_CODES.has(code) ? code : null;
}

async function escrowCanProceed(
  escrow:EscrowSnapshot,
  taskId:string,
):Promise<boolean> {
  if (TERMINAL_ESCROW_STATES.has(escrow.state)) {
    log.info({ escrowId:escrow.id,state:escrow.state },'Completion release already terminal');
    return false;
  }
  if (escrow.state==='LOCKED_DISPUTE') {
    log.warn({ escrowId:escrow.id,taskId },'Completion release deferred to dispute resolution');
    return false;
  }
  if (escrow.state==='FUNDED') return true;
  log.error({ escrowId:escrow.id,taskId,state:escrow.state },'Completed task has non-FUNDED escrow');
  await notifyAdmins({
    title:'Completion release blocked: escrow not FUNDED',
    body:`Task ${taskId} is COMPLETED but escrow ${escrow.id} is ${escrow.state}. Manual review required.`,
    deepLink:`/admin/escrows/${escrow.id}`,
    priority:'CRITICAL',
    metadata:{ escrow_id:escrow.id,task_id:taskId,escrow_state:escrow.state },
  });
  return false;
}

async function loadCompletionContext(escrowId:string,taskId:string):Promise<CompletionContext> {
  return db.transaction(async(query:QueryFn)=>{
    const escrowResult=await query<EscrowSnapshot>(
      `SELECT id,task_id,state,version,amount,platform_fee_cents,stripe_transfer_id
       FROM escrows WHERE id=$1 FOR UPDATE`,[escrowId],
    );
    const escrow=escrowResult.rows[0];
    if (!escrow) throw new Error(`Escrow ${escrowId} not found for completion release`);
    if (!await escrowCanProceed(escrow,taskId)) return {action:'noop'};
    const taskResult=await query<TaskSnapshot>(
      `SELECT state,worker_id,payout_recipient_user_id,payment_method,poster_id,
              automation_classification FROM tasks WHERE id=$1`,[taskId],
    );
    const task=taskResult.rows[0];
    if (!task) throw new Error(`Task ${taskId} not found for completion release`);
    if (task.state!=='COMPLETED') {
      throw new Error(`Completion release for task ${taskId} but state is ${task.state}, expected COMPLETED`);
    }
    return {action:'proceed',escrow,task};
  });
}

async function assertLocalReleaseConverged(
  escrowId:string,
  transferId:string,
  failureMessage:string,
):Promise<void> {
  const result=await db.query<{
    state:string;payout_provider:string|null;provider_transfer_id:string|null;
    provider_transfer_status:string|null;
  }>(
    `SELECT state,payout_provider,provider_transfer_id,provider_transfer_status
       FROM escrows WHERE id=$1`,[escrowId],
  );
  const row=result.rows[0];
  if (row?.state!=='RELEASED') throw new Error(`Completion release did not converge — ${failureMessage}`);
  if (row.payout_provider!=='LOCAL_CERTIFICATION_TEST') throw new Error('Completion release provider mismatch');
  if (row.provider_transfer_id!==transferId) throw new Error('Completion release transfer mismatch');
  if (row.provider_transfer_status!=='paid') throw new Error('Completion release provider is not paid');
}

async function processLocalTestPayout(
  escrow:EscrowSnapshot,
  taskId:string,
  payoutRecipientUserId:string,
):Promise<void> {
  const transfer=await LocalCertificationPayoutProvider.createPaidTransfer({
    taskId,escrowId:escrow.id,workerId:payoutRecipientUserId,
    idempotencyKey:`completion-release-local-test:${escrow.id}`,
  });
  if (!transfer.success) throw new Error(`Completion release: local TEST payout failed — ${transfer.error.message}`);
  const release=await EscrowService.release({ escrowId:escrow.id,localTestTransferId:transfer.data.transferId });
  if (!release.success && !TERMINAL_RELEASE_CODES.has(release.error.code)) {
    throw new Error(`Completion release: local TEST escrow release failed — ${release.error.message}`);
  }
  if (!release.success) {
    await assertLocalReleaseConverged(escrow.id,transfer.data.transferId,release.error.message);
  }
  await notifyPaymentReleased(payoutRecipientUserId,taskId,transfer.data.amountCents);
  log.info({
    escrowId:escrow.id,taskId,transferId:transfer.data.transferId,
    amountCents:transfer.data.amountCents,provider:transfer.data.provider,
  },'Local TEST provider paid and escrow RELEASED');
}

async function loadStripeDestination(
  escrow:EscrowSnapshot,
  task:TaskSnapshot,
  taskId:string,
  payoutRecipientUserId:string,
):Promise<string|null> {
  if (!task.worker_id) return null;
  const destination=await loadCurrentTaskPayoutDestination(db.query.bind(db),{
    taskId,workerId:task.worker_id,payoutRecipientUserId,
  });
  if (destination.ready) return destination.stripeConnectId;
  log.error({ escrowId:escrow.id,taskId,payoutRecipientUserId,reason:destination.reason },
    'Payout destination is not current');
  await notifyAdmins({
    title:'Payout blocked: destination is not current',
    body:`Task ${taskId} completed; escrow ${escrow.id} remains FUNDED because its payout evidence is not current. Reconcile the provider destination before release.`,
    deepLink:`/admin/escrows/${escrow.id}`,
    priority:'CRITICAL',
    metadata:{ escrow_id:escrow.id,task_id:taskId,worker_id:task.worker_id,
      payout_recipient_user_id:payoutRecipientUserId,payout_block_reason:destination.reason },
  });
  return null;
}

async function createStripeTransfer(
  escrow:EscrowSnapshot,
  task:TaskSnapshot,
  taskId:string,
  payoutRecipientUserId:string,
  stripeConnectId:string,
):Promise<string|null> {
  const money=computeFeeBreakdown(escrow.amount,config.stripe.platformFeePercent,escrow.platform_fee_cents);
  try {
    const transfer=await StripeService.createTransfer({
      escrowId:escrow.id,taskId,workerId:payoutRecipientUserId,
      workerStripeAccountId:stripeConnectId,amount:money.netPayoutCents,
      description:'Task completion payout',idempotencyKeySuffix:'completion_release',
    });
    if (!transfer.success) throw new Error(`Completion release: failed to create transfer — ${transfer.error.message}`);
    return transfer.data.transferId;
  } catch(error) {
    const code=stripeRestrictionCode(error);
    if (!code) throw error;
    log.error({ escrowId:escrow.id,payoutRecipientUserId,stripeCode:code },'Stripe account restricted');
    await notifyAdmins({
      title:'Payout blocked: Stripe account restriction',
      body:`Completion release for escrow ${escrow.id} hit restriction '${code}'. Manual review required.`,
      deepLink:`/admin/escrows/${escrow.id}`,
      priority:'CRITICAL',
      metadata:{ escrow_id:escrow.id,task_id:taskId,worker_id:task.worker_id,payout_recipient_user_id:payoutRecipientUserId,stripe_code:code },
    });
    return null;
  }
}

async function persistTransferId(escrow:EscrowSnapshot,newTransferId:string):Promise<string> {
  let concurrentTransferId:string|null=null;
  await db.transaction(async(query:QueryFn)=>{
    const lockedResult=await query<{id:string;version:number;stripe_transfer_id:string|null}>(
      `SELECT id,version,stripe_transfer_id FROM escrows WHERE id=$1 FOR UPDATE NOWAIT`,[escrow.id],
    );
    const locked=lockedResult.rows[0];
    if (!locked) throw new Error(`Escrow ${escrow.id} disappeared during T2 lock — retry`);
    if (locked.stripe_transfer_id) {
      concurrentTransferId=locked.stripe_transfer_id;
      return;
    }
    if (locked.version!==escrow.version) {
      throw new Error(`Version conflict in T2 for escrow ${escrow.id} (expected ${escrow.version}, got ${locked.version}) — retry`);
    }
    const update=await query(
      `UPDATE escrows SET stripe_transfer_id=$1,version=version+1
        WHERE id=$2 AND version=$3 RETURNING id`,[newTransferId,escrow.id,escrow.version],
    );
    if (!update.rows.length) throw new Error(`Concurrent version conflict storing transfer ${newTransferId} — retry`);
  });
  return concurrentTransferId ?? newTransferId;
}

async function resolveStripeTransfer(
  escrow:EscrowSnapshot,
  task:TaskSnapshot,
  taskId:string,
  payoutRecipientUserId:string,
):Promise<string|null> {
  if (escrow.stripe_transfer_id) return escrow.stripe_transfer_id;
  const destination=await loadStripeDestination(escrow,task,taskId,payoutRecipientUserId);
  if (!destination) return null;
  const transferId=await createStripeTransfer(escrow,task,taskId,payoutRecipientUserId,destination);
  return transferId ? persistTransferId(escrow,transferId) : null;
}

async function releaseAndNotify(
  escrow:EscrowSnapshot,
  taskId:string,
  payoutRecipientUserId:string,
  stripeTransferId:string,
):Promise<void> {
  const release=await EscrowService.release({ escrowId:escrow.id,stripeTransferId });
  if (!release.success && TERMINAL_RELEASE_CODES.has(release.error.code)) return;
  if (!release.success) throw new Error(`Completion release: EscrowService.release failed — ${release.error.message}`);
  const money=computeFeeBreakdown(escrow.amount,config.stripe.platformFeePercent,escrow.platform_fee_cents);
  await notifyPaymentReleased(payoutRecipientUserId,taskId,money.netPayoutCents);
  log.info({ escrowId:escrow.id,taskId,stripeTransferId },'Escrow RELEASED — payout complete');
}

export async function processCompletionRelease(input:{escrowId:string;taskId:string}):Promise<void> {
  const context=await loadCompletionContext(input.escrowId,input.taskId);
  if (context.action==='noop') return;
  const {escrow,task}=context;
  if ((task.payment_method ?? 'escrow')!=='escrow') return;
  if (!task.worker_id) throw new Error(`Task ${input.taskId} is COMPLETED but has no worker_id — cannot pay out`);
  const payoutRecipientUserId=task.payout_recipient_user_id ?? task.worker_id;
  if (task.automation_classification==='CONTROLLED_TEST' && localCertificationPayoutEnabled()) {
    await processLocalTestPayout(escrow,input.taskId,payoutRecipientUserId);
    return;
  }
  const transferId=await resolveStripeTransfer(escrow,task,input.taskId,payoutRecipientUserId);
  if (!transferId) return;
  await releaseAndNotify(escrow,input.taskId,payoutRecipientUserId,transferId);
}
