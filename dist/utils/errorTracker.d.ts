/**
 * Sentry Error Tracking Integration
 *
 * Centralizes error capture and performance monitoring.
 * Set SENTRY_DSN environment variable to enable.
 */
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
declare class ErrorTrackerServiceClass {
    private sentry;
    constructor();
    /**
     * Initialize error tracking
     */
    initialize(): void;
    /**
     * Check if tracking is enabled
     */
    isEnabled(): boolean;
    /**
     * Capture an exception
     */
    captureException(error: Error, context?: ErrorContext): string;
    /**
     * Capture a message
     */
    captureMessage(message: string, level?: 'info' | 'warning' | 'error', context?: ErrorContext): string;
    /**
     * Set user context for subsequent events
     */
    setUser(user: {
        id: string;
        email?: string;
        role?: string;
    } | null): void;
    /**
     * Add a tag to subsequent events
     */
    setTag(key: string, value: string): void;
    /**
     * Add context to subsequent events
     */
    setContext(name: string, context: Record<string, unknown>): void;
    /**
     * Start a performance transaction
     */
    startTransaction(name: string, op: string): Transaction;
    /**
     * Create a span within a transaction
     */
    startSpan(transaction: Transaction, name: string, op: string): Span;
    /**
     * Wrap an async function with error capture
     */
    withErrorCapture<T>(fn: () => Promise<T>, context?: ErrorContext): Promise<T>;
    /**
     * Wrap a function with transaction tracking
     */
    withTransaction<T>(name: string, op: string, fn: (transaction: Transaction) => Promise<T>): Promise<T>;
    /**
     * Get recent captured events (for debugging)
     */
    getRecentEvents(limit?: number): unknown[];
    /**
     * Express/Fastify error handler middleware
     */
    errorHandler(): (error: Error, request: unknown, reply: unknown, done: () => void) => void;
    /**
     * Flush pending events
     */
    flush(): Promise<boolean>;
}
export declare const ErrorTracker: ErrorTrackerServiceClass;
export {};
//# sourceMappingURL=errorTracker.d.ts.map