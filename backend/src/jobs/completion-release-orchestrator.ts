import { db, type QueryFn } from '../db.js';
import { workerLogger } from '../logger.js';
import { notifyAdmins } from '../services/AdminNotificationHelper.js';
import { EscrowService } from '../services/EscrowService.js';
import {
  LocalCertificationPayoutProvider,
  localCertificationPayoutEnabled,
} from '../services/LocalCertificationPayoutProvider.js';
import { loadEscrowPaymentBinding } from '../services/EscrowPaymentBindingService.js';
import { ErrorCodes } from '../types.js';

const log = workerLogger.child({ worker: 'completion-release' });
const TERMINAL_ESCROW_STATES = new Set(['RELEASED','REFUNDED','REFUND_PARTIAL']);
const TERMINAL_RELEASE_CODES = new Set<string>([ErrorCodes.ESCROW_TERMINAL,ErrorCodes.INVALID_STATE]);
interface EscrowSnapshot {
  id:string; task_id:string; state:string; version:number; amount:number;
  platform_fee_cents:number|null;
}
interface TaskSnapshot {
  state: string;
  worker_id: string | null;
  payout_recipient_user_id: string | null;
  business_fulfiller_organization_id: string | null;
  orchestration_mode: string | null;
  payment_method: string | null;
  poster_id: string | null;
  automation_classification: string | null;
}
type CompletionContext =
  | { action:'noop' }
  | { action:'proceed'; escrow:EscrowSnapshot; task:TaskSnapshot };

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
      `SELECT id,task_id,state,version,amount,platform_fee_cents
       FROM escrows WHERE id=$1 FOR UPDATE`,[escrowId],
    );
    const escrow=escrowResult.rows[0];
    if (!escrow) throw new Error(`Escrow ${escrowId} not found for completion release`);
    if (escrow.task_id !== taskId) throw new Error('Completion task/escrow binding mismatch');
    if (!await escrowCanProceed(escrow,taskId)) return {action:'noop'};
    const taskResult=await query<TaskSnapshot>(
            `SELECT state,
            worker_id,
            payout_recipient_user_id,
            business_fulfiller_organization_id,
            orchestration_mode,
            payment_method,
            poster_id,
            automation_classification
      FROM tasks
      WHERE id=$1`,[taskId],
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

async function resolveBusinessPayoutRecipient(
  organizationId: string,
): Promise<string> {
  const result = await db.query<{ payout_recipient_user_id: string }>(
    `SELECT payout_recipient_user_id
     FROM hxos_local_test_business_payout_destinations
     WHERE organization_id = $1
       AND status = 'ACTIVE'
       AND is_test IS TRUE`,
    [organizationId],
  );

  if (result.rows.length !== 1) {
    throw new Error(
      `Business ${organizationId} must have exactly one active local TEST payout destination`,
    );
  }

  return result.rows[0].payout_recipient_user_id;
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
  log.info({
    escrowId:escrow.id,taskId,transferId:transfer.data.transferId,
    amountCents:transfer.data.amountCents,provider:transfer.data.provider,
  },'Local TEST provider paid and escrow RELEASED');
}

async function processLocalTestBusinessPayout(
  escrow: EscrowSnapshot,
  taskId: string,
  organizationId: string,
  payoutRecipientUserId: string,
): Promise<void> {
  const transfer =
    await LocalCertificationPayoutProvider.createPaidBusinessTransfer({
      taskId,
      escrowId: escrow.id,
      organizationId,
      payoutRecipientUserId,
      idempotencyKey: `completion-release-local-test-business:${escrow.id}`,
    });

  if ('error' in transfer) {
    throw new Error(
      `Completion release: local TEST Business payout failed — ${transfer.error.message}`,
    );
  }

  const release = await EscrowService.release({
    escrowId: escrow.id,
    localTestTransferId: transfer.data.transferId,
  });

  if (
    !release.success
    && !TERMINAL_RELEASE_CODES.has(release.error.code)
  ) {
    throw new Error(
      `Completion release: local TEST Business escrow release failed — ${release.error.message}`,
    );
  }

  if (!release.success) {
    await assertLocalReleaseConverged(
      escrow.id,
      transfer.data.transferId,
      release.error.message,
    );
  }


  log.info(
    {
      escrowId: escrow.id,
      taskId,
      organizationId,
      payoutRecipientUserId,
      transferId: transfer.data.transferId,
      amountCents: transfer.data.amountCents,
      provider: transfer.data.provider,
    },
    'Local TEST Business provider paid and escrow RELEASED',
  );
}

export async function processCompletionRelease(input: { escrowId: string; taskId: string }): Promise<void> {
  const context = await loadCompletionContext(input.escrowId, input.taskId);
  if (context.action === 'noop') return;
  const { escrow, task } = context;
  const payment = await loadEscrowPaymentBinding(db.query.bind(db), escrow.id);
  if (payment?.provider === 'tilled') {
    // The merchant received the charge at checkout. Completion is bookkeeping only.
    const release = await EscrowService.release({ escrowId: escrow.id });
    if (!release.success && release.error.code !== ErrorCodes.ESCROW_TERMINAL) throw new Error(release.error.message);
    return;
  }
  if (payment && payment.provider !== 'local_test') throw new Error('Unsupported persisted payment provider');
  if (task.automation_classification !== 'CONTROLLED_TEST' || !localCertificationPayoutEnabled()) {
    throw new Error('No supported completion provider evidence; manual reconciliation required');
  }
  if (task.orchestration_mode === 'OPS_MANUAL' && task.business_fulfiller_organization_id && !task.worker_id) {
    const recipient = await resolveBusinessPayoutRecipient(task.business_fulfiller_organization_id);
    await processLocalTestBusinessPayout(escrow, input.taskId, task.business_fulfiller_organization_id, recipient);
    return;
  }
  if (!task.worker_id) throw new Error('Controlled test completion requires its bound fulfiller');
  await processLocalTestPayout(escrow, input.taskId, task.payout_recipient_user_id ?? task.worker_id);
}
