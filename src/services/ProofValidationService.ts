/**
 * Proof Validation Service - Phase B
 * TEMPORARILY DISABLED FOR MIGRATION
 * ref: Gate-1 Refund Architecture Hardening
 */

import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
import type { TaskCategory } from '../types/index.js';

// ============================================
// Types
// ============================================

export type VerificationStatus = 'pending' | 'verified' | 'failed' | 'manual_review';

export interface GPSLocation {
    latitude: number;
    longitude: number;
    accuracy?: number;
    timestamp?: Date;
}

export interface ProofSubmission {
    taskId: string;
    hustlerId: string;
    photoData: string | Buffer;
    photoType: 'before' | 'during' | 'after' | 'result';
    gps: GPSLocation;
    caption?: string;
    deviceInfo?: any;
}

export interface ProofRecord {
    id: string;
    taskId: string;
    hustlerId: string;
    sessionId: string;
    photoUrl: string;
    photoType: 'before' | 'during' | 'after' | 'result';
    photoHash?: string;
    fileSizeBytes: number;
    latitude: number;
    longitude: number;
    accuracy?: number;
    neighborhood: string;
    isWithinSeattle: boolean;
    verificationStatus: VerificationStatus;
    verificationReason?: string;
    gpsValidated: boolean;
    photoValidated: boolean;
    caption?: string;
    xpAwarded: number;
    createdAt: Date;
    verifiedAt?: Date;
}

export interface ProofSession {
    sessionId: string;
    taskId: string;
    hustlerId: string;
    category: TaskCategory;
    proofs: ProofRecord[];
    attemptCount: number;
    maxAttempts: number;
    requiredProofTypes: ('before' | 'during' | 'after' | 'result')[];
    completedTypes: ('before' | 'during' | 'after' | 'result')[];
    status: 'active' | 'pending_approval' | 'approved' | 'rejected' | 'expired';
    createdAt: Date;
    submittedAt?: Date;
    reviewedAt?: Date;
}

export interface ApprovalResult {
    success: boolean;
    message: string;
    payoutId?: string;
    payoutAmount?: number;
    error?: string;
}

// ============================================
// Service Class (STUBBED)
// ============================================

class ProofValidationServiceClass {
    isWithinSeattle(lat: number, lng: number): boolean {
        return true; // Stub: always true
    }

    getNeighborhood(lat: number, lng: number): string {
        return 'Stub Neighborhood';
    }

    validateGPS(gps: GPSLocation): { valid: boolean; reason?: string; neighborhood: string } {
        return { valid: true, neighborhood: 'Stubbed Neighborhood' };
    }

    async uploadPhoto(photoData: any, taskId: string, hustlerId: string, photoType: string): Promise<any> {
        return { url: 'https://stubbed.url/photo.jpg', hash: 'stubhash', sizeBytes: 100 };
    }

    startSession(taskId: string, hustlerId: string, category: TaskCategory): ProofSession {
        return {
            sessionId: 'stub_session',
            taskId,
            hustlerId,
            category,
            proofs: [],
            attemptCount: 0,
            maxAttempts: 3,
            requiredProofTypes: [],
            completedTypes: [],
            status: 'active',
            createdAt: new Date()
        };
    }

    getOrCreateSession(taskId: string, hustlerId: string, category: TaskCategory): ProofSession {
        return this.startSession(taskId, hustlerId, category);
    }

    getSession(sessionId: string): ProofSession | undefined { return undefined; }
    getSessionByTask(taskId: string): ProofSession | undefined {
        // Return undefined to mimic "not found" or stubbed active session?
        // User asked to neutralize calls. Returning undefined is safest to avoid downstream logic trying to use it.
        return undefined;
    }

    async submitProof(submission: ProofSubmission): Promise<{
        success: boolean;
        proof?: ProofRecord;
        session?: ProofSession;
        error?: string;
        verificationStatus: VerificationStatus;
    }> {
        return {
            success: false,
            error: 'Proof submission disabled during migration',
            verificationStatus: 'failed'
        };
    }

    canApprove(taskId: string): { canApprove: boolean; reason?: string; session?: ProofSession } {
        return { canApprove: false, reason: 'Disabled' };
    }

    async approveTask(
        taskId: string,
        posterId: string,
        options?: { rating?: number; tip?: number; instantPayout?: boolean }
    ): Promise<ApprovalResult> {
        return { success: false, message: 'Approval disabled via ProofService', error: 'DISABLED' };
    }

    async rejectTask(
        taskId: string,
        posterId: string,
        reason: string,
        action: 'refund' | 'dispute' | 'redo' = 'dispute'
    ): Promise<ApprovalResult> {
        return { success: false, message: 'Rejection disabled via ProofService', error: 'DISABLED' };
    }

    getProofsForTask(taskId: string): ProofRecord[] { return []; }
    getHustlerProofs(hustlerId: string, limit = 50): ProofRecord[] { return []; }

    getTaskVerificationStatus(taskId: string): any {
        return {
            hasProofs: false,
            proofCount: 0,
            gpsVerified: false,
            status: 'no_proofs',
            requiredTypes: [],
            completedTypes: []
        };
    }

    logModerationAction(action: any): void { }
    getModerationLogs(taskId: string): any[] { return []; }
}

export const ProofValidationService = new ProofValidationServiceClass();
