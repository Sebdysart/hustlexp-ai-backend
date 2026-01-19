/**
 * Event Logger - Phase D
 *
 * Unified event logging for all key actions:
 * - Task lifecycle (created, accepted, completed)
 * - Proof lifecycle (submitted, approved, rejected)
 * - Payout lifecycle (released, refunded)
 * - Disputes (opened, resolved)
 * - AI calls
 * - User actions (login, signup)
 */
export type EventType = 'task_created' | 'task_accepted' | 'task_started' | 'task_completed' | 'task_cancelled' | 'proof_submitted' | 'proof_approved' | 'proof_rejected' | 'proof_session_started' | 'escrow_created' | 'payout_released' | 'payout_refunded' | 'payout_failed' | 'dispute_opened' | 'dispute_responded' | 'dispute_resolved' | 'user_signup' | 'user_login' | 'profile_updated' | 'content_flagged' | 'content_blocked' | 'user_suspended' | 'strike_added' | 'ai_call' | 'ai_orchestrate' | 'xp_earned' | 'level_up' | 'badge_unlocked' | 'streak_updated' | 'custom';
export type EventSource = 'frontend' | 'backend' | 'ai';
export interface EventData {
    userId?: string;
    taskId?: string;
    eventType: EventType;
    source?: EventSource;
    metadata?: Record<string, unknown>;
}
export interface EventRecord {
    id: string;
    userId?: string;
    taskId?: string;
    eventType: EventType;
    source: EventSource;
    metadata: Record<string, unknown>;
    createdAt: Date;
}
declare class EventLoggerClass {
    /**
     * Log an event
     */
    logEvent(data: EventData): EventRecord;
    taskCreated(taskId: string, userId: string, metadata?: Record<string, unknown>): EventRecord;
    taskAccepted(taskId: string, hustlerId: string, metadata?: Record<string, unknown>): EventRecord;
    taskCompleted(taskId: string, hustlerId: string, metadata?: Record<string, unknown>): EventRecord;
    proofSubmitted(taskId: string, hustlerId: string, metadata?: Record<string, unknown>): EventRecord;
    proofApproved(taskId: string, posterId: string, metadata?: Record<string, unknown>): EventRecord;
    proofRejected(taskId: string, posterId: string, reason: string): EventRecord;
    escrowCreated(taskId: string, posterId: string, amount: number): EventRecord;
    payoutReleased(taskId: string, hustlerId: string, amount: number, payoutId: string): EventRecord;
    payoutRefunded(taskId: string, posterId: string, amount: number): EventRecord;
    disputeOpened(taskId: string, posterId: string, reason: string, disputeId: string): EventRecord;
    disputeResolved(taskId: string, adminId: string, resolution: string, disputeId: string): EventRecord;
    aiCall(routeType: string, provider: string, latencyMs: number, success: boolean, metadata?: Record<string, unknown>): EventRecord;
    xpEarned(userId: string, amount: number, source: string): EventRecord;
    /**
     * Get events with filters
     */
    getEvents(filters?: {
        eventType?: EventType;
        userId?: string;
        taskId?: string;
        source?: EventSource;
        since?: Date;
        until?: Date;
        limit?: number;
    }): EventRecord[];
    /**
     * Count events by type
     */
    countByType(since?: Date, until?: Date): Record<EventType, number>;
    /**
     * Get sample event for documentation
     */
    getSampleEvent(): EventRecord | null;
}
export declare const EventLogger: EventLoggerClass;
export {};
//# sourceMappingURL=EventLogger.d.ts.map