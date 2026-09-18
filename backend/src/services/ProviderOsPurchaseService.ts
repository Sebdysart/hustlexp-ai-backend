import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../db.js';
import { logger } from '../logger.js';
import { entitlementState } from './ProviderOsAccess.js';
import { writeProviderOsEntitlement } from './ProviderOsEntitlementService.js';
import { providerOsProduct, providerOsControlledPurchaseEnabled } from './ProviderOsProduct.js';
import { ControlledProductPaymentProvider } from './payment/ControlledProductPaymentProvider.js';
import { LocalCertificationPaymentProvider } from './LocalCertificationPaymentProvider.js';
import { newPaymentCreationMode } from './NewPaymentCreationGuard.js';
import type { StandaloneProductPurchase } from './payment/StandaloneProductPaymentProvider.js';

interface Purchase extends StandaloneProductPurchase {
  provider: 'local_test';
  status: 'pending' | 'succeeded' | 'failed' | 'canceled';
  resolution_reason: string | null;
  paid_at: Date | null;
  granted_expires_at: Date | null;
}
interface Entitlement {
  status: string;
  starts_at: Date;
  expires_at: Date | null;
}

async function billingMember(
  query: QueryFn,
  organizationId: string,
  actorId: string | null
): Promise<boolean> {
  if (!actorId) return false;
  const result = await query(
    `SELECT m.id FROM business_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status='ACTIVE'
      AND u.account_status='ACTIVE' AND NOT COALESCE(u.is_banned,false) AND NOT COALESCE(u.trust_hold,false)
      AND business_membership_has_action($1,$2,'MANAGE_BILLING') FOR SHARE OF m,u`,
    [organizationId, actorId]
  );
  return Boolean(result.rows[0]);
}
async function purchaseContext(query: QueryFn, organizationId: string, actorId: string) {
  const org = await query<{
    status: string;
    provider_enabled: boolean;
    verification_status: string;
  }>(
    'SELECT status,provider_enabled,verification_status FROM business_organizations WHERE id=$1 FOR UPDATE',
    [organizationId]
  );
  if (
    !org.rows[0] ||
    org.rows[0].status !== 'ACTIVE' ||
    !org.rows[0].provider_enabled ||
    !(await billingMember(query, organizationId, actorId))
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'An active business owner or billing administrator is required.',
    });
  }
  const result = await query<Entitlement>(
    'SELECT status,starts_at,expires_at FROM provider_os_entitlements WHERE organization_id=$1 FOR UPDATE',
    [organizationId]
  );
  return { entitlement: result.rows[0], verified: org.rows[0].verification_status === 'VERIFIED' };
}
function publicPurchase(p: Purchase | undefined, allowCheckout: boolean) {
  if (!p) return null;
  return {
    id: p.id,
    provider: p.provider,
    status: p.status,
    amountCents: p.amount_cents,
    currency: p.currency,
    periodDays: p.period_days,
    testMode: p.test_mode,
    expiresAt: p.granted_expires_at?.toISOString() ?? null,
    needsReview: Boolean(
      p.resolution_reason && p.resolution_reason !== 'provider_temporarily_unavailable'
    ),
    checkout:
      allowCheckout && p.status === 'pending' && !p.resolution_reason && p.provider_payment_id
        ? { kind: 'controlled_test' as const }
        : null,
  };
}
export async function getProviderOsPurchaseState(organizationId: string, actorId: string) {
  return db.transaction(async (query) => {
    const context = await purchaseContext(query, organizationId, actorId);
    const latest = await query<Purchase>(
      'SELECT * FROM provider_os_purchases WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
      [organizationId]
    );
    const state = entitlementState(context.entitlement);
    const product = providerOsProduct();
    return {
      product,
      accessState: state,
      expiresAt: context.entitlement?.expires_at?.toISOString() ?? null,
      verificationRequired: !context.verified,
      canPurchase: Boolean(product && ['inactive', 'expired'].includes(state)),
      purchase: publicPurchase(
        latest.rows[0],
        Boolean(
          product &&
          ['inactive', 'expired'].includes(state) &&
          latest.rows[0] &&
          (await billingMember(query, organizationId, latest.rows[0].purchaser_user_id))
        )
      ),
    };
  });
}
export async function createProviderOsPurchase(organizationId: string, actorId: string) {
  const product = providerOsProduct();
  if (!product)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Provider OS purchasing is not currently available.',
    });
  const purchase = await db.transaction(async (query) => {
    const { entitlement } = await purchaseContext(query, organizationId, actorId);
    if (!['inactive', 'expired'].includes(entitlementState(entitlement)))
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This business already has access or requires support to change its access.',
      });
    const existing = await query<Purchase>(
      "SELECT * FROM provider_os_purchases WHERE organization_id=$1 AND status='pending' FOR UPDATE",
      [organizationId]
    );
    if (existing.rows[0]) {
      if (!(await billingMember(query, organizationId, existing.rows[0].purchaser_user_id)))
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'The pending purchase requires support review.',
        });
      return existing.rows[0];
    }
    const created = await query<Purchase>(
      `INSERT INTO provider_os_purchases
      (organization_id,purchaser_user_id,provider,amount_cents,currency,period_days,test_mode)
      VALUES($1,$2,'local_test',$3,$4,$5,$6) RETURNING *`,
      [
        organizationId,
        actorId,
        product.amountCents,
        product.currency,
        product.periodDays,
        product.testMode,
      ]
    );
    return created.rows[0];
  });
  try {
    await initializePurchase(purchase);
  } catch {
    await db.query(
      "UPDATE provider_os_purchases SET resolution_reason='provider_temporarily_unavailable',updated_at=NOW() WHERE id=$1 AND status='pending'",
      [purchase.id]
    );
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message:
        'Payment setup is temporarily unavailable. Your purchase is saved; please try again.',
    });
  }
  return getProviderOsPurchaseState(organizationId, actorId);
}
async function initializePurchase(p: Purchase): Promise<void> {
  if (p.provider_payment_id) return;
  // Persist first. If the network fails, retries reuse exactly this purchase's provider idempotency key.
  const checkout = await ControlledProductPaymentProvider.create(p);
  await db.query(
    `UPDATE provider_os_purchases SET provider_payment_id=$2,resolution_reason=NULL,updated_at=NOW()
    WHERE id=$1 AND provider_payment_id IS NULL AND status='pending'`,
    [p.id, checkout.id]
  );
}

