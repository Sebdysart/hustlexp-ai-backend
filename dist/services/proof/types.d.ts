/**
 * PROOF ENGINE — TYPES & ENUMS
 *
 * Core type definitions for the proof system.
 * Proofs are append-only and immutable once locked.
 */
export declare enum ProofState {
    NONE = "none",
    REQUESTED = "requested",
    SUBMITTED = "submitted",
    ANALYZING = "analyzing",
    VERIFIED = "verified",
    REJECTED = "rejected",
    ESCALATED = "escalated",
    LOCKED = "locked"
}
export declare enum ProofType {
    PHOTO = "photo",
    SCREENSHOT = "screenshot",
    VIDEO = "video"
}
export declare enum ProofReason {
    TASK_COMPLETION = "task_completion",
    LOCATION_CONFIRMATION = "location_confirmation",
    DAMAGE_EVIDENCE = "damage_evidence",
    SCREEN_STATE = "screen_state",
    BEFORE_AFTER = "before_after",
    IDENTITY_VERIFICATION = "identity_verification"
}
export interface ProofRequest {
    id: string;
    taskId: string;
    proofType: ProofType;
    reason: ProofReason;
    requestedBy: 'ai' | 'system' | 'poster';
    instructions: string;
    state: ProofState;
    deadline?: Date;
    createdAt: Date;
    updatedAt: Date;
}
export interface ProofSubmission {
    id: string;
    requestId: string;
    taskId: string;
    submittedBy: string;
    fileUrl: string;
    fileHash: string;
    mimeType: string;
    fileSize: number;
    metadata: ProofMetadata;
    forensicsResult?: ForensicsResult;
    state: ProofState;
    createdAt: Date;
    lockedAt?: Date;
}
export interface ProofMetadata {
    exifPresent: boolean;
    exifData?: Record<string, any>;
    cameraModel?: string;
    captureTimestamp?: Date;
    gpsCoordinates?: {
        lat: number;
        lng: number;
    };
    resolution: {
        width: number;
        height: number;
    };
    fileFormat: string;
}
export interface ForensicsResult {
    confidenceScore: number;
    likelyScreenshot: boolean;
    likelyAIGenerated: boolean;
    likelyEdited: boolean;
    anomalies: string[];
    signals: ForensicsSignal[];
    analyzedAt: Date;
}
export interface ForensicsSignal {
    name: string;
    value: any;
    weight: number;
    suspicious: boolean;
}
export interface ProofEvent {
    id: string;
    proofRequestId?: string;
    proofSubmissionId?: string;
    taskId: string;
    eventType: ProofEventType;
    actor: string;
    actorType: 'ai' | 'user' | 'system' | 'admin';
    details: Record<string, any>;
    createdAt: Date;
}
export declare enum ProofEventType {
    REQUEST_CREATED = "request_created",
    REQUEST_EXPIRED = "request_expired",
    SUBMISSION_RECEIVED = "submission_received",
    ANALYSIS_STARTED = "analysis_started",
    ANALYSIS_COMPLETED = "analysis_completed",
    VERIFIED = "verified",
    REJECTED = "rejected",
    ESCALATED = "escalated",
    LOCKED = "locked",
    ADMIN_OVERRIDE = "admin_override"
}
export declare const PROOF_TRANSITIONS: Record<ProofState, ProofState[]>;
export declare function canTransition(from: ProofState, to: ProofState): boolean;
//# sourceMappingURL=types.d.ts.map