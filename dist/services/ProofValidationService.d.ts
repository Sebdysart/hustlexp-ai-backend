/**
 * Proof Validation Service - Phase B
 * TEMPORARILY DISABLED FOR MIGRATION
 * ref: Gate-1 Refund Architecture Hardening
 */
import type { TaskCategory } from '../types/index.js';
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
declare class ProofValidationServiceClass {
    private readonly SEATTLE_BOUNDS;
    isWithinSeattle(lat: number, lng: number): boolean;
    getNeighborhood(lat: number, lng: number): string;
    validateGPS(gps: GPSLocation): {
        valid: boolean;
        reason?: string;
        neighborhood: string;
    };
    uploadPhoto(photoData: any, taskId: string, hustlerId: string, photoType: string): Promise<any>;
    startSession(taskId: string, hustlerId: string, category: TaskCategory): ProofSession;
    getOrCreateSession(taskId: string, hustlerId: string, category: TaskCategory): ProofSession;
    getSession(sessionId: string): ProofSession | undefined;
    getSessionByTask(taskId: string): ProofSession | undefined;
    submitProof(submission: ProofSubmission): Promise<{
        success: boolean;
        proof?: ProofRecord;
        session?: ProofSession;
        error?: string;
        verificationStatus: VerificationStatus;
    }>;
    canApprove(taskId: string): {
        canApprove: boolean;
        reason?: string;
        session?: ProofSession;
    };
    approveTask(taskId: string, posterId: string, options?: {
        rating?: number;
        tip?: number;
        instantPayout?: boolean;
    }): Promise<ApprovalResult>;
    rejectTask(taskId: string, posterId: string, reason: string, action?: 'refund' | 'dispute' | 'redo'): Promise<ApprovalResult>;
    getProofsForTask(taskId: string): ProofRecord[];
    getHustlerProofs(hustlerId: string, limit?: number): ProofRecord[];
    getTaskVerificationStatus(taskId: string): any;
    logModerationAction(action: any): void;
    getModerationLogs(taskId: string): any[];
}
export declare const ProofValidationService: ProofValidationServiceClass;
export {};
//# sourceMappingURL=ProofValidationService.d.ts.map