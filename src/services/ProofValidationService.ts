/**
 * Proof Validation Service - Phase B
 * 
 * Real proof pipeline:
 * - GPS validation (Seattle bounds)
 * - Reverse geocoding
 * - R2 photo upload
 * - Duplicate detection
 * - Rate limiting per task
 * - Approval gating
 */

import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
import { StripeService } from './StripeService.js';
import type { TaskCategory } from '../types/index.js';

// ============================================
// Seattle Bounding Box
// ============================================

// Greater Seattle area bounds
const SEATTLE_BOUNDS = {
    north: 47.7341,  // North Seattle / Shoreline
    south: 47.4919,  // South Seattle / Tukwila
    east: -122.2244, // Bellevue edge
    west: -122.4596, // Puget Sound
};

// Neighborhood mapping for reverse geocode (simplified)
const SEATTLE_NEIGHBORHOODS: { name: string; bounds: { lat: [number, number]; lng: [number, number] } }[] = [
    { name: 'Capitol Hill', bounds: { lat: [47.615, 47.635], lng: [-122.325, -122.305] } },
    { name: 'Ballard', bounds: { lat: [47.66, 47.69], lng: [-122.40, -122.36] } },
    { name: 'Fremont', bounds: { lat: [47.648, 47.665], lng: [-122.365, -122.345] } },
    { name: 'University District', bounds: { lat: [47.655, 47.675], lng: [-122.325, -122.295] } },
    { name: 'Queen Anne', bounds: { lat: [47.625, 47.645], lng: [-122.365, -122.345] } },
    { name: 'Downtown', bounds: { lat: [47.600, 47.620], lng: [-122.345, -122.325] } },
    { name: 'South Lake Union', bounds: { lat: [47.620, 47.635], lng: [-122.345, -122.330] } },
    { name: 'Beacon Hill', bounds: { lat: [47.565, 47.590], lng: [-122.315, -122.295] } },
    { name: 'Columbia City', bounds: { lat: [47.555, 47.570], lng: [-122.295, -122.275] } },
    { name: 'West Seattle', bounds: { lat: [47.545, 47.580], lng: [-122.405, -122.365] } },
    { name: 'Greenwood', bounds: { lat: [47.690, 47.710], lng: [-122.365, -122.345] } },
    { name: 'Wallingford', bounds: { lat: [47.650, 47.665], lng: [-122.345, -122.325] } },
];

// ============================================
// R2 Configuration
// ============================================

const R2_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'hustlexp-proofs';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || `https://${R2_BUCKET_NAME}.r2.dev`;

const isR2Configured = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);

if (!isR2Configured) {
    serviceLogger.warn('R2 not configured - using mock photo storage');
}

// ============================================
// Types
// ============================================

export type VerificationStatus = 'pending' | 'verified' | 'failed' | 'manual_review';

export interface GPSLocation {
    latitude: number;
    longitude: number;
    accuracy?: number; // meters
    timestamp?: Date;
}

export interface ProofSubmission {
    taskId: string;
    hustlerId: string;
    photoData: string | Buffer; // base64 or binary
    photoType: 'before' | 'during' | 'after' | 'result';
    gps: GPSLocation;
    caption?: string;
    deviceInfo?: {
        model?: string;
        os?: string;
    };
}

export interface ProofRecord {
    id: string;
    taskId: string;
    hustlerId: string;
    sessionId: string;

    // Photo
    photoUrl: string;
    photoType: 'before' | 'during' | 'after' | 'result';
    photoHash?: string; // For duplicate detection
    fileSizeBytes: number;

    // GPS
    latitude: number;
    longitude: number;
    accuracy?: number;
    neighborhood: string;
    isWithinSeattle: boolean;

    // Validation
    verificationStatus: VerificationStatus;
    verificationReason?: string;
    gpsValidated: boolean;
    photoValidated: boolean;

    // Metadata
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
// In-memory stores (will sync with DB)
// ============================================

const proofSessions = new Map<string, ProofSession>();
const proofRecords = new Map<string, ProofRecord>();
const taskAttemptCounts = new Map<string, number>(); // taskId:hustlerId -> count

// Category proof requirements
const PROOF_REQUIREMENTS: Record<TaskCategory, ('before' | 'during' | 'after' | 'result')[]> = {
    cleaning: ['before', 'after'],
    moving: ['before', 'after'],
    delivery: ['result'],
    pet_care: ['before', 'after'],
    errands: ['result'],
    handyman: ['before', 'after'],
    tech_help: ['result'],
    yard_work: ['before', 'after'],
    event_help: ['result'],
    other: ['result'],
};

// ============================================
// Service Class
// ============================================

class ProofValidationServiceClass {
    // ============================================
    // GPS Validation
    // ============================================

