
import { sql } from '../db';
import { serviceLogger } from '../utils/logger';
import Stripe from 'stripe';
import { env } from '../config/env';

const stripe = new Stripe(env.STRIPE_SECRET_KEY!, { typescript: true });

/**
 * STRIPE LEDGER RECONCILIATION
 * 
 * 1. Pull latest Balance Transactions from Stripe.
 * 2. Store in `stripe_balance_history`.
 * 3. Compare specific types (Payment, Payout) with Ledger.
 */
export async function reconcileStripeLedger() {
    const logger = serviceLogger.child({ module: 'StripeReconciler' });
    logger.info('Starting Stripe Reconciliation...');

    try {
        // 1. Fetch Latest Transactions (Incremental?)
        // For simplicity, we fetch last 100. In prod, use cursor from DB.
        const balanceTxns = await stripe.balanceTransactions.list({ limit: 100 });

        let newCount = 0;
        for (const txn of balanceTxns.data) {
            // Upsert into Mirror Table
            const [saved] = await sql`
                INSERT INTO stripe_balance_history (
                    id, amount, currency, type, status, 
                    available_on, created, reporting_category, source_id, description
                ) VALUES (
                    ${txn.id}, ${txn.amount}, ${txn.currency}, ${txn.type}, ${txn.status},
                    ${new Date(txn.available_on * 1000)}, ${new Date(txn.created * 1000)},
                    ${txn.reporting_category}, ${txn.source}, ${txn.description}
                )
                ON CONFLICT (id) DO NOTHING
                RETURNING id
            `;
            if (saved) newCount++;
        }
        logger.info({ newCount }, 'Synced Stripe Balance Transactions');

        // 2. Cross-Verification (Ledger vs Stripe) by Source ID (Charge/Transfer)
        // We look for Ledger Transactions that have metadata->'stripe_charge_id'
        // And ensure they match a Stripe Balance Transaction.

        const discrepancies = await sql`
            SELECT 
                lt.id as ledger_tx_id, 
                lt.metadata->>'stripe_charge_id' as stripe_charge_id,
                sbh.amount as stripe_amount,
                sbh.id as stripe_txn_id
            FROM ledger_transactions lt
            LEFT JOIN stripe_balance_history sbh ON sbh.source_id = lt.metadata->>'stripe_charge_id'
            WHERE lt.type = 'ESCROW_HOLD' 
            AND lt.status = 'committed'
            AND (sbh.id IS NULL) -- Missing in Stripe (Big Problem)
            -- Note: We assume 1:1 map. Stripe fees might complicate 'amount' check.
            -- Ledger records Gross in Escrow? Or Net? 
            -- We recorded 2 entries: Debit Poster (Gross), Credit Escrow (Gross).
            -- Stripe Balance Txn for Charge is (Gross - Fee) usually? No, it's Amount (Net).
            -- This requires precise mapping check.
        `;

        if (discrepancies.length > 0) {
            // It might just be sync delay? Or real missing money.
            // For now, warn.
            logger.warn({ count: discrepancies.length, sample: discrepancies.slice(0, 3) }, 'Potential Ledger-Stripe Mismatch (Missing Stripe Txn for Ledger Commit)');
        } else {
            logger.info('PASS: All Committed Escrow Holds found in Stripe Balance History.');
        }

    } catch (error) {
        logger.error({ error }, 'Reconciliation Failed');
        process.exit(1);
    }
}

if (process.argv[1] === import.meta.url) {
    reconcileStripeLedger().then(() => process.exit(0));
}
