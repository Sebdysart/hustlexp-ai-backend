import { db } from '../db.js';
import { workerLogger } from '../logger.js';
import { notifyAdmins } from '../services/AdminNotificationHelper.js';

const log = workerLogger.child({ worker: 'escrow-action' });
const RESTRICTION_CODES = new Set([
  'account_closed',
  'account_invalid',
  'account_deauthorized',
  'transfer_not_reversible',
]);

export function stripeRestrictionCode(error: unknown): string | null {
  if (!(error instanceof Error) || !('code' in error)) return null;
  const code = (error as Error & { code?: string }).code ?? '';
  return RESTRICTION_CODES.has(code) ? code : null;
}

export async function lockEscrowForStripeRestriction(input: {
  escrowId: string;
  workerId: string;
  stripeCode: string;
}): Promise<void> {
  await db.transaction(async (query) => {
    await query(
      `WITH pre AS (SELECT state FROM escrows WHERE id = $1 FOR UPDATE),
            upd AS (
              UPDATE escrows SET state = 'LOCKED_DISPUTE', version = version + 1, updated_at = NOW()
              WHERE id = $1 AND state IN ('FUNDED', 'LOCKED_DISPUTE')
              RETURNING id
            )
       INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata)
       SELECT $1, pre.state, 'LOCKED_DISPUTE', NULL, 'system', $2 FROM pre
       WHERE EXISTS (SELECT 1 FROM upd)`,
      [input.escrowId, JSON.stringify({
        reason: 'stripe_account_restricted',
        stripe_code: input.stripeCode,
        worker_id: input.workerId,
      })],
    );
  });
  try {
    await notifyAdmins({
      title: 'Escrow Locked: Stripe Account Restricted',
      body: `Escrow ${input.escrowId} could not be released — worker Stripe account is restricted (code: ${input.stripeCode}). Manual admin review required.`,
      deepLink: `/admin/escrows/${input.escrowId}`,
      priority: 'CRITICAL',
      metadata: {
        escrow_id: input.escrowId,
        worker_id: input.workerId,
        stripe_code: input.stripeCode,
      },
    });
  } catch (error) {
    log.error(
      { err: error instanceof Error ? error.message : String(error), escrowId: input.escrowId },
      'Failed to notify admins of stripe account restriction — escrow is locked regardless',
    );
  }
}
