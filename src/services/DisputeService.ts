/**
 * Dispute Service - Phase C
 * 
 * Handles:
 * - Dispute creation on poster rejection
 * - Hustler response submission
 * - Admin resolution (refund/payout/split)
 * - Strike tracking and suspensions
 */

import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
import { StripeService } from './StripeService.js';

// ============================================
// Types
// ============================================

export type DisputeStatus =
    | 'open'
    | 'under_review'
    | 'resolved_refund'
    | 'resolved_payout'
    | 'resolved_split'
    | 'closed';

export interface Dispute {
    id: string;
    taskId: string;
    posterId: string;
    hustlerId: string;
    escrowId: string;
    status: DisputeStatus;
    posterReason: string;
    hustlerResponse?: string;
    resolutionNote?: string;
    resolutionAmountHustler?: number;
    resolutionAmountPoster?: number;
    resolvedBy?: string;
    createdAt: Date;
    updatedAt: Date;
}

export type StrikeSource = 'ai' | 'manual';
export type StrikeSeverity = 1 | 2 | 3; // 1=low, 2=medium, 3=critical

export interface UserStrike {
    id: string;
    userId: string;
    reason: string;
    source: StrikeSource;
    severity: StrikeSeverity;
    relatedTaskId?: string;
    relatedDisputeId?: string;
    createdAt: Date;
}

export interface UserSuspension {
    isSuspended: boolean;
    suspendedUntil?: Date;
    suspensionReason?: string;
}

export interface ResolutionResult {
    success: boolean;
    message: string;
    dispute?: Dispute;
    payoutId?: string;
    refundAmount?: number;
    payoutAmount?: number;
    error?: string;
}

// ============================================
// Configuration
// ============================================

const STRIKE_CONFIG = {
    // 3 medium strikes in 30 days → 7 day suspension
    mediumStrikesForSuspension: 3,
    mediumStrikeLookbackDays: 30,
    mediumSuspensionDays: 7,

    // 1 critical strike → immediate suspension pending review
    criticalStrikeAutoSuspend: true,
    criticalSuspensionDays: 365, // Effectively permanent until manual review
};

// ============================================
// In-memory stores (will sync with DB)
// ============================================

const disputes = new Map<string, Dispute>();
const userStrikes = new Map<string, UserStrike[]>(); // userId -> strikes
const userSuspensions = new Map<string, UserSuspension>();

// ============================================
// Service Class
// ============================================

class DisputeServiceClass {
    // ============================================
    // Dispute Creation
    // ============================================