/** No browser-supplied status/transaction. Provider retrieval precedes the short, atomic grant transaction. */
export async function finalizeProviderOsPurchase(purchaseId: string): Promise<void> {
  const loaded = await db.query<Purchase>('SELECT * FROM provider_os_purchases WHERE id=$1', [
    purchaseId,
  ]);
  const snapshot = loaded.rows[0];
  if (!providerOsControlledPurchaseEnabled()) return;
  if (!snapshot || snapshot.status === 'succeeded' || !snapshot.provider_payment_id) return;
  let verified;
  try {
    verified = await ControlledProductPaymentProvider.verify(snapshot);
  } catch {
    await db.query(
      `UPDATE provider_os_purchases SET resolution_reason='verification_unavailable_or_mismatch',
      next_check_at=NOW()+INTERVAL '10 minutes',updated_at=NOW() WHERE id=$1 AND status <> 'succeeded'`,
      [purchaseId]
    );
    // Keep retries and Ops inspection available; a lookup failure is never proof of payment failure.
    throw new Error('Provider OS purchase verification failed');
  }
  await db.transaction(async (query) => {
    // Same organization-first lock order as Ops entitlement mutation and purchase creation.
    const org = await query<{ status: string; provider_enabled: boolean }>(
      'SELECT status,provider_enabled FROM business_organizations WHERE id=$1 FOR UPDATE',
      [snapshot.organization_id]
    );
    const result = await query<Purchase>(
      'SELECT * FROM provider_os_purchases WHERE id=$1 FOR UPDATE',
      [purchaseId]
    );
    const p = result.rows[0];
    if (!p || p.status === 'succeeded') return;
    if (p.provider_payment_id !== snapshot.provider_payment_id)
      throw new Error('Purchase binding changed');
    if (verified.state !== 'paid') {
      await query(
        `UPDATE provider_os_purchases SET status=$2,resolution_reason=NULL,next_check_at=NOW()+INTERVAL '5 minutes',updated_at=NOW() WHERE id=$1`,
        [p.id, verified.state]
      );
      return;
    }
    const ent = await query<Entitlement>(
      'SELECT status,starts_at,expires_at FROM provider_os_entitlements WHERE organization_id=$1 FOR UPDATE',
      [p.organization_id]
    );
    const current = ent.rows[0];
    let hold: string | null = null;
    if (!org.rows[0] || org.rows[0].status !== 'ACTIVE' || !org.rows[0].provider_enabled)
      hold = 'organization_ineligible';
    else if (!(await billingMember(query, p.organization_id, p.purchaser_user_id)))
      hold = 'purchaser_no_longer_authorized';
    else if (current && ['suspended', 'revoked'].includes(current.status))
      hold = 'administrative_access_block';
    else if (current && (current.starts_at.getTime() > Date.now() || !current.expires_at))
      hold = 'existing_unlimited_or_scheduled_access';
    if (hold) {
      await query(
        `UPDATE provider_os_purchases SET paid_at=COALESCE(paid_at,NOW()),provider_transaction_id=$2,
        resolution_reason=$3,next_check_at=NOW()+INTERVAL '1 hour',updated_at=NOW() WHERE id=$1`,
        [p.id, verified.transactionId, hold]
      );
      return;
    }
    const now = (await query<{ now: Date }>('SELECT NOW() AS now')).rows[0].now;
    const base = Math.max(now.getTime(), current?.expires_at?.getTime() ?? 0);
    const expiry = new Date(base + p.period_days * 86400000);
    await writeProviderOsEntitlement(query, {
      organizationId: p.organization_id,
      actorId: p.purchaser_user_id!,
      status: 'active',
      expiresAt: expiry.toISOString(),
      purchaseId: p.id,
      reason: `Verified Provider OS purchase ${p.id}`,
    });
    await query(
      `UPDATE provider_os_purchases SET status='succeeded',provider_transaction_id=$2,paid_at=COALESCE(paid_at,NOW()),
      granted_starts_at=$3,granted_expires_at=$4,resolution_reason=NULL,updated_at=NOW() WHERE id=$1`,
      [p.id, verified.transactionId, now, expiry]
    );
  });
}
export async function refreshProviderOsPurchase(
  organizationId: string,
  actorId: string,
  purchaseId: string
) {
  const p = await db.transaction(async (query) => {
    await purchaseContext(query, organizationId, actorId);
    const result = await query<Purchase>(
      'SELECT * FROM provider_os_purchases WHERE id=$1 AND organization_id=$2',
      [purchaseId, organizationId]
    );
    if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Purchase not found.' });
    return result.rows[0];
  });
  try {
    if (p.provider_payment_id) await finalizeProviderOsPurchase(p.id);
  } catch {
    /* Safe persisted status is returned; never expose provider/internal errors. */
  }
  return getProviderOsPurchaseState(organizationId, actorId);
}
export async function inspectProviderOsPurchases(organizationId: string) {
  const result = await db.query(
    'SELECT * FROM provider_os_purchases WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 50',
    [organizationId]
  );
  return { purchases: result.rows };
}
/** Controlled payment simulation, never a direct entitlement mutation. */
export async function completeControlledProviderOsPurchase(
  organizationId: string,
  actorId: string,
  purchaseId: string
) {
  if (!providerOsControlledPurchaseEnabled() || newPaymentCreationMode() !== 'enabled') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Controlled-test purchasing is disabled.',
    });
  }
  await db.transaction(async (query) => {
    const context = await purchaseContext(query, organizationId, actorId);
    const result = await query<Purchase>(
      'SELECT * FROM provider_os_purchases WHERE id=$1 AND organization_id=$2 FOR UPDATE',
      [purchaseId, organizationId]
    );
    const p = result.rows[0];
    if (!p) throw new TRPCError({ code: 'NOT_FOUND', message: 'Purchase not found.' });
    if (p.status === 'succeeded') return;
    if (
      p.status !== 'pending' ||
      !p.provider_payment_id ||
      !['inactive', 'expired', 'active'].includes(entitlementState(context.entitlement)) ||
      !(await billingMember(query, organizationId, p.purchaser_user_id))
    ) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This purchase requires support review.',
      });
    }
    // Authority and provider confirmation share this transaction; finalization independently re-reads the provider ledger.
    await LocalCertificationPaymentProvider.confirmProductIntent(p, query);
  });
  try {
    await finalizeProviderOsPurchase(purchaseId);
  } catch {
    /* A confirmed payment is durable and recovered by reconciliation. */
  }
  return getProviderOsPurchaseState(organizationId, actorId);
}
export async function reconcileProviderOsPurchases(): Promise<void> {
  const due =
    await db.query<Purchase>(`WITH due AS (SELECT id FROM provider_os_purchases WHERE status='pending'
    AND next_check_at<=NOW() ORDER BY next_check_at LIMIT 50 FOR UPDATE SKIP LOCKED)
    UPDATE provider_os_purchases p SET next_check_at=NOW()+INTERVAL '5 minutes' FROM due WHERE p.id=due.id RETURNING p.*`);
  for (const p of due.rows) {
    try {
      // Uninitialized purchases have not exposed checkout, hence cannot have charged money.
      // Creation remains gated even though verification of existing payments works while frozen.
      if (!p.provider_payment_id) {
        if (!providerOsProduct()) continue;
        await db.transaction(async (query) => {
          const { entitlement } = await purchaseContext(
            query,
            p.organization_id,
            p.purchaser_user_id ?? ''
          );
          if (!['inactive', 'expired'].includes(entitlementState(entitlement)))
            throw new Error('Purchase no longer eligible');
        });
        await initializePurchase(p);
      }
      await finalizeProviderOsPurchase(p.id);
    } catch {
      logger.warn({ purchaseId: p.id }, 'Provider OS purchase reconciliation deferred');
    }
  }
}
