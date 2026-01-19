/**
 * Enhanced AI Proof Service
 *
 * Before/After photo workflow with AI verification.
 * - Defines proof requirements per category
 * - Validates photo submissions
 * - AI-powered caption generation
 * - Visual consistency checking
 */
import type { TaskCategory } from '../types/index.js';
export type ProofPhase = 'before' | 'during' | 'after';
export type ProofStatus = 'pending' | 'submitted' | 'verified' | 'rejected';
export interface ProofRequirement {
    phase: ProofPhase;
    description: string;
    required: boolean;
    exampleCaption: string;
}
export interface PhotoSubmission {
    id: string;
    taskId: string;
    userId: string;
    phase: ProofPhase;
    photoUrl: string;
    caption?: string;
    aiGeneratedCaption?: string;
    submittedAt: Date;
    status: ProofStatus;
    verificationNotes?: string;
}
export interface ProofWorkflow {
    taskId: string;
    category: TaskCategory;
    requirements: ProofRequirement[];
    submissions: PhotoSubmission[];
    isComplete: boolean;
    completionPercent: number;
}
export interface VerificationResult {
    isValid: boolean;
    confidence: number;
    issues: string[];
    suggestions: string[];
    consistencyScore: number;
}
declare class EnhancedAIProofServiceClass {
    /**
     * Initialize proof workflow for a task
     */
    initializeWorkflow(taskId: string, category: TaskCategory): ProofWorkflow;
    /**
     * Get workflow for a task
     */
    getWorkflow(taskId: string): ProofWorkflow | null;
    /**
     * Get proof requirements for a category
     */
    getRequirements(category: TaskCategory): ProofRequirement[];
    /**
     * Submit a proof photo
     */
    submitPhoto(taskId: string, userId: string, phase: ProofPhase, photoUrl: string, userCaption?: string): Promise<PhotoSubmission>;
    /**
     * Generate AI caption for a photo based on category and phase
     */
    generateCaption(category: TaskCategory, phase: ProofPhase): Promise<string>;
    /**
     * Verify before/after photo consistency
     */
    verifyConsistency(taskId: string): Promise<VerificationResult>;
    /**
     * Get all submissions for a task
     */
    getSubmissions(taskId: string): PhotoSubmission[];
    /**
     * Get submission by ID
     */
    getSubmission(submissionId: string): PhotoSubmission | null;
    /**
     * Update completion status of workflow
     */
    private updateCompletionStatus;
    /**
     * Get proof instructions for app UI
     */
    getProofInstructions(category: TaskCategory): {
        title: string;
        steps: {
            phase: ProofPhase;
            instruction: string;
            required: boolean;
        }[];
    };
    /**
     * Attach verified proofs to user profile
     */
    attachToProfile(userId: string, taskId: string): {
        proofCount: number;
        categories: TaskCategory[];
    };
}
export declare const EnhancedAIProofService: EnhancedAIProofServiceClass;
export {};
//# sourceMappingURL=EnhancedAIProofService.d.ts.map