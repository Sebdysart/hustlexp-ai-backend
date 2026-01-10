/**
 * Stripe Service - Real Payment Processing (Fintech-Grade)
 *
 * DESIGN PHILOSOPHY:
 * - Stripe is a Settlement Network, NOT a State Machine.
 * - Webhooks are for CRASH RECOVERY only.
 * - Payouts are ignored (Banking Layer).
 * - Flows are Recovery-First (Direct Ledger Writes).
 */
import Stripe from 'stripe';
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
declare class StripeServiceClass {
    isAvailable(): boolean;
    createConnectAccount(userId: string, email: string, metadata?: {
        name?: string;
        phone?: string;
    }): Promise<ConnectAccountResult>;
    createAccountLink(accountId: string): Promise<string | undefined>;
    getAccountStatus(userId: string): Promise<AccountStatus | null>;
    getConnectAccountId(userId: string): string | undefined;
    setConnectAccountId(userId: string, accountId: string): void;
    createEscrowHold(taskId: string, posterId: string, hustlerId: string, amount: number, paymentMethodId: string): Promise<any | null>;
    releaseEscrow(taskId: string, type?: 'standard' | 'instant'): Promise<PayoutRecord | null>;
    refundEscrow(taskId: string, isAdmin?: boolean): Promise<any>;
    recoverHoldEscrow(pi: Stripe.PaymentIntent, taskId: string): Promise<void>;
    recoverReleaseEscrow(transfer: Stripe.Transfer, taskId: string): Promise<void>;
    verifyWebhook(payload: string | Buffer, signature: string): Stripe.Event | null;
    handleWebhookEvent(event: Stripe.Event): Promise<void>;
    getEscrowBalance(taskId: string): Promise<{
        amount: number;
        status: string;
    } | null>;
    getEscrow(taskId: string): Promise<EscrowRecord | null>;
    getPayoutHistory(hustlerId: string): Promise<PayoutRecord[]>;
    getPayout(payoutId: string): Promise<PayoutRecord | null>;
}
export declare const StripeService: StripeServiceClass;
export {};
//# sourceMappingURL=StripeService.d.ts.map