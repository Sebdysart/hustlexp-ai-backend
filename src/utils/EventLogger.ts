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
// Types
// ============================================

export type EventType =
    // Task lifecycle
    | 'task_created'
    | 'task_accepted'
    | 'task_started'
    | 'task_completed'
    | 'task_cancelled'
    // Proof lifecycle
    | 'proof_submitted'
    | 'proof_approved'
    | 'proof_rejected'
    | 'proof_session_started'
    // Payout lifecycle
    | 'escrow_created'
    | 'payout_released'
    | 'payout_refunded'
    | 'payout_failed'
    // Disputes
    | 'dispute_opened'
    | 'dispute_responded'
    | 'dispute_resolved'
    // User actions
    | 'user_signup'
    | 'user_login'
    | 'profile_updated'
    // Moderation
    | 'content_flagged'
    | 'content_blocked'
    | 'user_suspended'
    | 'strike_added'
    // AI
    | 'ai_call'
    | 'ai_orchestrate'
    // XP & Gamification
    | 'xp_earned'
    | 'level_up'
    | 'badge_unlocked'
    | 'streak_updated'
    // Generic
    | 'custom';

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

// ============================================
// In-memory store (syncs to DB in production)
// ============================================

const eventStore: EventRecord[] = [];
const MAX_EVENTS = 50000; // Keep last 50k events in memory

// ============================================
// Event Logger Class
// ============================================

class EventLoggerClass {
    /**
     * Log an event
     */
    logEvent(data: EventData): EventRecord {
        const event: EventRecord = {
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

    taskCreated(taskId: string, userId: string, metadata?: Record<string, unknown>): EventRecord {
        return this.logEvent({
            eventType: 'task_created',
            taskId,
            userId,
            metadata: { ...metadata },
        });
    }

    taskAccepted(taskId: string, hustlerId: string, metadata?: Record<string, unknown>): EventRecord {
        return this.logEvent({
            eventType: 'task_accepted',
            taskId,
            userId: hustlerId,
            metadata: { hustlerId, ...metadata },
        });
    }

    taskCompleted(taskId: string, hustlerId: string, metadata?: Record<string, unknown>): EventRecord {
        return this.logEvent({
            eventType: 'task_completed',
            taskId,
            userId: hustlerId,
            metadata: { hustlerId, ...metadata },
        });
    }

    proofSubmitted(taskId: string, hustlerId: string, metadata?: Record<string, unknown>): EventRecord {
        return this.logEvent({
            eventType: 'proof_submitted',
            taskId,
            userId: hustlerId,
            metadata: { hustlerId, ...metadata },
        });
    }

    proofApproved(taskId: string, posterId: string, metadata?: Record<string, unknown>): EventRecord {
        return this.logEvent({
            eventType: 'proof_approved',
            taskId,
            userId: posterId,
            metadata: { posterId, ...metadata },
        });
    }

    proofRejected(taskId: string, posterId: string, reason: string): EventRecord {
        return this.logEvent({
            eventType: 'proof_rejected',
            taskId,
            userId: posterId,
            metadata: { posterId, reason },
        });
    }

    escrowCreated(taskId: string, posterId: string, amount: number): EventRecord {
        return this.logEvent({
            eventType: 'escrow_created',
            taskId,
            userId: posterId,
            metadata: { posterId, amount },
        });
    }

    payoutReleased(taskId: string, hustlerId: string, amount: number, payoutId: string): EventRecord {
        return this.logEvent({
            eventType: 'payout_released',
            taskId,
            userId: hustlerId,
            metadata: { hustlerId, amount, payoutId },
        });
    }

    payoutRefunded(taskId: string, posterId: string, amount: number): EventRecord {
        return this.logEvent({
            eventType: 'payout_refunded',
            taskId,
            userId: posterId,
            metadata: { posterId, amount },
        });
    }

    disputeOpened(taskId: string, posterId: string, reason: string, disputeId: string): EventRecord {
        return this.logEvent({
            eventType: 'dispute_opened',
            taskId,
            userId: posterId,
            metadata: { posterId, reason, disputeId },
        });
    }

    disputeResolved(taskId: string, adminId: string, resolution: string, disputeId: string): EventRecord {
        return this.logEvent({
            eventType: 'dispute_resolved',
            taskId,
            userId: adminId,
            metadata: { adminId, resolution, disputeId },
        });
    }

    aiCall(routeType: string, provider: string, latencyMs: number, success: boolean, metadata?: Record<string, unknown>): EventRecord {
        return this.logEvent({
            eventType: 'ai_call',
            source: 'ai',
            metadata: { routeType, provider, latencyMs, success, ...metadata },
        });
    }

    xpEarned(userId: string, amount: number, source: string): EventRecord {
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
    getEvents(filters?: {
        eventType?: EventType;
        userId?: string;
        taskId?: string;
        source?: EventSource;
        since?: Date;
        until?: Date;
        limit?: number;
    }): EventRecord[] {
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
            result = result.filter(e => e.createdAt >= filters.since!);
        }
        if (filters?.until) {
            result = result.filter(e => e.createdAt <= filters.until!);
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
    countByType(since?: Date, until?: Date): Record<EventType, number> {
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
        }, {} as Record<EventType, number>);
    }

    /**
     * Get sample event for documentation
     */
    getSampleEvent(): EventRecord | null {
        return eventStore[eventStore.length - 1] || null;
    }
}

export const EventLogger = new EventLoggerClass();