    /**
     * Check if GPS coordinates are within Seattle bounds
     */
    isWithinSeattle(lat: number, lng: number): boolean {
        return (
            lat >= SEATTLE_BOUNDS.south &&
            lat <= SEATTLE_BOUNDS.north &&
            lng >= SEATTLE_BOUNDS.west &&
            lng <= SEATTLE_BOUNDS.east
        );
    }

    /**
     * Get Seattle neighborhood from GPS
     */
    getNeighborhood(lat: number, lng: number): string {
        for (const hood of SEATTLE_NEIGHBORHOODS) {
            if (
                lat >= hood.bounds.lat[0] &&
                lat <= hood.bounds.lat[1] &&
                lng >= hood.bounds.lng[0] &&
                lng <= hood.bounds.lng[1]
            ) {
                return hood.name;
            }
        }

        // Check if in Seattle but not in known neighborhood
        if (this.isWithinSeattle(lat, lng)) {
            return 'Greater Seattle';
        }

        return 'Outside Seattle';
    }

    /**
     * Validate GPS data
     */
    validateGPS(gps: GPSLocation): { valid: boolean; reason?: string; neighborhood: string } {
        // Check if GPS data exists
        if (!gps || typeof gps.latitude !== 'number' || typeof gps.longitude !== 'number') {
            return { valid: false, reason: 'GPS data missing or invalid', neighborhood: 'Unknown' };
        }

        // Check reasonable accuracy (if provided)
        if (gps.accuracy && gps.accuracy > 100) {
            return {
                valid: false,
                reason: `GPS accuracy too low (${gps.accuracy}m). Please ensure location services are enabled.`,
                neighborhood: 'Unknown'
            };
        }

        // Check Seattle bounds
        const isInSeattle = this.isWithinSeattle(gps.latitude, gps.longitude);
        const neighborhood = this.getNeighborhood(gps.latitude, gps.longitude);

        if (!isInSeattle) {
            return {
                valid: false,
                reason: `Location (${gps.latitude.toFixed(4)}, ${gps.longitude.toFixed(4)}) is outside Seattle service area`,
                neighborhood,
            };
        }

        return { valid: true, neighborhood };
    }

    // ============================================
    // R2 Photo Upload
    // ============================================

    /**
     * Upload photo to R2 bucket
     */
    async uploadPhoto(
        photoData: string | Buffer,
        taskId: string,
        hustlerId: string,
        photoType: string
    ): Promise<{ url: string; hash: string; sizeBytes: number } | null> {
        const photoId = uuidv4();
        const fileName = `${taskId}/${hustlerId}/${photoType}_${photoId}.jpg`;

        // Convert base64 to buffer if needed
        let buffer: Buffer;
        if (typeof photoData === 'string') {
            // Remove data URL prefix if present
            const base64Data = photoData.replace(/^data:image\/\w+;base64,/, '');
            buffer = Buffer.from(base64Data, 'base64');
        } else {
            buffer = photoData;
        }

        // Check file size (max 10MB)
        const MAX_SIZE = 10 * 1024 * 1024;
        if (buffer.length > MAX_SIZE) {
            serviceLogger.warn({ size: buffer.length, maxSize: MAX_SIZE }, 'Photo too large');
            // In production, would compress here
            // For now, reject
            return null;
        }

        // Generate simple hash for duplicate detection
        const hash = this.generatePhotoHash(buffer);

        if (!isR2Configured) {
            // Mock upload - return fake URL
            const mockUrl = `${R2_PUBLIC_URL}/${fileName}`;
            serviceLogger.info({ fileName, mockUrl }, 'Mock photo upload (R2 not configured)');
            return { url: mockUrl, hash, sizeBytes: buffer.length };
        }

        try {
            // Real R2 upload using S3-compatible API
            const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

            const s3Client = new S3Client({
                region: 'auto',
                endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
                credentials: {
                    accessKeyId: R2_ACCESS_KEY_ID!,
                    secretAccessKey: R2_SECRET_ACCESS_KEY!,
                },
            });

            await s3Client.send(new PutObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: fileName,
                Body: buffer,
                ContentType: 'image/jpeg',
                Metadata: {
                    taskId,
                    hustlerId,
                    photoType,
                    uploadedAt: new Date().toISOString(),
                },
            }));