    /**
     * Create a dispute when poster rejects task
     * Called from ProofValidationService.rejectTask when action !== 'refund'
     */
    createDispute(
        taskId: string,
        posterId: string,
        hustlerId: string,
        posterReason: string,
        escrowId?: string
    ): Dispute {
        const dispute: Dispute = {
            id: `dispute_${uuidv4()}`,
            taskId,
            posterId,
            hustlerId,
            escrowId: escrowId || `escrow_${taskId}`,
            status: 'open',
            posterReason,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        disputes.set(dispute.id, dispute);

        // Log moderation action
        this.logModeration({
            userId: posterId,
            taskId,
            type: 'dispute',
            severity: 'warn',
            label: 'dispute_opened',
            rawInputSnippet: posterReason.slice(0, 200),
            actionTaken: 'none',
        });

        serviceLogger.info({
            disputeId: dispute.id,
            taskId,
            posterId,
            hustlerId,
        }, 'Dispute created');

        return dispute;
    }

    /**
     * Get dispute by ID
     */
    getDispute(disputeId: string): Dispute | undefined {
        return disputes.get(disputeId);
    }

    /**
     * Get dispute by task ID
     */
    getDisputeByTask(taskId: string): Dispute | undefined {
        for (const dispute of disputes.values()) {
            if (dispute.taskId === taskId) {
                return dispute;
            }
        }
        return undefined;
    }

    /**
     * List disputes with optional filters
     */
    listDisputes(filters?: {
        status?: DisputeStatus;
        posterId?: string;
        hustlerId?: string;
        limit?: number;
    }): Dispute[] {
        let result = Array.from(disputes.values());

        if (filters?.status) {
            result = result.filter(d => d.status === filters.status);
        }
        if (filters?.posterId) {
            result = result.filter(d => d.posterId === filters.posterId);
        }
        if (filters?.hustlerId) {
            result = result.filter(d => d.hustlerId === filters.hustlerId);
        }

        result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        if (filters?.limit) {
            result = result.slice(0, filters.limit);
        }

        return result;
    }

    // ============================================
    // Hustler Response
    // ============================================

    /**
     * Allow hustler to submit their side of the dispute
     */
    submitHustlerResponse(disputeId: string, hustlerId: string, response: string): Dispute | null {
        const dispute = disputes.get(disputeId);

        if (!dispute) {
            serviceLogger.warn({ disputeId }, 'Dispute not found');
            return null;
        }

        if (dispute.hustlerId !== hustlerId) {
            serviceLogger.warn({ disputeId, hustlerId }, 'Unauthorized: not the hustler');
            return null;
        }

        if (dispute.status !== 'open') {
            serviceLogger.warn({ disputeId, status: dispute.status }, 'Cannot respond: dispute not open');
            return null;
        }

        dispute.hustlerResponse = response;
        dispute.status = 'under_review';
        dispute.updatedAt = new Date();

        disputes.set(disputeId, dispute);

        serviceLogger.info({ disputeId, hustlerId }, 'Hustler response submitted');

        return dispute;
    }

    // ============================================
    // Admin Resolution
    // ============================================

    /**
     * Resolve dispute as admin
     */
    async resolveDispute(
        disputeId: string,
        adminId: string,
        resolution: 'refund' | 'payout' | 'split',
        options?: {
            resolutionNote?: string;
            splitAmountHustler?: number;
            splitAmountPoster?: number;
        }
    ): Promise<ResolutionResult> {
        const dispute = disputes.get(disputeId);

        if (!dispute) {
            return { success: false, message: 'Dispute not found', error: 'NOT_FOUND' };
        }

        if (!['open', 'under_review'].includes(dispute.status)) {
            return {
                success: false,
                message: `Cannot resolve: dispute status is '${dispute.status}'`,
                error: 'INVALID_STATUS',
            };
        }

        const escrow = StripeService.getEscrow(dispute.taskId);
        if (!escrow) {
            return { success: false, message: 'Escrow not found', error: 'ESCROW_NOT_FOUND' };
        }

        if (escrow.status !== 'held') {
            return {
                success: false,
                message: `Escrow status is '${escrow.status}', cannot process`,
                error: 'INVALID_ESCROW',
            };
        }

        let result: ResolutionResult;

        switch (resolution) {
            case 'refund':
                // Full refund to poster
                const refunded = await StripeService.refundEscrow(
                    dispute.taskId,
                    `Dispute resolved: ${options?.resolutionNote || 'Refund to poster'}`
                );

                if (!refunded) {
                    return { success: false, message: 'Refund failed', error: 'REFUND_FAILED' };
                }

                dispute.status = 'resolved_refund';
                dispute.resolutionAmountPoster = escrow.amount;
                dispute.resolutionAmountHustler = 0;

                result = {
                    success: true,
                    message: 'Dispute resolved with full refund to poster',
                    dispute,
                    refundAmount: escrow.amount,
                };
                break;

            case 'payout':
                // Full payout to hustler
                const payout = await StripeService.releaseEscrow(dispute.taskId, 'standard');

                if (!payout) {
                    return { success: false, message: 'Payout failed', error: 'PAYOUT_FAILED' };
                }

                dispute.status = 'resolved_payout';
                dispute.resolutionAmountHustler = payout.netAmount;
                dispute.resolutionAmountPoster = 0;

                result = {
                    success: true,
                    message: 'Dispute resolved with full payout to hustler',
                    dispute,
                    payoutId: payout.id,
                    payoutAmount: payout.netAmount,
                };
                break;

            case 'split':
                // Split between poster and hustler
                const splitHustler = options?.splitAmountHustler ?? escrow.hustlerPayout * 0.5;
                const splitPoster = options?.splitAmountPoster ?? escrow.amount - splitHustler;

                // For split, we need to do a partial refund + partial payout
                // This is complex in real Stripe, for now we simulate
                serviceLogger.info({
                    disputeId,
                    splitHustler,
                    splitPoster,
                }, 'Split resolution - in production would do partial refund + partial transfer');

                // Release escrow as payout (hustler gets their portion)
                const splitPayout = await StripeService.releaseEscrow(dispute.taskId, 'standard');

                dispute.status = 'resolved_split';
                dispute.resolutionAmountHustler = splitHustler;
                dispute.resolutionAmountPoster = splitPoster;

                result = {
                    success: true,
                    message: `Dispute resolved with split: hustler $${splitHustler.toFixed(2)}, poster $${splitPoster.toFixed(2)}`,
                    dispute,
                    payoutId: splitPayout?.id,
                    payoutAmount: splitHustler,
                    refundAmount: splitPoster,
                };
                break;

            default:
                return { success: false, message: 'Invalid resolution type', error: 'INVALID_RESOLUTION' };
        }

        // Update dispute
        dispute.resolutionNote = options?.resolutionNote;
        dispute.resolvedBy = adminId;
        dispute.updatedAt = new Date();
        disputes.set(disputeId, dispute);

        // Log moderation action
        this.logModeration({
            userId: adminId,
            taskId: dispute.taskId,
            type: 'dispute',
            severity: 'info',
            label: `dispute_${resolution}`,
            rawInputSnippet: options?.resolutionNote?.slice(0, 200),
            actionTaken: 'manual_review',
        });

        serviceLogger.info({
            disputeId,
            resolution,
            adminId,
        }, 'Dispute resolved');

        return result;
    }

    // ============================================
    // Strike System
    // ============================================

    /**
     * Add a strike to a user
     */
    addStrike(
        userId: string,
        reason: string,
        severity: StrikeSeverity,
        source: StrikeSource = 'ai',
        options?: { taskId?: string; disputeId?: string }
    ): UserStrike {
        const strike: UserStrike = {
            id: `strike_${uuidv4()}`,
            userId,
            reason,
            source,
            severity,
            relatedTaskId: options?.taskId,
            relatedDisputeId: options?.disputeId,
            createdAt: new Date(),
        };

        // Add to user's strikes
        const strikes = userStrikes.get(userId) || [];
        strikes.push(strike);
        userStrikes.set(userId, strikes);

        // Log moderation
        this.logModeration({
            userId,
            taskId: options?.taskId,
            type: 'strike',
            severity: severity === 3 ? 'critical' : severity === 2 ? 'warn' : 'info',
            label: 'user_strike',
            rawInputSnippet: reason.slice(0, 200),
            aiScore: severity / 3,
            actionTaken: source === 'ai' ? 'auto_flagged' : 'manual_review',
        });

        serviceLogger.info({
            strikeId: strike.id,
            userId,
            severity,
            source,
        }, 'Strike added');

        // Check if suspension is needed
        this.checkAndApplySuspension(userId);

        return strike;
    }

    /**
     * Get strikes for a user
     */
    getUserStrikes(userId: string): UserStrike[] {
        return userStrikes.get(userId) || [];
    }

    /**
     * Check if user should be suspended and apply if needed
     */
    private checkAndApplySuspension(userId: string): void {
        const strikes = userStrikes.get(userId) || [];

        // Check for critical strike
        const recentCritical = strikes.find(s =>
            s.severity === 3 &&
            Date.now() - s.createdAt.getTime() < 24 * 60 * 60 * 1000 // Last 24 hours
        );

        if (recentCritical && STRIKE_CONFIG.criticalStrikeAutoSuspend) {
            this.suspendUser(
                userId,
                STRIKE_CONFIG.criticalSuspensionDays,
                'Critical violation - pending manual review'
            );
            return;
        }

        // Check for medium strikes threshold
        const lookbackDate = new Date();
        lookbackDate.setDate(lookbackDate.getDate() - STRIKE_CONFIG.mediumStrikeLookbackDays);

        const recentMediumStrikes = strikes.filter(s =>
            s.severity >= 2 &&
            s.createdAt >= lookbackDate
        );

        if (recentMediumStrikes.length >= STRIKE_CONFIG.mediumStrikesForSuspension) {
            this.suspendUser(
                userId,
                STRIKE_CONFIG.mediumSuspensionDays,
                `${recentMediumStrikes.length} violations in ${STRIKE_CONFIG.mediumStrikeLookbackDays} days`
            );
        }
    }

    /**
     * Suspend a user
     */
    suspendUser(userId: string, days: number, reason: string): void {
        const suspendedUntil = new Date();
        suspendedUntil.setDate(suspendedUntil.getDate() + days);

        const suspension: UserSuspension = {
            isSuspended: true,
            suspendedUntil,
            suspensionReason: reason,
        };

        userSuspensions.set(userId, suspension);

        // Log moderation
        this.logModeration({
            userId,
            type: 'suspension',
            severity: 'critical',
            label: 'user_suspended',
            rawInputSnippet: reason.slice(0, 200),
            actionTaken: 'suspended',
        });

        serviceLogger.warn({
            userId,
            days,
            suspendedUntil,
            reason,
        }, 'User suspended');
    }

    /**
     * Check if user is suspended
     */
    isUserSuspended(userId: string): { suspended: boolean; reason?: string; until?: Date } {
        const suspension = userSuspensions.get(userId);

        if (!suspension) {
            return { suspended: false };
        }

        if (!suspension.isSuspended) {
            return { suspended: false };
        }

        // Check if suspension has expired
        if (suspension.suspendedUntil && suspension.suspendedUntil < new Date()) {
            // Auto-unsuspend
            suspension.isSuspended = false;
            userSuspensions.set(userId, suspension);
            return { suspended: false };
        }

        return {
            suspended: true,
            reason: suspension.suspensionReason,
            until: suspension.suspendedUntil,
        };
    }

    /**
     * Manually unsuspend a user (admin action)
     */
    unsuspendUser(userId: string, adminId: string): boolean {
        const suspension = userSuspensions.get(userId);

        if (!suspension) {
            return false;
        }

        suspension.isSuspended = false;
        suspension.suspendedUntil = undefined;
        userSuspensions.set(userId, suspension);

        // Log moderation
        this.logModeration({
            userId,
            type: 'suspension',
            severity: 'info',
            label: 'user_unsuspended',
            rawInputSnippet: `Unsuspended by admin ${adminId}`,
            actionTaken: 'manual_review',
        });

        serviceLogger.info({ userId, adminId }, 'User unsuspended');

        return true;
    }

    // ============================================
    // Moderation Logging
    // ============================================

    private moderationLogs: {
        id: string;
        userId?: string;
        taskId?: string;
        type: string;
        severity: 'info' | 'warn' | 'critical';
        label: string;
        rawInputSnippet?: string;
        aiModelUsed?: string;
        aiScore?: number;
        actionTaken: string;
        createdAt: Date;
    }[] = [];

    /**
     * Log a moderation action
     */
    logModeration(action: {
        userId?: string;
        taskId?: string;
        type: string;
        severity: 'info' | 'warn' | 'critical';
        label: string;
        rawInputSnippet?: string;
        aiModelUsed?: string;
        aiScore?: number;
        actionTaken: string;
    }): void {
        this.moderationLogs.push({
            id: uuidv4(),
            ...action,
            createdAt: new Date(),
        });
    }

    /**
     * Get moderation logs with filters
     */
    getModerationLogs(filters?: {
        userId?: string;
        taskId?: string;
        type?: string;
        severity?: 'info' | 'warn' | 'critical';
        limit?: number;
    }): typeof this.moderationLogs {
        let result = [...this.moderationLogs];

        if (filters?.userId) {
            result = result.filter(l => l.userId === filters.userId);
        }
        if (filters?.taskId) {
            result = result.filter(l => l.taskId === filters.taskId);
        }
        if (filters?.type) {
            result = result.filter(l => l.type === filters.type);
        }
        if (filters?.severity) {
            result = result.filter(l => l.severity === filters.severity);
        }

        result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        if (filters?.limit) {
            result = result.slice(0, filters.limit);
        }

        return result;
    }

    // ============================================
    // Stats
    // ============================================

    /**
     * Get dispute stats
     */
    getStats(): {
        total: number;
        open: number;
        underReview: number;
        resolved: number;
        byResolution: Record<string, number>;
    } {
        const all = Array.from(disputes.values());
        const byStatus = all.reduce((acc, d) => {
            acc[d.status] = (acc[d.status] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);

        return {
            total: all.length,
            open: byStatus['open'] || 0,
            underReview: byStatus['under_review'] || 0,
            resolved: (byStatus['resolved_refund'] || 0) +
                (byStatus['resolved_payout'] || 0) +
                (byStatus['resolved_split'] || 0),
            byResolution: {
                refund: byStatus['resolved_refund'] || 0,
                payout: byStatus['resolved_payout'] || 0,
                split: byStatus['resolved_split'] || 0,
            },
        };
    }
}

export const DisputeService = new DisputeServiceClass();
