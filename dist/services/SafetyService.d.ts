/**
 * Safety Service - Phase C
 *
 * Content moderation for:
 * - Task creation
 * - Proof submission
 * - Chat messages
 * - Profile content
 *
 * Uses AI (Groq fast check → GPT-4o deep check) for risk assessment
 */
export type ContentType = 'task_creation' | 'proof' | 'chat' | 'profile' | 'dispute';
export type ModerationSeverity = 'info' | 'warn' | 'critical';
export type ModerationAction = 'none' | 'auto_blocked' | 'auto_flagged' | 'suspended' | 'manual_review';
export type RiskLabel = 'safe' | 'possible_scam' | 'harassment' | 'self_harm' | 'policy_violation' | 'illegal_activity' | 'hate_speech' | 'explicit_content' | 'spam' | 'contact_outside_platform';
export interface ModerationResult {
    allowed: boolean;
    riskScore: number;
    label: RiskLabel;
    severity: ModerationSeverity;
    action: ModerationAction;
    reason?: string;
}
export interface ModerationLog {
    id: string;
    userId?: string;
    taskId?: string;
    type: ContentType;
    severity: ModerationSeverity;
    label: RiskLabel;
    rawInputSnippet: string;
    aiModelUsed: string;
    aiScore: number;
    actionTaken: ModerationAction;
    createdAt: Date;
}
declare class SafetyServiceClass {
    /**
     * Moderate content before allowing action
     */
    moderateContent(content: string, type: ContentType, userId?: string, taskId?: string, options?: {
        category?: string;
        skipAI?: boolean;
    }): Promise<ModerationResult>;
    /**
     * Quick local pattern-based check
     */
    private localPatternCheck;
    /**
     * Get risk label from pattern match
     */
    private getLabelFromPattern;
    /**
     * AI-powered moderation check (Groq for speed)
     */
    private aiModerationCheck;
    /**
     * Log moderation result
     */
    private logModerationResult;
    /**
     * Moderate task creation
     */
    moderateTaskCreation(title: string, description: string, category: string, userId: string): Promise<ModerationResult>;
    /**
     * Moderate proof submission caption
     */
    moderateProof(caption: string, hustlerId: string, taskId: string): Promise<ModerationResult>;
    /**
     * Moderate chat message (stub for future)
     */
    moderateChat(message: string, userId: string, taskId?: string): Promise<ModerationResult>;
    /**
     * Moderate profile content
     */
    moderateProfile(bio: string, userId: string): Promise<ModerationResult>;
    /**
     * Get moderation logs with filters
     */
    getModerationLogs(filters?: {
        userId?: string;
        taskId?: string;
        type?: ContentType;
        severity?: ModerationSeverity;
        limit?: number;
    }): ModerationLog[];
    /**
     * Get moderation stats
     */
    getStats(): {
        total: number;
        blocked: number;
        flagged: number;
        byType: Record<string, number>;
        bySeverity: Record<string, number>;
    };
}
export declare const SafetyService: SafetyServiceClass;
export {};
//# sourceMappingURL=SafetyService.d.ts.map