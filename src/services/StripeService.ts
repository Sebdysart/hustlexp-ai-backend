/**
 * Stripe Service - Real Payment Processing
 * 
 * Handles:
 * - Connect account creation for hustlers
 * - Escrow holds on task acceptance
 * - Real ACH payouts on task completion
 * - Refunds and disputes
 */

import Stripe from 'stripe';
import { serviceLogger } from '../utils/logger.js';
import { sql, isDatabaseAvailable } from '../db/index.js';

// ============================================
// Configuration
// ============================================

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Check if Stripe is configured
const isStripeConfigured = !!STRIPE_SECRET_KEY;

if (!isStripeConfigured) {
    serviceLogger.warn('STRIPE_SECRET_KEY not set - payment processing disabled');
}

// Create Stripe client
const stripe = isStripeConfigured
    ? new Stripe(STRIPE_SECRET_KEY, {
        typescript: true,
    })
    : null;

// Seattle Beta restrictions
const ALLOWED_COUNTRIES = ['US'];
const SEATTLE_PLATFORM_FEE_PERCENT = 0.12; // 12%
const INSTANT_PAYOUT_FEE_FLAT = 1.50;
const INSTANT_PAYOUT_FEE_PERCENT = 0.01; // 1%

// ============================================
// Types
// ============================================

export interface ConnectAccountResult {
    success: boolean;
    accountId?: string;
    onboardingUrl?: string;
    error?: string;
}

export interface AccountStatus {
    accountId: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    requirements: string[];
    status: 'pending' | 'active' | 'restricted' | 'disabled';
}

export interface EscrowRecord {
    id: string;
    taskId: string;
    posterId: string;
    hustlerId: string;
    amount: number;
    platformFee: number;
    hustlerPayout: number;
    paymentIntentId: string;
    status: 'pending' | 'held' | 'released' | 'refunded' | 'disputed';
    createdAt: Date;
    releasedAt?: Date;
    stripeTransferId?: string;
}

export interface PayoutRecord {
    id: string;
    escrowId: string;
    hustlerId: string;
    hustlerStripeAccountId: string;
    amount: number;
    fee: number;
    netAmount: number;
    type: 'standard' | 'instant';
    status: 'pending' | 'processing' | 'completed' | 'failed';
    stripeTransferId?: string;
    stripePayoutId?: string;
    createdAt: Date;
    completedAt?: Date;
    failureReason?: string;
}

// ============================================
// In-memory ledger (will be replaced with DB)
// ============================================

const escrowLedger = new Map<string, EscrowRecord>();
const payoutLedger = new Map<string, PayoutRecord>();
const connectAccounts = new Map<string, string>(); // userId -> stripeAccountId
const processedEvents = new Set<string>(); // Webhook idempotency - event IDs already processed

// ============================================
// Stripe Service Class
// ============================================

class StripeServiceClass {
    /**
     * Check if Stripe is available
     */
    isAvailable(): boolean {
        return isStripeConfigured && stripe !== null;
    }

    // ============================================
    // Connect Accounts
    // ============================================