            const url = `${R2_PUBLIC_URL}/${fileName}`;
            serviceLogger.info({ fileName, url, sizeBytes: buffer.length }, 'Photo uploaded to R2');

            return { url, hash, sizeBytes: buffer.length };
        } catch (error) {
            serviceLogger.error({ error, fileName }, 'R2 upload failed');
            return null;
        }
    }

    /**
     * Generate hash for duplicate detection
     */
    private generatePhotoHash(buffer: Buffer): string {
        // Simple hash - take samples from buffer
        const samples: number[] = [];
        const step = Math.floor(buffer.length / 100);
        for (let i = 0; i < buffer.length && samples.length < 100; i += step) {
            samples.push(buffer[i]);
        }
        return samples.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Check for duplicate photo
     */
    checkDuplicate(hash: string, taskId: string): ProofRecord | null {
        for (const [_, record] of proofRecords) {
            if (record.taskId === taskId && record.photoHash === hash) {
                return record;
            }
        }
        return null;
    }

    // ============================================
    // Proof Sessions
    // ============================================

    /**
     * Start a proof session for a task
     */
    startSession(taskId: string, hustlerId: string, category: TaskCategory): ProofSession {
        const sessionId = `proof_${uuidv4()}`;
        const requiredTypes = PROOF_REQUIREMENTS[category] || ['result'];

        const session: ProofSession = {
            sessionId,
            taskId,
            hustlerId,
            category,
            proofs: [],
            attemptCount: 0,
            maxAttempts: 3,
            requiredProofTypes: requiredTypes,
            completedTypes: [],
            status: 'active',
            createdAt: new Date(),
        };

        proofSessions.set(sessionId, session);
        serviceLogger.info({ sessionId, taskId, hustlerId, category }, 'Proof session started');

        return session;
    }

    /**
     * Get or create session for a task
     */
    getOrCreateSession(taskId: string, hustlerId: string, category: TaskCategory): ProofSession {
        // Check for existing active session
        for (const [_, session] of proofSessions) {
            if (session.taskId === taskId && session.hustlerId === hustlerId && session.status === 'active') {
                return session;
            }
        }
        return this.startSession(taskId, hustlerId, category);
    }

    /**
     * Get session by ID
     */
    getSession(sessionId: string): ProofSession | undefined {
        return proofSessions.get(sessionId);
    }

    /**
     * Get session by task ID
     */
    getSessionByTask(taskId: string): ProofSession | undefined {
        for (const [_, session] of proofSessions) {
            if (session.taskId === taskId) {
                return session;
            }
        }
        return undefined;
    }

    // ============================================
    // Proof Submission
    // ============================================

    /**
     * Submit proof with full validation
     */
    async submitProof(submission: ProofSubmission): Promise<{
        success: boolean;
        proof?: ProofRecord;
        session?: ProofSession;
        error?: string;
        verificationStatus: VerificationStatus;
    }> {
        const { taskId, hustlerId, photoData, photoType, gps, caption } = submission;

        // 1. Check rate limit
        const attemptKey = `${taskId}:${hustlerId}`;
        const currentAttempts = taskAttemptCounts.get(attemptKey) || 0;
        if (currentAttempts >= 3) {
            return {
                success: false,
                error: 'Maximum proof attempts (3) exceeded for this task',
                verificationStatus: 'failed',
            };
        }
        taskAttemptCounts.set(attemptKey, currentAttempts + 1);

        // 2. Validate GPS
        const gpsValidation = this.validateGPS(gps);
        if (!gpsValidation.valid) {
            serviceLogger.warn({ taskId, hustlerId, reason: gpsValidation.reason }, 'GPS validation failed');
            return {
                success: false,
                error: gpsValidation.reason,
                verificationStatus: 'failed',
            };
        }

        // 3. Upload photo to R2
        const upload = await this.uploadPhoto(photoData, taskId, hustlerId, photoType);
        if (!upload) {
            return {
                success: false,
                error: 'Failed to upload photo. Please try again.',
                verificationStatus: 'failed',
            };
        }

        // 4. Check for duplicates
        const duplicate = this.checkDuplicate(upload.hash, taskId);
        if (duplicate) {
            return {
                success: false,
                error: 'This photo has already been submitted for this task',
                verificationStatus: 'failed',
            };
        }

        // 5. Get or create session
        // Note: In production, would get category from task
        const session = this.getOrCreateSession(taskId, hustlerId, 'other');
        session.attemptCount++;

        // 6. Create proof record
        const proof: ProofRecord = {
            id: `proof_${uuidv4()}`,
            taskId,
            hustlerId,
            sessionId: session.sessionId,
            photoUrl: upload.url,
            photoType,
            photoHash: upload.hash,
            fileSizeBytes: upload.sizeBytes,
            latitude: gps.latitude,
            longitude: gps.longitude,
            accuracy: gps.accuracy,
            neighborhood: gpsValidation.neighborhood,
            isWithinSeattle: true,
            verificationStatus: 'verified',
            gpsValidated: true,
            photoValidated: true,
            caption,
            xpAwarded: this.calculateXP(photoType),
            createdAt: new Date(),
            verifiedAt: new Date(),
        };

        proofRecords.set(proof.id, proof);
        session.proofs.push(proof);

        // 7. Update completed types
        if (!session.completedTypes.includes(photoType)) {
            session.completedTypes.push(photoType);
        }

        // 8. Check if all required proofs are submitted
        const allRequired = session.requiredProofTypes.every(type =>
            session.completedTypes.includes(type)
        );

        if (allRequired) {
            session.status = 'pending_approval';
            session.submittedAt = new Date();
        }

        proofSessions.set(session.sessionId, session);

        serviceLogger.info({
            proofId: proof.id,
            taskId,
            neighborhood: proof.neighborhood,
            status: session.status,
        }, 'Proof submitted successfully');

        return {
            success: true,
            proof,
            session,
            verificationStatus: proof.verificationStatus,
        };
    }

    /**
     * Calculate XP for proof type
     */
    private calculateXP(photoType: 'before' | 'during' | 'after' | 'result'): number {
        const xpMap = {
            before: 15,
            during: 20,
            after: 35,
            result: 30,
        };
        return xpMap[photoType] || 20;
    }

    // ============================================
    // Poster Approval Flow
    // ============================================

    /**
     * Check if task is ready for approval
     */
    canApprove(taskId: string): { canApprove: boolean; reason?: string; session?: ProofSession } {
        const session = this.getSessionByTask(taskId);

        if (!session) {
            return { canApprove: false, reason: 'No proof session found for this task' };
        }

        if (session.status !== 'pending_approval') {
            return {
                canApprove: false,
                reason: `Session status is '${session.status}', not 'pending_approval'`,
                session,
            };
        }

        const missingTypes = session.requiredProofTypes.filter(
            type => !session.completedTypes.includes(type)
        );

        if (missingTypes.length > 0) {
            return {
                canApprove: false,
                reason: `Missing required proof types: ${missingTypes.join(', ')}`,
                session,
            };
        }

        return { canApprove: true, session };
    }

    /**
     * Poster approves task completion
     * This triggers the real Stripe payout
     */
    async approveTask(
        taskId: string,
        posterId: string,
        options?: { rating?: number; tip?: number; instantPayout?: boolean }
    ): Promise<ApprovalResult> {
        // 1. Verify proof is ready
        const { canApprove, reason, session } = this.canApprove(taskId);
        if (!canApprove || !session) {
            return { success: false, message: reason || 'Cannot approve task', error: reason };
        }

        // 2. Get escrow
        const escrow = StripeService.getEscrow(taskId);
        if (!escrow) {
            return { success: false, message: 'No escrow found for this task', error: 'ESCROW_NOT_FOUND' };
        }

        if (escrow.status !== 'held') {
            return {
                success: false,
                message: `Escrow status is '${escrow.status}', cannot release`,
                error: 'INVALID_ESCROW_STATUS',
            };
        }

        // 3. Verify poster owns the escrow
        if (escrow.posterId !== posterId) {
            return { success: false, message: 'Only task poster can approve', error: 'UNAUTHORIZED' };
        }

        // 4. Release escrow and create payout
        const payoutType = options?.instantPayout ? 'instant' : 'standard';
        const payout = await StripeService.releaseEscrow(taskId, payoutType);

        if (!payout) {
            return { success: false, message: 'Failed to process payout', error: 'PAYOUT_FAILED' };
        }

        // 5. Update session status
        session.status = 'approved';
        session.reviewedAt = new Date();
        proofSessions.set(session.sessionId, session);

        // 6. Log moderation action
        this.logModerationAction({
            userId: posterId,
            contentType: 'task_proof',
            contentId: taskId,
            decision: 'approved',
            reason: `Poster approved completion with ${session.proofs.length} proofs`,
        });

        serviceLogger.info({
            taskId,
            posterId,
            payoutId: payout.id,
            amount: payout.netAmount,
        }, 'Task approved and payout initiated');

        return {
            success: true,
            message: 'Task approved, payout initiated',
            payoutId: payout.id,
            payoutAmount: payout.netAmount,
        };
    }

    /**
     * Poster rejects task completion
     */
    async rejectTask(
        taskId: string,
        posterId: string,
        reason: string,
        action: 'refund' | 'dispute' | 'redo' = 'dispute'
    ): Promise<ApprovalResult> {
        const session = this.getSessionByTask(taskId);
        if (!session) {
            return { success: false, message: 'No proof session found', error: 'SESSION_NOT_FOUND' };
        }

        const escrow = StripeService.getEscrow(taskId);
        if (!escrow) {
            return { success: false, message: 'No escrow found', error: 'ESCROW_NOT_FOUND' };
        }

        if (escrow.posterId !== posterId) {
            return { success: false, message: 'Only task poster can reject', error: 'UNAUTHORIZED' };
        }

        // Update session
        session.status = 'rejected';
        session.reviewedAt = new Date();
        proofSessions.set(session.sessionId, session);

        // Handle action
        if (action === 'refund') {
            const refunded = await StripeService.refundEscrow(taskId, reason);
            if (!refunded) {
                return { success: false, message: 'Failed to process refund', error: 'REFUND_FAILED' };
            }

            // Log moderation
            this.logModerationAction({
                userId: posterId,
                contentType: 'task_proof',
                contentId: taskId,
                decision: 'blocked',
                reason: `Poster rejected: ${reason}`,
            });

            return { success: true, message: 'Task rejected, payment refunded' };
        }

        // Dispute or redo - keep funds in escrow
        this.logModerationAction({
            userId: posterId,
            contentType: 'task_proof',
            contentId: taskId,
            decision: 'suspicious',
            reason: `Dispute initiated: ${reason}`,
        });

        return {
            success: true,
            message: `Task rejected, ${action} initiated. Support will review.`,
        };
    }

    // ============================================
    // Moderation Logging
    // ============================================

    private moderationLogs: {
        id: string;
        userId: string;
        contentType: string;
        contentId?: string;
        decision: string;
        reason?: string;
        createdAt: Date;
    }[] = [];

    /**
     * Log moderation action
     */
    logModerationAction(action: {
        userId: string;
        contentType: string;
        contentId?: string;
        decision: string;
        reason?: string;
    }): void {
        this.moderationLogs.push({
            id: uuidv4(),
            ...action,
            createdAt: new Date(),
        });

        serviceLogger.info(action, 'Moderation action logged');
    }

    /**
     * Get moderation logs for a task
     */
    getModerationLogs(taskId: string): typeof this.moderationLogs {
        return this.moderationLogs.filter(log => log.contentId === taskId);
    }

    // ============================================
    // Queries
    // ============================================

    /**
     * Get all proofs for a task
     */
    getProofsForTask(taskId: string): ProofRecord[] {
        return Array.from(proofRecords.values()).filter(p => p.taskId === taskId);
    }

    /**
     * Get proof by ID
     */
    getProof(proofId: string): ProofRecord | undefined {
        return proofRecords.get(proofId);
    }

    /**
     * Get hustler's proof history
     */
    getHustlerProofs(hustlerId: string, limit = 50): ProofRecord[] {
        return Array.from(proofRecords.values())
            .filter(p => p.hustlerId === hustlerId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, limit);
    }

    /**
     * Get task verification status summary
     */
    getTaskVerificationStatus(taskId: string): {
        hasProofs: boolean;
        proofCount: number;
        gpsVerified: boolean;
        neighborhood?: string;
        status: 'no_proofs' | 'incomplete' | 'pending_approval' | 'approved' | 'rejected' | 'expired';
        requiredTypes: string[];
        completedTypes: string[];
    } {
        const session = this.getSessionByTask(taskId);
        const proofs = this.getProofsForTask(taskId);

        if (!session && proofs.length === 0) {
            return {
                hasProofs: false,
                proofCount: 0,
                gpsVerified: false,
                status: 'no_proofs',
                requiredTypes: [],
                completedTypes: [],
            };
        }

        const gpsVerified = proofs.some(p => p.gpsValidated && p.isWithinSeattle);
        const neighborhood = proofs.find(p => p.neighborhood !== 'Unknown')?.neighborhood;

        return {
            hasProofs: proofs.length > 0,
            proofCount: proofs.length,
            gpsVerified,
            neighborhood,
            status: session?.status === 'active' ? 'incomplete' : (session?.status || 'no_proofs'),
            requiredTypes: session?.requiredProofTypes || [],
            completedTypes: session?.completedTypes || [],
        };
    }
}

export const ProofValidationService = new ProofValidationServiceClass();
