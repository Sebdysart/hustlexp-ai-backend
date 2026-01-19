import type { TaskCategory } from '../types/index.js';
export type ProofType = 'before' | 'during' | 'after' | 'handoff' | 'result' | 'safety';
export type ProofStatus = 'pending' | 'submitted' | 'verified' | 'rejected';
export type AnimationType = 'confetti' | 'xp_burst' | 'badge_unlock' | 'progress_fill' | 'streak_fire' | 'level_up' | 'sparkle';
export interface ProofRequirement {
    id: string;
    type: ProofType;
    title: string;
    prompt: string;
    xpReward: number;
    required: boolean;
    order: number;
    triggerAt: 'start' | 'middle' | 'end' | 'manual';
    triggerAfterMinutes?: number;
}
export interface SubmittedProof {
    id: string;
    requirementId: string;
    taskId: string;
    hustlerId: string;
    type: ProofType;
    photoUrl: string;
    caption?: string;
    status: ProofStatus;
    xpAwarded: number;
    submittedAt: Date;
    verifiedAt?: Date;
    animations: AnimationType[];
    trustPointsEarned: number;
    badgeProgress?: {
        badge: string;
        current: number;
        max: number;
    };
}
export interface ProofSession {
    sessionId: string;
    taskId: string;
    hustlerId: string;
    category: TaskCategory;
    requirements: ProofRequirement[];
    proofs: SubmittedProof[];
    completedCount: number;
    totalRequired: number;
    progressPercent: number;
    totalXPEarned: number;
    trustScoreBonus: number;
    status: 'active' | 'complete' | 'expired';
    createdAt: Date;
    completedAt?: Date;
}
export interface TrustProfile {
    hustlerId: string;
    trustScore: number;
    verifiedProofCount: number;
    proofStreak: number;
    badges: string[];
    recentProofs: {
        photoUrl: string;
        category: string;
        submittedAt: Date;
    }[];
    categoryProofs: Record<string, number>;
}
declare class AIProofServiceClass {
    /**
     * Start a proof session for a task
     */
    startProofSession(taskId: string, hustlerId: string, category: TaskCategory): ProofSession;
    /**
     * Get proof requirements for a category
     */
    getProofRequirements(category: TaskCategory): ProofRequirement[];
    /**
     * Get AI prompt for next required proof
     */
    getNextProofPrompt(sessionId: string): {
        requirement: ProofRequirement | null;
        prompt: string;
        xpReward: number;
        isRequired: boolean;
        progress: {
            completed: number;
            total: number;
            percent: number;
        };
    } | null;
    /**
     * Submit a proof photo
     */
    submitProof(sessionId: string, requirementId: string, photoUrl: string, caption?: string): Promise<{
        proof: SubmittedProof;
        session: ProofSession;
        animations: AnimationType[];
        xpAwarded: number;
        trustBonus: number;
        message: string;
        nextPrompt: string | null;
    }>;
    /**
     * Calculate animations based on context
     */
    private calculateAnimations;
    /**
     * Calculate trust points for proof
     */
    private calculateTrustPoints;
    /**
     * Get badge progress for category
     */
    private getBadgeProgress;
    /**
     * Update trust profile with new proof
     */
    private updateTrustProfile;
    /**
     * Add proof to feed
     */
    private addToProofFeed;
    /**
     * Get trust profile
     */
    getTrustProfile(hustlerId: string): TrustProfile | null;
    /**
     * Get proof feed for hustler
     */
    getProofFeed(hustlerId: string, limit?: number): SubmittedProof[];
    /**
     * Get proof session
     */
    getSession(sessionId: string): ProofSession | null;
    /**
     * Get proof session by taskId
     */
    getSessionByTaskId(taskId: string): ProofSession | null;
    /**
     * Get live task card update (for client view)
     */
    getLiveTaskUpdate(taskId: string): {
        proofs: {
            type: ProofType;
            photoUrl: string;
            submittedAt: Date;
            verified: boolean;
        }[];
        progressPercent: number;
        status: string;
        lastUpdate: Date | null;
        isVerified: boolean;
    } | null;
}
export declare const AIProofService: AIProofServiceClass;
export {};
//# sourceMappingURL=AIProofService.d.ts.map