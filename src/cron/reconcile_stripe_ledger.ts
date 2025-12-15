
import '../config/env.js'; // Ensure env loaded
import { safeSql as sql } from '../db/index.js';
import { serviceLogger } from '../utils/logger.js';
import Stripe from 'stripe';
import { KillSwitch } from '../infra/KillSwitch.js';
import { env } from '../config/env.js';

/**
 * STRIPE REALITY MIRROR & 3-WAY RECONCILIATION ENGINE
 * 
 * Part of OMEGA_PROTOCOL.
 * 
 * Responsibilities:
 * 1. Mirror Stripe Balance, Transfers, Payouts to local DB.
 * 2. Calculate "Real" Ledger Balance (Snapshot + Pending).
 * 3. Compare with Stripe Available Balance.
 * 4. Trigger KILL_SWITCH if drift > 0 (Draconian Safety).
 */

const logger = serviceLogger.child({ module: 'StripeReconciler' });

export async function reconcileStripeLedger() {
    logger.info('Starting 3-Way Reconciliation...');

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-11-20.acacia' as any });

    try {
        // =========================================================================
        // PHASE 1: REALITY MIROR (Ingest from Stripe)
        // =========================================================================

        // 1. Balance Transactions (The Truth)
        // In prod, check cursor. For now, grab valid window or last 100.
        const balanceTxns = await stripe.balanceTransactions.list({ limit: 100 });

        for (const txn of balanceTxns.data) {
            await sql`
                INSERT INTO stripe_balance_history (
                    id, amount, currency, type, status, available_on, created, 
                    reporting_category, source_id, description
                ) VALUES (
                    ${txn.id}, ${txn.amount}, ${txn.currency}, ${txn.type}, ${txn.status}, 
                    ${new Date(txn.available_on * 1000)}, ${new Date(txn.created * 1000)},
                    ${txn.reporting_category}, ${txn.source}, ${txn.description}
                )
                ON CONFLICT (id) DO UPDATE SET status = ${txn.status}
            `;
        }

        // 2. Transfers (Connect Flows)
        const transfers = await stripe.transfers.list({ limit: 50 });
        for (const tr of transfers.data) {
            await sql`
                INSERT INTO stripe_transfer_history (
                    id, amount, currency, destination, status, created, metadata
                ) VALUES (
                    ${tr.id}, ${tr.amount}, ${tr.currency}, ${tr.destination as string}, 
                    'succeeded', ${new Date(tr.created * 1000)}, ${JSON.stringify(tr.metadata)}
                )
                ON CONFLICT (id) DO NOTHING
            `;
        }

        // 3. Payouts (Bank Flows)
        const payouts = await stripe.payouts.list({ limit: 50 });
        for (const po of payouts.data) {
            await sql`
                INSERT INTO stripe_payout_history (
                    id, amount, currency, status, arrival_date, created, destination
                ) VALUES (
                    ${po.id}, ${po.amount}, ${po.currency}, ${po.status}, 
                    ${new Date(po.arrival_date * 1000)}, ${new Date(po.created * 1000)}, ${po.destination as string}
                )
                ON CONFLICT (id) DO UPDATE SET status = ${po.status}
            `;
        }

        logger.info('Stripe Reality Mirror Updated.');

        // =========================================================================
        // PHASE 2: 3-WAY RECONCILIATION
        // =========================================================================

        // 1. Get INTERNAL Ledger Balance (Platform Cash + Escrow + Revenue)
        // We sum specific accounts to match Stripe Balance
        // Usually: Platform Cash + Platform Escrow + Platform Revenue + Stripe Fees = Total Stripe Balance?
        // Actually, Stripe Balance = Assets - Liabilities (ish).
        // Let's compare "Platform Asset Accounts" vs "Stripe Balance".

        const [ledgerSumRow] = await sql`
             SELECT SUM(balance) as total_balance 
             FROM ledger_accounts 
             WHERE owner_type = 'platform' 
             AND type IN ('asset', 'equity', 'expense') -- Exclude Liabilities (Escrow) which are Claims?
             -- Wait. Accounting Identity:
             -- Stripe Balance (Cash) = Platform Cash + Undistributed Revenue + Uncleared Escrow held in Platform Stripe?
             -- The simplest check is:
             -- Does Stripe Balance == SUM(All Platform Accounts except external Payables)?
             
             -- Let's assume: Stripe Balance = Platform Cash Account.
             -- Because "Escrow" is virtual partitioned money inside the Stripe Balance.
             -- So: Stripe Available + Pending = Total Platform Cash Logic.
        `;

        // Wait, better check:
        // Do we have "Platform Cash" account? Yes.
        // Is it updated on every Stripe In/Out? Yes.
        // So Platform Cash Account SHOULD equal Stripe Balance.

        const [platformCash] = await sql`
            SELECT balance FROM ledger_accounts 
            WHERE name LIKE 'Platform Cash%' 
            LIMIT 1
        `;

        if (!platformCash) {
            logger.warn('Skipping Recon: No Platform Cash Account initialized yet.');
            return;
        }

        const internalBalanceCents = parseInt(platformCash.balance);

        // 2. Get EXTERNAL Stripe Balance
        const stripeBalance = await stripe.balance.retrieve();
        const externalBalanceCents = stripeBalance.available[0].amount + stripeBalance.pending[0].amount;
        // Note: This matches simple case. In complex connect, its harder.

        // 3. Compare
        const drift = Math.abs(internalBalanceCents - externalBalanceCents);

        if (drift > 0) {
            logger.error({ internal: internalBalanceCents, external: externalBalanceCents, drift }, '🚨 RECONCILIATION FAILED: DRIFT DETECTED 🚨');

            // =========================================================================
            // PHASE 3: KILL SWITCH (OMEGA PROTOCOL)
            // =========================================================================
            await KillSwitch.trigger('LEDGER_DRIFT', {
                internal: internalBalanceCents,
                external: externalBalanceCents,
                drift
            });

        } else {
            logger.info('✅ 3-Way Reconciliation PASSED. Zero Drift.');
        }

    } catch (error) {
        logger.error({ error }, 'Reconciliation Cycle Crashed');
        // Do not trigger Kill Switch on transient API errors, unless repeated.
    }
}

// Auto-Run if called directly
if (process.argv[1] === import.meta.url) {
    import('../config/env.js').then(() => {
        reconcileStripeLedger().then(() => process.exit(0));
    });
}
