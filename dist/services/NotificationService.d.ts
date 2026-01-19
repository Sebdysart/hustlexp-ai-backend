/**
 * Notification Service - Phase F
 *
 * Email + Push notifications for:
 * - Task lifecycle events
 * - Payout events
 * - Dispute events
 * - Account events
 */
export type NotificationType = 'task_accepted' | 'task_completed' | 'task_cancelled' | 'proof_submitted' | 'proof_approved' | 'proof_rejected' | 'payout_sent' | 'payout_failed' | 'dispute_opened' | 'dispute_resolved' | 'account_suspended' | 'account_unsuspended' | 'welcome' | 'streak_warning' | 'golden_hour' | 'weekly_recap';
export type NotificationChannel = 'email' | 'push' | 'sms';
export type NotificationStatus = 'pending' | 'sent' | 'failed';
export interface Notification {
    id: string;
    userId: string;
    type: NotificationType;
    channel: NotificationChannel;
    payload: Record<string, unknown>;
    status: NotificationStatus;
    error?: string;
    createdAt: Date;
    updatedAt: Date;
}
export interface EmailPayload {
    to: string;
    subject: string;
    textBody: string;
    htmlBody?: string;
}
declare class NotificationServiceClass {
    /**
     * Enqueue an email notification
     */
    enqueueEmail(userId: string, type: NotificationType, payload?: Record<string, unknown>): Notification;
    /**
     * Enqueue a push notification
     */
    enqueuePush(userId: string, type: NotificationType, payload?: Record<string, unknown>): Notification;
    /**
     * Create notification record
     */
    private createNotification;
    /**
     * Process email asynchronously (stub)
     */
    private processEmailAsync;
    /**
     * Process push notification asynchronously (stub)
     */
    private processPushAsync;
    /**
     * Notify when task is accepted
     */
    onTaskAccepted(posterId: string, hustlerName: string, taskTitle: string, taskId: string): void;
    /**
     * Notify when proof is submitted
     */
    onProofSubmitted(posterId: string, taskTitle: string, taskId: string): void;
    /**
     * Notify when proof is approved and payout sent
     */
    onPayoutSent(hustlerId: string, amount: number, taskTitle: string): void;
    /**
     * Notify when dispute is opened
     */
    onDisputeOpened(posterId: string, hustlerId: string, taskTitle: string, disputeId: string): void;
    /**
     * Notify when dispute is resolved
     */
    onDisputeResolved(posterId: string, hustlerId: string, taskTitle: string, resolution: string): void;
    /**
     * Notify when user is suspended
     */
    onUserSuspended(userId: string, reason: string): void;
    /**
     * Notify when user is unsuspended
     */
    onUserUnsuspended(userId: string): void;
    /**
     * Get notifications for a user
     */
    getNotifications(userId: string, options?: {
        limit?: number;
        status?: NotificationStatus;
    }): Notification[];
    /**
     * Get all notifications (admin)
     */
    getAllNotifications(options?: {
        type?: NotificationType;
        status?: NotificationStatus;
        limit?: number;
    }): Notification[];
    /**
     * Get notification stats
     */
    getStats(): {
        total: number;
        pending: number;
        sent: number;
        failed: number;
        byType: Record<string, number>;
    };
    /**
     * Get sample notification row
     */
    getSampleRow(): Notification;
    /**
     * Register user email (for development)
     */
    registerEmail(userId: string, email: string): void;
}
export declare const NotificationService: NotificationServiceClass;
export {};
//# sourceMappingURL=NotificationService.d.ts.map