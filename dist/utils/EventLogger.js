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
import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from './logger.js';
// ============================================
// In-memory store (syncs to DB in production)
// ============================================
const eventStore = [];
const MAX_EVENTS = 50000; // Keep last 50k events in memory
// ============================================
// Event Logger Class
// ============================================
class EventLoggerClass {
    /**
     * Log an event
     */
    logEvent(data) {
        const event = {
            id: uuidv4(),
            userId: data.userId,
            taskId: data.taskId,
            eventType: data.eventType,
            source: data.source || 'backend',
            metadata: data.metadata || {},
            createdAt: new Date(),
        };
        eventStore.push(event);
        // Trim if too many events
        if (eventStore.length > MAX_EVENTS) {
            eventStore.shift();
        }
        serviceLogger.debug({
            eventType: event.eventType,
            userId: event.userId,
            taskId: event.taskId,
        }, 'Event logged');
        return event;
    }
    // ============================================
    // Convenience methods for common events
    // ============================================
    taskCreated(taskId, userId, metadata) {
        return this.logEvent({
            eventType: 'task_created',
            taskId,
            userId,
            metadata: { ...metadata },
        });
    }
    taskAccepted(taskId, hustlerId, metadata) {
        return this.logEvent({
            eventType: 'task_accepted',
            taskId,
            userId: hustlerId,
            metadata: { hustlerId, ...metadata },
        });
    }
    taskCompleted(taskId, hustlerId, metadata) {
        return this.logEvent({
            eventType: 'task_completed',
            taskId,
            userId: hustlerId,
            metadata: { hustlerId, ...metadata },
        });
    }
    proofSubmitted(taskId, hustlerId, metadata) {
        return this.logEvent({
            eventType: 'proof_submitted',
            taskId,
            userId: hustlerId,
            metadata: { hustlerId, ...metadata },
        });
    }
    proofApproved(taskId, posterId, metadata) {
        return this.logEvent({
            eventType: 'proof_approved',
            taskId,
            userId: posterId,
            metadata: { posterId, ...metadata },
        });
    }
    proofRejected(taskId, posterId, reason) {
        return this.logEvent({
            eventType: 'proof_rejected',
            taskId,
            userId: posterId,
            metadata: { posterId, reason },
        });
    }
    escrowCreated(taskId, posterId, amount) {
        return this.logEvent({
            eventType: 'escrow_created',
            taskId,
            userId: posterId,
            metadata: { posterId, amount },
        });
    }
    payoutReleased(taskId, hustlerId, amount, payoutId) {
        return this.logEvent({
            eventType: 'payout_released',
            taskId,
            userId: hustlerId,
            metadata: { hustlerId, amount, payoutId },
        });
    }
    payoutRefunded(taskId, posterId, amount) {
        return this.logEvent({
            eventType: 'payout_refunded',
            taskId,
            userId: posterId,
            metadata: { posterId, amount },
        });
    }
    disputeOpened(taskId, posterId, reason, disputeId) {
        return this.logEvent({
            eventType: 'dispute_opened',
            taskId,
            userId: posterId,
            metadata: { posterId, reason, disputeId },
        });
    }
    disputeResolved(taskId, adminId, resolution, disputeId) {
        return this.logEvent({
            eventType: 'dispute_resolved',
            taskId,
            userId: adminId,
            metadata: { adminId, resolution, disputeId },
        });
    }
    aiCall(routeType, provider, latencyMs, success, metadata) {
        return this.logEvent({
            eventType: 'ai_call',
            source: 'ai',
            metadata: { routeType, provider, latencyMs, success, ...metadata },
        });
    }
    xpEarned(userId, amount, source) {
        return this.logEvent({
            eventType: 'xp_earned',
            userId,
            metadata: { amount, source },
        });
    }
    // ============================================
    // Query methods
    // ============================================
    /**
     * Get events with filters
     */
    getEvents(filters) {
        let result = [...eventStore];
        if (filters?.eventType) {
            result = result.filter(e => e.eventType === filters.eventType);
        }
        if (filters?.userId) {
            result = result.filter(e => e.userId === filters.userId);
        }
        if (filters?.taskId) {
            result = result.filter(e => e.taskId === filters.taskId);
        }
        if (filters?.source) {
            result = result.filter(e => e.source === filters.source);
        }
        if (filters?.since) {
            result = result.filter(e => e.createdAt >= filters.since);
        }
        if (filters?.until) {
            result = result.filter(e => e.createdAt <= filters.until);
        }
        result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (filters?.limit) {
            result = result.slice(0, filters.limit);
        }
        return result;
    }
    /**
     * Count events by type
     */
    countByType(since, until) {
        let events = [...eventStore];
        if (since) {
            events = events.filter(e => e.createdAt >= since);
        }
        if (until) {
            events = events.filter(e => e.createdAt <= until);
        }
        return events.reduce((acc, e) => {
            acc[e.eventType] = (acc[e.eventType] || 0) + 1;
            return acc;
        }, {});
    }
    /**
     * Get sample event for documentation
     */
    getSampleEvent() {
        return eventStore[eventStore.length - 1] || null;
    }
}
export const EventLogger = new EventLoggerClass();
//# sourceMappingURL=EventLogger.js.map