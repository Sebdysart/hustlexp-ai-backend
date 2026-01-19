/**
 * TIMESTAMP SERVICE (AUDIT-7)
 *
 * Server-only timestamp generation.
 * Client timestamps are FORBIDDEN for any authoritative data.
 *
 * @version 1.0.0
 * @see ARCHITECTURE.md §6.2 (AUDIT-7)
 */
declare class TimestampServiceClass {
    /**
     * Get authoritative server timestamp (UTC)
     * This is the ONLY way to get timestamps for database writes.
     */
    now(): Date;
    /**
     * Get ISO string timestamp
     */
    nowISO(): string;
    /**
     * Get Unix timestamp (milliseconds)
     */
    nowUnix(): number;
    /**
     * Get UTC date string (YYYY-MM-DD)
     * Used for streak day boundary (AUDIT-6)
     */
    todayUTC(): string;
    /**
     * Get start of current UTC day
     */
    startOfDayUTC(): Date;
    /**
     * Get end of current UTC day
     */
    endOfDayUTC(): Date;
    /**
     * Validate that a client-provided timestamp is reasonable
     * Used for logging/debugging only, NOT for authoritative data
     *
     * AUDIT-7: Client timestamps must NEVER be stored in authoritative fields.
     * This method only validates for logging/debugging purposes.
     */
    validateClientTimestamp(clientTimestamp: number | string | Date): {
        valid: boolean;
        drift: number;
        warning?: string;
    };
    /**
     * FORBIDDEN: Do not use client timestamps for any authoritative data
     * This method exists to explicitly throw if someone tries to use it.
     */
    useClientTimestamp(_timestamp: unknown): never;
    /**
     * Calculate streak day boundary (AUDIT-6)
     * A "day" is UTC calendar day (00:00:00 to 23:59:59 UTC)
     * Grace period: 2 hours into next day
     */
    isWithinStreakGrace(lastTaskAt: Date): boolean;
    /**
     * Get grace period end time for streak
     */
    getStreakGraceEnd(day: Date): Date;
}
export declare const TimestampService: TimestampServiceClass;
/**
 * Generate NOW() for SQL queries
 * AUDIT-7: Always use server-side NOW() in queries
 */
export declare function sqlNow(): string;
/**
 * Generate UTC_TIMESTAMP for SQL queries
 */
export declare function sqlUTCTimestamp(): string;
export {};
//# sourceMappingURL=TimestampService.d.ts.map