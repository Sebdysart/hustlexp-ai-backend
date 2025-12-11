/**
 * Dispute Service - Phase C
 * TEMPORARILY DISABLED FOR MIGRATION
 * ref: Gate-1 Refund Architecture Hardening
 */

import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';

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
export type StrikeSeverity = 1 | 2 | 3;

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
// Service Class (STUBBED)
// ============================================

class DisputeServiceClass {
    createDispute(
        taskId: string,
        posterId: string,
        hustlerId: string,
        posterReason: string,
        escrowId?: string
    ): Dispute {
        // STUBBED
        serviceLogger.warn({ taskId }, 'Dispute creation disabled during migration');
        return {
            id: `dispute_stub_${Date.now()}`,
            taskId,
            posterId,
            hustlerId,
            escrowId: escrowId || 'stub_escrow',
            status: 'closed',
            posterReason,
            createdAt: new Date(),
            updatedAt: new Date()
        };
    }

    getDispute(disputeId: string): Dispute | undefined { return undefined; }
    getDisputeByTask(taskId: string): Dispute | undefined { return undefined; }
    listDisputes(filters?: any): Dispute[] { return []; }

    submitHustlerResponse(disputeId: string, hustlerId: string, response: string): Dispute | null {
        return null;
    }

    async resolveDispute(
        disputeId: string,
        adminId: string,
        resolution: 'refund' | 'payout' | 'split',
        options?: any
    ): Promise<ResolutionResult> {
        return { success: false, message: 'Disputes temporarily disabled', error: 'DISABLED' };
    }

    addStrike(userId: string, reason: string, severity: StrikeSeverity, source: StrikeSource = 'ai', options?: any): UserStrike {
        return {
            id: 'stub_strike',
            userId,
            reason,
            source,
            severity,
            createdAt: new Date()
        };
    }

    getUserStrikes(userId: string): UserStrike[] { return []; }
    isUserSuspended(userId: string): { suspended: boolean; reason?: string; until?: Date } { return { suspended: false }; }
    suspendUser(userId: string, days: number, reason: string): void { }
    unsuspendUser(userId: string, adminId: string): boolean { return false; }

    logModeration(action: any): void { }
    getModerationLogs(filters?: any): any[] { return []; }

    getStats(): any {
        return {
            total: 0,
            open: 0,
            underReview: 0,
            resolved: 0,
            byResolution: {}
        };
    }
}

export const DisputeService = new DisputeServiceClass();
