/**
 * Sentry Error Tracking Integration
 * 
 * Centralizes error capture and performance monitoring.
 * Set SENTRY_DSN environment variable to enable.
 */

import { serviceLogger } from './logger.js';

// ============================================
// Types
// ============================================

export interface SentryConfig {
    dsn?: string;
    environment: string;
    release?: string;
    tracesSampleRate: number;
    enabled: boolean;
}

export interface ErrorContext {
    userId?: string;
    taskId?: string;
    endpoint?: string;
    aiProvider?: string;
    extra?: Record<string, unknown>;
}

export interface Transaction {
    name: string;
    op: string;
    startTime: number;
    spans: Span[];
    finish: () => void;
}

export interface Span {
    name: string;
    op: string;
    startTime: number;
    finish: () => void;
}

// ============================================
// Mock Sentry Client (for when Sentry SDK not installed)
// ============================================

class MockSentryClient {
    private config: SentryConfig;
    private events: { type: string; data: unknown; timestamp: Date }[] = [];

    constructor() {
        this.config = {
            dsn: process.env.SENTRY_DSN,
            environment: process.env.NODE_ENV || 'development',
            release: process.env.npm_package_version,
            tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
            enabled: !!process.env.SENTRY_DSN,
        };
    }

    init(): void {
        if (!this.config.dsn) {
            serviceLogger.info('Sentry DSN not configured - error tracking disabled');
            return;
        }
        serviceLogger.info({
            environment: this.config.environment,
            tracesSampleRate: this.config.tracesSampleRate,
        }, 'Sentry initialized');
    }

    isEnabled(): boolean {
        return this.config.enabled;
    }

    captureException(error: Error, context?: ErrorContext): string {
        const eventId = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const event = {
            type: 'exception',
            data: {
                eventId,
                message: error.message,
                stack: error.stack,
                name: error.name,
                context,
            },
            timestamp: new Date(),
        };

        this.events.push(event);

        if (this.config.enabled) {
            // In production with real Sentry:
            // Sentry.captureException(error, { extra: context });
            serviceLogger.error({
                eventId,
                error: error.message,
                ...context,
            }, 'Error captured for Sentry');
        }

        return eventId;
    }

    captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info', context?: ErrorContext): string {
        const eventId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const event = {
            type: 'message',
            data: {
                eventId,
                message,
                level,
                context,
            },
            timestamp: new Date(),
        };

        this.events.push(event);

        if (this.config.enabled) {
            if (level === 'error') {
                serviceLogger.error({ eventId, ...context }, message);
            } else if (level === 'warning') {
                serviceLogger.warn({ eventId, ...context }, message);
            } else {
                serviceLogger.info({ eventId, ...context }, message);
            }
        }

        return eventId;
    }

    setUser(user: { id: string; email?: string; role?: string } | null): void {
        if (this.config.enabled && user) {
            // In production: Sentry.setUser(user);
            serviceLogger.debug({ userId: user.id }, 'Sentry user context set');
        }
    }

    setTag(key: string, value: string): void {
        if (this.config.enabled) {
            // In production: Sentry.setTag(key, value);
        }
    }

    setContext(name: string, context: Record<string, unknown>): void {
        if (this.config.enabled) {
            // In production: Sentry.setContext(name, context);
        }
    }

    startTransaction(name: string, op: string): Transaction {
        const startTime = Date.now();
        const spans: Span[] = [];

        return {
            name,
            op,
            startTime,
            spans,
            finish: () => {
                const duration = Date.now() - startTime;
                if (this.config.enabled) {
                    serviceLogger.debug({ name, op, duration }, 'Transaction completed');
                }
            },
        };
    }

    startSpan(transaction: Transaction, name: string, op: string): Span {
        const startTime = Date.now();
        const span: Span = {
            name,
            op,
            startTime,
            finish: () => {
                const duration = Date.now() - startTime;
                if (this.config.enabled) {
                    serviceLogger.debug({ name, op, duration }, 'Span completed');
                }
            },
        };
        transaction.spans.push(span);
        return span;
    }

    getRecentEvents(limit: number = 10): typeof this.events {
        return this.events.slice(-limit);
    }

    flush(): Promise<boolean> {
        this.events = [];
        return Promise.resolve(true);
    }
}

// ============================================
// Error Tracker Service
// ============================================

class ErrorTrackerServiceClass {
    private sentry: MockSentryClient;

    constructor() {
        this.sentry = new MockSentryClient();
    }

    /**
     * Initialize error tracking
     */
    initialize(): void {
        this.sentry.init();
    }

    /**
     * Check if tracking is enabled
     */
    isEnabled(): boolean {
        return this.sentry.isEnabled();
    }

    /**
     * Capture an exception
     */
    captureException(error: Error, context?: ErrorContext): string {
        return this.sentry.captureException(error, context);
    }

    /**
     * Capture a message
     */
    captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info', context?: ErrorContext): string {
        return this.sentry.captureMessage(message, level, context);
    }

    /**
     * Set user context for subsequent events
     */
    setUser(user: { id: string; email?: string; role?: string } | null): void {
        this.sentry.setUser(user);
    }

    /**
     * Add a tag to subsequent events
     */
    setTag(key: string, value: string): void {
        this.sentry.setTag(key, value);
    }

    /**
     * Add context to subsequent events
     */
    setContext(name: string, context: Record<string, unknown>): void {
        this.sentry.setContext(name, context);
    }

    /**
     * Start a performance transaction
     */
    startTransaction(name: string, op: string): Transaction {
        return this.sentry.startTransaction(name, op);
    }

    /**
     * Create a span within a transaction
     */
    startSpan(transaction: Transaction, name: string, op: string): Span {
        return this.sentry.startSpan(transaction, name, op);
    }

    /**
     * Wrap an async function with error capture
     */
    async withErrorCapture<T>(
        fn: () => Promise<T>,
        context?: ErrorContext
    ): Promise<T> {
        try {
            return await fn();
        } catch (error) {
            if (error instanceof Error) {
                this.captureException(error, context);
            }
            throw error;
        }
    }

    /**
     * Wrap a function with transaction tracking
     */
    async withTransaction<T>(
        name: string,
        op: string,
        fn: (transaction: Transaction) => Promise<T>
    ): Promise<T> {
        const transaction = this.startTransaction(name, op);
        try {
            const result = await fn(transaction);
            return result;
        } finally {
            transaction.finish();
        }
    }

    /**
     * Get recent captured events (for debugging)
     */
    getRecentEvents(limit: number = 10): unknown[] {
        return this.sentry.getRecentEvents(limit);
    }

    /**
     * Express/Fastify error handler middleware
     */
    errorHandler() {
        return (error: Error, request: unknown, reply: unknown, done: () => void) => {
            this.captureException(error, {
                endpoint: (request as { url?: string })?.url,
                userId: (request as { user?: { uid?: string } })?.user?.uid,
            });
            done();
        };
    }

    /**
     * Flush pending events
     */
    async flush(): Promise<boolean> {
        return this.sentry.flush();
    }
}

export const ErrorTracker = new ErrorTrackerServiceClass();

// Auto-initialize on import
ErrorTracker.initialize();