    /**
     * Create a Stripe Connect Express account for a hustler
     */
    async createConnectAccount(
        userId: string,
        email: string,
        metadata?: { name?: string; phone?: string }
    ): Promise<ConnectAccountResult> {
        if (!stripe) {
            serviceLogger.warn('Stripe not configured - cannot create Connect account');
            return { success: false, error: 'Payment processing not configured' };
        }

        try {
            // Check if user already has an account
            const existingAccountId = connectAccounts.get(userId);
            if (existingAccountId) {
                // Return onboarding link for existing account
                const link = await this.createAccountLink(existingAccountId);
                return {
                    success: true,
                    accountId: existingAccountId,
                    onboardingUrl: link,
                };
            }

            // Create new Express account
            const account = await stripe.accounts.create({
                type: 'express',
                country: 'US',
                email,
                capabilities: {
                    card_payments: { requested: true },
                    transfers: { requested: true },
                },
                settings: {
                    payouts: {
                        schedule: {
                            interval: 'manual', // We control payouts
                        },
                    },
                },
                metadata: {
                    hustlexp_user_id: userId,
                    ...metadata,
                },
            });

            // Store mapping
            connectAccounts.set(userId, account.id);

            // Create onboarding link
            const onboardingUrl = await this.createAccountLink(account.id);

            serviceLogger.info({
                userId,
                accountId: account.id,
            }, 'Created Stripe Connect account');

            return {
                success: true,
                accountId: account.id,
                onboardingUrl,
            };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to create Connect account');
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    /**
     * Create an account onboarding link
     */
    async createAccountLink(accountId: string): Promise<string | undefined> {
        if (!stripe) return undefined;

        try {
            const link = await stripe.accountLinks.create({
                account: accountId,
                refresh_url: `${process.env.FRONTEND_URL || 'https://hustlexp.app'}/onboarding/refresh`,
                return_url: `${process.env.FRONTEND_URL || 'https://hustlexp.app'}/onboarding/complete`,
                type: 'account_onboarding',
            });

            return link.url;
        } catch (error) {
            serviceLogger.error({ error, accountId }, 'Failed to create account link');
            return undefined;
        }
    }

    /**
     * Get account status
     */
    async getAccountStatus(userId: string): Promise<AccountStatus | null> {
        if (!stripe) return null;

        const accountId = connectAccounts.get(userId);
        if (!accountId) {
            return null;
        }

        try {
            const account = await stripe.accounts.retrieve(accountId);

            let status: AccountStatus['status'] = 'pending';
            if (account.charges_enabled && account.payouts_enabled) {
                status = 'active';
            } else if (account.requirements?.disabled_reason) {
                status = 'disabled';
            } else if (account.requirements?.currently_due?.length) {
                status = 'restricted';
            }

            return {
                accountId: account.id,
                chargesEnabled: account.charges_enabled ?? false,
                payoutsEnabled: account.payouts_enabled ?? false,
                detailsSubmitted: account.details_submitted ?? false,
                requirements: account.requirements?.currently_due || [],
                status,
            };
        } catch (error) {
            serviceLogger.error({ error, userId, accountId }, 'Failed to get account status');
            return null;
        }
    }

    /**
     * Get Connect account ID for a user
     */
    getConnectAccountId(userId: string): string | undefined {
        return connectAccounts.get(userId);
    }

    /**
     * Store Connect account mapping (for DB sync)
     */
    setConnectAccountId(userId: string, accountId: string): void {
        connectAccounts.set(userId, accountId);
    }

    // ============================================
    // Escrow & Payment Intent
    // ============================================

    /**
     * Create escrow hold when task is accepted
     * Poster's payment is captured but not transferred yet
     */
    async createEscrowHold(
        taskId: string,
        posterId: string,
        hustlerId: string,
        amount: number,
        paymentMethodId: string
    ): Promise<any | null> {
        if (!stripe) {
            serviceLogger.warn('Stripe not configured - cannot create escrow');
            return null;
        }

        try {
            const amountCents = Math.round(amount * 100);
            const platformFeeCents = Math.round(amount * SEATTLE_PLATFORM_FEE_PERCENT * 100);
            const hustlerPayoutCents = amountCents - platformFeeCents;

            // 1. CREATE (NO return_url allowed here)
            const paymentIntent = await stripe.paymentIntents.create({
                amount: amountCents,
                currency: 'usd',
                payment_method: paymentMethodId,
                capture_method: 'manual',
                confirm: false, // Split flow
                metadata: {
                    taskId,
                    posterId,
                    hustlerId,
                    type: 'escrow_hold',
                },
                transfer_group: taskId,
            });

            // 2. CONFIRM (return_url MUST be here)
            const confirmedPI = await stripe.paymentIntents.confirm(paymentIntent.id, {
                payment_method: paymentMethodId,
                return_url: `${process.env.FRONTEND_URL || 'https://hustlexp.app'}/task/${taskId}/payment-complete`,
            });

            const escrow: EscrowRecord = {
                id: `escrow_${Date.now()}`,
                taskId,
                posterId,
                hustlerId,
                amount,
                platformFee: platformFeeCents / 100,
                hustlerPayout: hustlerPayoutCents / 100,
                paymentIntentId: confirmedPI.id,
                status: 'held',
                createdAt: new Date(),
            };

            escrowLedger.set(taskId, escrow);

            serviceLogger.info({
                taskId,
                escrowId: escrow.id,
                amount,
                paymentIntentId: confirmedPI.id,
            }, 'Created escrow hold');

            return { ...escrow, _debug_pi: confirmedPI };
        } catch (error) {
            serviceLogger.error({ error, taskId }, 'Failed to create escrow hold');
            return null;
        }
    }

    /**
     * Release escrow and transfer funds to hustler
     * Called after poster approves task completion
     */
    async releaseEscrow(
        taskId: string,
        type: 'standard' | 'instant' = 'standard'
    ): Promise<PayoutRecord | null> {
        if (!stripe) {
            serviceLogger.warn('Stripe not configured - cannot release escrow');
            return null;
        }

        const escrow = escrowLedger.get(taskId);
        if (!escrow) {
            serviceLogger.error({ taskId }, 'Escrow not found');
            return null;
        }

        if (escrow.status !== 'held') {
            serviceLogger.error({ taskId, status: escrow.status }, 'Escrow not in held status');
            return null;
        }

        const hustlerAccountId = connectAccounts.get(escrow.hustlerId);
        if (!hustlerAccountId) {
            serviceLogger.error({ taskId, hustlerId: escrow.hustlerId }, 'Hustler has no Connect account');
            return null;
        }

        try {
            // 1. Capture the payment (move from hold to captured)
            // 1. Capture the payment (move from hold to captured)
            let capturedPI = await stripe.paymentIntents.retrieve(escrow.paymentIntentId);
            if (capturedPI.status === 'requires_capture') {
                capturedPI = await stripe.paymentIntents.capture(escrow.paymentIntentId);
            } else if (capturedPI.status !== 'succeeded') {
                throw new Error(`Invalid PI status for release: ${capturedPI.status}`);
            }
            const chargeId = capturedPI.latest_charge as string;

            // 2. Calculate payout amount
            let payoutAmount = escrow.hustlerPayout;
            let fee = 0;

            if (type === 'instant') {
                fee = INSTANT_PAYOUT_FEE_FLAT + (payoutAmount * INSTANT_PAYOUT_FEE_PERCENT);
                payoutAmount = payoutAmount - fee;
            }

            const payoutAmountCents = Math.round(payoutAmount * 100);

            // 3. Create transfer to hustler's Connect account
            const transfer = await stripe.transfers.create({
                amount: payoutAmountCents,
                currency: 'usd',
                destination: hustlerAccountId,
                transfer_group: taskId,
                metadata: {
                    taskId,
                    escrowId: escrow.id,
                    hustlerId: escrow.hustlerId,
                    type,
                },
                source_transaction: chargeId,
            });

            // 4. Create payout record
            const payout: PayoutRecord = {
                id: `payout_${Date.now()}`,
                escrowId: escrow.id,
                hustlerId: escrow.hustlerId,
                hustlerStripeAccountId: hustlerAccountId,
                amount: escrow.hustlerPayout,
                fee,
                netAmount: payoutAmount,
                type,
                status: 'processing',
                stripeTransferId: transfer.id,
                createdAt: new Date(),
            };

            payoutLedger.set(payout.id, payout);

            // 5. If instant payout, trigger immediate payout to bank
            if (type === 'instant') {
                try {
                    const instantPayout = await stripe.payouts.create({
                        amount: payoutAmountCents,
                        currency: 'usd',
                        method: 'instant',
                    }, {
                        stripeAccount: hustlerAccountId,
                    });

                    payout.stripePayoutId = instantPayout.id;
                } catch (instantError) {
                    // Instant payout failed, fall back to standard
                    serviceLogger.warn({ instantError, taskId }, 'Instant payout failed, using standard');
                    payout.type = 'standard';
                }
            }

            // 6. Update escrow status
            escrow.status = 'released';
            escrow.releasedAt = new Date();
            escrow.stripeTransferId = transfer.id;
            escrowLedger.set(taskId, escrow);

            serviceLogger.info({
                taskId,
                payoutId: payout.id,
                transferId: transfer.id,
                amount: payoutAmount,
                type,
            }, 'Released escrow and created payout');

            return payout;
        } catch (error) {
            serviceLogger.error({ error, taskId }, 'Failed to release escrow');
            return null;
        }
    }

    /**
     * Refund escrow (task cancelled)
     */
    async refundEscrow(taskId: string, reason?: string): Promise<boolean> {
        if (!stripe) return false;

        const escrow = escrowLedger.get(taskId);
        if (!escrow) {
            serviceLogger.error({ taskId }, 'Escrow not found for refund');
            return false;
        }

        if (escrow.status !== 'held') {
            serviceLogger.error({ taskId, status: escrow.status }, 'Cannot refund - escrow not held');
            return false;
        }

        try {
            // Cancel the PaymentIntent (refunds if captured, cancels if not)
            await stripe.paymentIntents.cancel(escrow.paymentIntentId);

            escrow.status = 'refunded';
            escrowLedger.set(taskId, escrow);

            serviceLogger.info({ taskId, reason }, 'Refunded escrow');
            return true;
        } catch (error) {
            serviceLogger.error({ error, taskId }, 'Failed to refund escrow');
            return false;
        }
    }

    // ============================================
    // Queries
    // ============================================

    /**
     * Get escrow record for a task
     */
    getEscrow(taskId: string): EscrowRecord | undefined {
        return escrowLedger.get(taskId);
    }

    /**
     * Get payout history for a hustler
     */
    getPayoutHistory(hustlerId: string): PayoutRecord[] {
        return Array.from(payoutLedger.values())
            .filter(p => p.hustlerId === hustlerId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }

    /**
     * Get payout by ID
     */
    getPayout(payoutId: string): PayoutRecord | undefined {
        return payoutLedger.get(payoutId);
    }

    /**
     * Get escrow balance (total held funds)
     */
    getEscrowBalance(): { count: number; totalAmount: number } {
        const held = Array.from(escrowLedger.values()).filter(e => e.status === 'held');
        return {
            count: held.length,
            totalAmount: held.reduce((sum, e) => sum + e.amount, 0),
        };
    }

    // ============================================
    // Webhooks
    // ============================================

    /**
     * Verify and parse Stripe webhook
     */
    verifyWebhook(payload: string | Buffer, signature: string): Stripe.Event | null {
        if (!stripe || !STRIPE_WEBHOOK_SECRET) {
            return null;
        }

        try {
            return stripe.webhooks.constructEvent(payload, signature, STRIPE_WEBHOOK_SECRET);
        } catch (error) {
            serviceLogger.error({ error }, 'Webhook verification failed');
            return null;
        }
    }

    /**
     * Handle webhook event - WITH PERSISTENT IDEMPOTENCY CHECK
     * Writes to DB FIRST, then applies changes - survives restarts/deploys
     */
    async handleWebhookEvent(event: Stripe.Event): Promise<void> {
        // STEP 1: Check in-memory cache first (fast path)
        if (processedEvents.has(event.id)) {
            serviceLogger.info({ eventId: event.id, type: event.type }, 'Webhook event already processed (cache) - skipping');
            return;
        }

        // STEP 2: Try to INSERT into DB - this is the authoritative check
        // ON CONFLICT DO NOTHING means if row exists, 0 rows affected
        if (isDatabaseAvailable() && sql) {
            try {
                const result = await sql`
                    INSERT INTO processed_stripe_events (event_id, event_type)
                    VALUES (${event.id}, ${event.type})
                    ON CONFLICT (event_id) DO NOTHING
                    RETURNING event_id
                `;

                // If insert returned 0 rows, event was already processed
                if (result.length === 0) {
                    // Add to local cache for future fast-path
                    processedEvents.add(event.id);
                    serviceLogger.info({ eventId: event.id, type: event.type }, 'Webhook event already processed (DB) - skipping');
                    return;
                }

                serviceLogger.info({ eventId: event.id, type: event.type }, 'Webhook event recorded in DB');
            } catch (dbError) {
                // DB error - log and continue with caution
                // Better to potentially process twice than miss an event
                serviceLogger.error({ error: dbError, eventId: event.id }, 'Failed to record webhook event in DB - proceeding with caution');
            }
        }

        // STEP 3: Add to local cache
        processedEvents.add(event.id);

        serviceLogger.info({ eventId: event.id, type: event.type }, 'Processing webhook event');

        switch (event.type) {
            case 'payout.paid': {
                const payout = event.data.object as Stripe.Payout;
                // Update payout status
                for (const [id, record] of payoutLedger) {
                    if (record.stripePayoutId === payout.id) {
                        record.status = 'completed';
                        record.completedAt = new Date();
                        payoutLedger.set(id, record);
                        serviceLogger.info({ payoutId: id, eventId: event.id }, 'Payout completed');
                    }
                }
                break;
            }

            case 'payout.failed': {
                const payout = event.data.object as Stripe.Payout;
                for (const [id, record] of payoutLedger) {
                    if (record.stripePayoutId === payout.id) {
                        record.status = 'failed';
                        record.failureReason = payout.failure_message || 'Unknown failure';
                        payoutLedger.set(id, record);
                        serviceLogger.error({ payoutId: id, reason: record.failureReason, eventId: event.id }, 'Payout failed');
                    }
                }
                break;
            }

            case 'account.updated': {
                const account = event.data.object as Stripe.Account;
                serviceLogger.info({
                    accountId: account.id,
                    chargesEnabled: account.charges_enabled,
                    payoutsEnabled: account.payouts_enabled,
                    eventId: event.id,
                }, 'Connect account updated');
                break;
            }

            default:
                serviceLogger.debug({ type: event.type, eventId: event.id }, 'Unhandled webhook event');
        }
    }

    /**
     * Check if event was already processed (for testing/debugging)
     */
    isEventProcessed(eventId: string): boolean {
        return processedEvents.has(eventId);
    }
}

export const StripeService = new StripeServiceClass();
