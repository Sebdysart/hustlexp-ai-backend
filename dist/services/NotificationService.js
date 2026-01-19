/**
 * Notification Service - Phase F
 *
 * Email + Push notifications for:
 * - Task lifecycle events
 * - Payout events
 * - Dispute events
 * - Account events
 */
import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
// ============================================
// In-memory store (syncs to DB)
// ============================================
const notifications = [];
const userEmails = new Map(); // userId -> email (stub)
// ============================================
// Email Templates
// ============================================
const EMAIL_TEMPLATES = {
    task_accepted: {
        subject: '🎉 Your task was accepted!',
        body: (p) => `Great news! ${p.hustlerName || 'A hustler'} accepted your task "${p.taskTitle}". They'll get started soon.`,
    },
    task_completed: {
        subject: '✅ Task completed!',
        body: (p) => `"${p.taskTitle}" has been marked complete. Please review the proof and approve.`,
    },
    task_cancelled: {
        subject: '❌ Task cancelled',
        body: (p) => `The task "${p.taskTitle}" has been cancelled.`,
    },
    proof_submitted: {
        subject: '📸 Proof submitted for your task',
        body: (p) => `Proof has been submitted for "${p.taskTitle}". Please review and approve or reject.`,
    },
    proof_approved: {
        subject: '✅ Your proof was approved!',
        body: (p) => `Your proof for "${p.taskTitle}" was approved. Payout is on the way!`,
    },
    proof_rejected: {
        subject: '❌ Proof needs revision',
        body: (p) => `Your proof for "${p.taskTitle}" was not approved. Reason: ${p.reason || 'Not specified'}`,
    },
    payout_sent: {
        subject: '💰 Payout sent!',
        body: (p) => `$${p.amount} has been sent to your account for "${p.taskTitle}". It should arrive in 1-2 business days.`,
    },
    payout_failed: {
        subject: '⚠️ Payout failed',
        body: (p) => `We couldn't process your payout for "${p.taskTitle}". Please check your account details.`,
    },
    dispute_opened: {
        subject: '⚠️ Dispute opened',
        body: (p) => `A dispute has been opened for "${p.taskTitle}". We'll review and get back to you soon.`,
    },
    dispute_resolved: {
        subject: '✅ Dispute resolved',
        body: (p) => `The dispute for "${p.taskTitle}" has been resolved. Resolution: ${p.resolution}`,
    },
    account_suspended: {
        subject: '🚫 Account suspended',
        body: (p) => `Your account has been suspended. Reason: ${p.reason}. If you believe this is an error, contact support.`,
    },
    account_unsuspended: {
        subject: '✅ Account restored',
        body: (p) => `Your account has been restored. Welcome back to HustleXP!`,
    },
    welcome: {
        subject: '🎉 Welcome to HustleXP!',
        body: (p) => `Welcome to HustleXP, ${p.name || 'hustler'}! You're ready to start earning in Seattle.`,
    },
    streak_warning: {
        subject: '🔥 Don\'t lose your streak!',
        body: (p) => `You have a ${p.days}-day streak going. Complete a task today to keep it alive!`,
    },
    golden_hour: {
        subject: '⚡ Golden Hour is live!',
        body: (p) => `It's golden hour! Tasks completed now earn ${p.boost || '30%'} extra.`,
    },
    weekly_recap: {
        subject: '📊 Your weekly recap',
        body: (p) => `This week: ${p.tasksCompleted || 0} tasks, $${p.earned || 0} earned, ${p.xpGained || 0} XP gained.`,
    },
};
// ============================================
// Notification Service Class
// ============================================
class NotificationServiceClass {
    // ============================================
    // Send Notifications
    // ============================================
    /**
     * Enqueue an email notification
     */
    enqueueEmail(userId, type, payload = {}) {
        const notification = this.createNotification(userId, type, 'email', payload);
        // In production, this would queue for async sending
        this.processEmailAsync(notification);
        return notification;
    }
    /**
     * Enqueue a push notification
     */
    enqueuePush(userId, type, payload = {}) {
        const notification = this.createNotification(userId, type, 'push', payload);
        // In production, this would send to Firebase/APNs
        this.processPushAsync(notification);
        return notification;
    }
    /**
     * Create notification record
     */
    createNotification(userId, type, channel, payload) {
        const notification = {
            id: `notif_${uuidv4()}`,
            userId,
            type,
            channel,
            payload,
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        notifications.push(notification);
        // Keep last 10000 notifications
        if (notifications.length > 10000) {
            notifications.shift();
        }
        return notification;
    }
    /**
     * Process email asynchronously (stub)
     */
    async processEmailAsync(notification) {
        try {
            const template = EMAIL_TEMPLATES[notification.type];
            const email = userEmails.get(notification.userId) || 'user@example.com';
            const emailPayload = {
                to: email,
                subject: template.subject,
                textBody: template.body(notification.payload),
            };
            // In production: await EmailService.send(emailPayload)
            serviceLogger.info({
                notificationId: notification.id,
                type: notification.type,
                to: email,
            }, 'Email would be sent');
            notification.status = 'sent';
            notification.updatedAt = new Date();
        }
        catch (error) {
            notification.status = 'failed';
            notification.error = error instanceof Error ? error.message : 'Unknown error';
            notification.updatedAt = new Date();
            serviceLogger.error({ error, notificationId: notification.id }, 'Email send failed');
        }
    }
    /**
     * Process push notification asynchronously (stub)
     */
    async processPushAsync(notification) {
        try {
            // In production: await PushService.sendToUser(notification.userId, ...)
            serviceLogger.info({
                notificationId: notification.id,
                type: notification.type,
                userId: notification.userId,
            }, 'Push would be sent');
            notification.status = 'sent';
            notification.updatedAt = new Date();
        }
        catch (error) {
            notification.status = 'failed';
            notification.error = error instanceof Error ? error.message : 'Unknown error';
            notification.updatedAt = new Date();
        }
    }
    // ============================================
    // Event Triggers (Wire into flows)
    // ============================================
    /**
     * Notify when task is accepted
     */
    onTaskAccepted(posterId, hustlerName, taskTitle, taskId) {
        this.enqueueEmail(posterId, 'task_accepted', { hustlerName, taskTitle, taskId });
        this.enqueuePush(posterId, 'task_accepted', { taskTitle });
    }
    /**
     * Notify when proof is submitted
     */
    onProofSubmitted(posterId, taskTitle, taskId) {
        this.enqueueEmail(posterId, 'proof_submitted', { taskTitle, taskId });
        this.enqueuePush(posterId, 'proof_submitted', { taskTitle });
    }
    /**
     * Notify when proof is approved and payout sent
     */
    onPayoutSent(hustlerId, amount, taskTitle) {
        this.enqueueEmail(hustlerId, 'payout_sent', { amount, taskTitle });
        this.enqueuePush(hustlerId, 'payout_sent', { amount, taskTitle });
    }
    /**
     * Notify when dispute is opened
     */
    onDisputeOpened(posterId, hustlerId, taskTitle, disputeId) {
        this.enqueueEmail(posterId, 'dispute_opened', { taskTitle, disputeId });
        this.enqueueEmail(hustlerId, 'dispute_opened', { taskTitle, disputeId });
    }
    /**
     * Notify when dispute is resolved
     */
    onDisputeResolved(posterId, hustlerId, taskTitle, resolution) {
        this.enqueueEmail(posterId, 'dispute_resolved', { taskTitle, resolution });
        this.enqueueEmail(hustlerId, 'dispute_resolved', { taskTitle, resolution });
    }
    /**
     * Notify when user is suspended
     */
    onUserSuspended(userId, reason) {
        this.enqueueEmail(userId, 'account_suspended', { reason });
    }
    /**
     * Notify when user is unsuspended
     */
    onUserUnsuspended(userId) {
        this.enqueueEmail(userId, 'account_unsuspended', {});
    }
    // ============================================
    // Queries
    // ============================================
    /**
     * Get notifications for a user
     */
    getNotifications(userId, options) {
        let result = notifications.filter(n => n.userId === userId);
        if (options?.status) {
            result = result.filter(n => n.status === options.status);
        }
        result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (options?.limit) {
            result = result.slice(0, options.limit);
        }
        return result;
    }
    /**
     * Get all notifications (admin)
     */
    getAllNotifications(options) {
        let result = [...notifications];
        if (options?.type) {
            result = result.filter(n => n.type === options.type);
        }
        if (options?.status) {
            result = result.filter(n => n.status === options.status);
        }
        result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (options?.limit) {
            result = result.slice(0, options.limit);
        }
        return result;
    }
    /**
     * Get notification stats
     */
    getStats() {
        const byStatus = notifications.reduce((acc, n) => {
            acc[n.status] = (acc[n.status] || 0) + 1;
            return acc;
        }, {});
        const byType = notifications.reduce((acc, n) => {
            acc[n.type] = (acc[n.type] || 0) + 1;
            return acc;
        }, {});
        return {
            total: notifications.length,
            pending: byStatus['pending'] || 0,
            sent: byStatus['sent'] || 0,
            failed: byStatus['failed'] || 0,
            byType,
        };
    }
    /**
     * Get sample notification row
     */
    getSampleRow() {
        return {
            id: 'notif_sample123',
            userId: 'user_456',
            type: 'payout_sent',
            channel: 'email',
            payload: { amount: 45.50, taskTitle: 'Dog walking in Capitol Hill' },
            status: 'sent',
            createdAt: new Date(),
            updatedAt: new Date(),
        };
    }
    /**
     * Register user email (for development)
     */
    registerEmail(userId, email) {
        userEmails.set(userId, email);
    }
}
export const NotificationService = new NotificationServiceClass();
//# sourceMappingURL=NotificationService.js.map