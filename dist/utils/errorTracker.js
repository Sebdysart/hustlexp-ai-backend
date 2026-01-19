/**
 * Sentry Error Tracking Integration
 *
 * Centralizes error capture and performance monitoring.
 * Set SENTRY_DSN environment variable to enable.
 */
import { serviceLogger } from './logger.js';
// ============================================
// Mock Sentry Client (for when Sentry SDK not installed)
// ============================================
class MockSentryClient {
    config;
    events = [];
    constructor() {
        this.config = {
            dsn: process.env.SENTRY_DSN,
            environment: process.env.NODE_ENV || 'development',
            release: process.env.npm_package_version,
            tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
            enabled: !!process.env.SENTRY_DSN,
        };
    }
    init() {
        if (!this.config.dsn) {
            serviceLogger.info('Sentry DSN not configured - error tracking disabled');
            return;
        }
        serviceLogger.info({
            environment: this.config.environment,
            tracesSampleRate: this.config.tracesSampleRate,
        }, 'Sentry initialized');
    }
    isEnabled() {
        return this.config.enabled;
    }
    captureException(error, context) {
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
    captureMessage(message, level = 'info', context) {
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
            }
            else if (level === 'warning') {
                serviceLogger.warn({ eventId, ...context }, message);
            }
            else {
                serviceLogger.info({ eventId, ...context }, message);
            }
        }
        return eventId;
    }
    setUser(user) {
        if (this.config.enabled && user) {
            // In production: Sentry.setUser(user);
            serviceLogger.debug({ userId: user.id }, 'Sentry user context set');
        }
    }
    setTag(key, value) {
        if (this.config.enabled) {
            // In production: Sentry.setTag(key, value);
        }
    }
    setContext(name, context) {
        if (this.config.enabled) {
            // In production: Sentry.setContext(name, context);
        }
    }
    startTransaction(name, op) {
        const startTime = Date.now();
        const spans = [];
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
    startSpan(transaction, name, op) {
        const startTime = Date.now();
        const span = {
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
    getRecentEvents(limit = 10) {
        return this.events.slice(-limit);
    }
    flush() {
        this.events = [];
        return Promise.resolve(true);
    }
}
// ============================================
// Error Tracker Service
// ============================================
class ErrorTrackerServiceClass {
    sentry;
    constructor() {
        this.sentry = new MockSentryClient();
    }
    /**
     * Initialize error tracking
     */
    initialize() {
        this.sentry.init();
    }
    /**
     * Check if tracking is enabled
     */
    isEnabled() {
        return this.sentry.isEnabled();
    }
    /**
     * Capture an exception
     */
    captureException(error, context) {
        return this.sentry.captureException(error, context);
    }
    /**
     * Capture a message
     */
    captureMessage(message, level = 'info', context) {
        return this.sentry.captureMessage(message, level, context);
    }
    /**
     * Set user context for subsequent events
     */
    setUser(user) {
        this.sentry.setUser(user);
    }
    /**
     * Add a tag to subsequent events
     */
    setTag(key, value) {
        this.sentry.setTag(key, value);
    }
    /**
     * Add context to subsequent events
     */
    setContext(name, context) {
        this.sentry.setContext(name, context);
    }
    /**
     * Start a performance transaction
     */
    startTransaction(name, op) {
        return this.sentry.startTransaction(name, op);
    }
    /**
     * Create a span within a transaction
     */
    startSpan(transaction, name, op) {
        return this.sentry.startSpan(transaction, name, op);
    }
    /**
     * Wrap an async function with error capture
     */
    async withErrorCapture(fn, context) {
        try {
            return await fn();
        }
        catch (error) {
            if (error instanceof Error) {
                this.captureException(error, context);
            }
            throw error;
        }
    }
    /**
     * Wrap a function with transaction tracking
     */
    async withTransaction(name, op, fn) {
        const transaction = this.startTransaction(name, op);
        try {
            const result = await fn(transaction);
            return result;
        }
        finally {
            transaction.finish();
        }
    }
    /**
     * Get recent captured events (for debugging)
     */
    getRecentEvents(limit = 10) {
        return this.sentry.getRecentEvents(limit);
    }
    /**
     * Express/Fastify error handler middleware
     */
    errorHandler() {
        return (error, request, reply, done) => {
            this.captureException(error, {
                endpoint: request?.url,
                userId: request?.user?.uid,
            });
            done();
        };
    }
    /**
     * Flush pending events
     */
    async flush() {
        return this.sentry.flush();
    }
}
export const ErrorTracker = new ErrorTrackerServiceClass();
// Auto-initialize on import
ErrorTracker.initialize();
//# sourceMappingURL=errorTracker.js.map