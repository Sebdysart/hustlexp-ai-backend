import type { QueryFn } from '../db.js';

export interface EscrowPaymentBinding {
  provider: string;
  providerPaymentId: string;
  taskId: string;
  organizationId: string | null;
  status: string;
}

/** Resolve the persisted paid obligation, never the current environment selector. */
export async function loadEscrowPaymentBinding(query: QueryFn, escrowId: string): Promise<EscrowPaymentBinding | null> {
  const result = await query<EscrowPaymentBinding>(
    `SELECT payment.provider, payment.provider_payment_id AS "providerPaymentId",
            task.id AS "taskId", quote.business_organization_id AS "organizationId", payment.status
     FROM escrows escrow
     JOIN tasks task ON task.id = escrow.task_id
     JOIN quote_payments payment ON payment.task_id = task.id
       AND payment.provider_payment_id = escrow.provider_payment_id
     JOIN quotes quote ON quote.id = payment.quote_id
     JOIN quote_versions version ON version.id = payment.quote_version_id AND version.quote_id = quote.id
     WHERE escrow.id = $1 AND version.total_cents = escrow.amount
       AND quote.business_organization_id IS NOT DISTINCT FROM task.business_fulfiller_organization_id
       AND (payment.provider <> 'tilled' OR (
         payment.finalization_state = 'FINALIZED' AND payment.intent_creation_state = 'BOUND'
         AND payment.provider_status = 'succeeded' AND payment.amount_cents = escrow.amount
         AND payment.business_organization_id = task.business_fulfiller_organization_id
       ))
     LIMIT 2`, [escrowId],
  );
  if (result.rows.length > 1) throw new Error('PAYMENT_BINDING_CONFLICT');
  return result.rows[0] ?? null;
}
