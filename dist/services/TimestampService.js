/**
 * TIMESTAMP SERVICE (AUDIT-7)
 *
 * Server-only timestamp generation.
 * Client timestamps are FORBIDDEN for any authoritative data.
 *
 * @version 1.0.0
 * @see ARCHITECTURE.md §6.2 (AUDIT-7)
 */
import { createLogger } from '../utils/logger.js';
const logger = createLogger('TimestampService');
// ============================================================================
// CONSTANTS
// ============================================================================
const ALLOWED_DRIFT_MS = 5000; // 5 seconds max drift for validation
// ============================================================================
// TIMESTAMP SERVICE
// ============================================================================
class TimestampServiceClass {
    /**
     * Get authoritative server timestamp (UTC)
     * This is the ONLY way to get timestamps for database writes.
     */
    now() {
        return new Date();
    }
    /**
     * Get ISO string timestamp
     */
    nowISO() {
        return new Date().toISOString();
    }
    /**
     * Get Unix timestamp (milliseconds)
     */
    nowUnix() {
        return Date.now();
    }
    /**
     * Get UTC date string (YYYY-MM-DD)
     * Used for streak day boundary (AUDIT-6)
     */
    todayUTC() {
        const now = new Date();
        return now.toISOString().split('T')[0];
    }
    /**
     * Get start of current UTC day
     */
    startOfDayUTC() {
        const now = new Date();
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    }
    /**
     * Get end of current UTC day
     */
    endOfDayUTC() {
        const now = new Date();
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
    }
    /**
     * Validate that a client-provided timestamp is reasonable
     * Used for logging/debugging only, NOT for authoritative data
     *
     * AUDIT-7: Client timestamps must NEVER be stored in authoritative fields.
     * This method only validates for logging/debugging purposes.
     */
    validateClientTimestamp(clientTimestamp) {
        const serverTime = Date.now();
        let clientTime;
        try {
            if (typeof clientTimestamp === 'number') {
                clientTime = clientTimestamp;
            }
            else if (typeof clientTimestamp === 'string') {
                clientTime = new Date(clientTimestamp).getTime();
            }
            else {
                clientTime = clientTimestamp.getTime();
            }
        }
        catch {
            return {
                valid: false,
                drift: Infinity,
                warning: 'Invalid timestamp format',
            };
        }
        const drift = Math.abs(serverTime - clientTime);
        const valid = drift <= ALLOWED_DRIFT_MS;
        if (!valid) {
            logger.warn({
                clientTime,
                serverTime,
                driftMs: drift,
            }, 'AUDIT-7: Client timestamp drift detected');
        }
        return {
            valid,
            drift,
            warning: valid ? undefined : `Client clock drift: ${drift}ms exceeds ${ALLOWED_DRIFT_MS}ms threshold`,
        };
    }
    /**
     * FORBIDDEN: Do not use client timestamps for any authoritative data
     * This method exists to explicitly throw if someone tries to use it.
     */
    useClientTimestamp(_timestamp) {
        throw new Error('AUDIT-7: Client timestamps are FORBIDDEN for authoritative data. Use TimestampService.now() instead.');
    }
    /**
     * Calculate streak day boundary (AUDIT-6)
     * A "day" is UTC calendar day (00:00:00 to 23:59:59 UTC)
     * Grace period: 2 hours into next day
     */
    isWithinStreakGrace(lastTaskAt) {
        const now = this.now();
        const lastTaskDay = new Date(Date.UTC(lastTaskAt.getUTCFullYear(), lastTaskAt.getUTCMonth(), lastTaskAt.getUTCDate()));
        const today = this.startOfDayUTC();
        const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
        // Same day = valid
        if (lastTaskDay.getTime() === today.getTime()) {
            return true;
        }
        // Yesterday + within 2 hour grace period = valid
        if (lastTaskDay.getTime() === yesterday.getTime()) {
            const hourIntoToday = now.getUTCHours();
            return hourIntoToday < 2; // 2 hour grace period
        }
        return false;
    }
    /**
     * Get grace period end time for streak
     */
    getStreakGraceEnd(day) {
        const nextDay = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1, 2, 0, 0, 0 // 2:00 AM UTC next day
        ));
        return nextDay;
    }
}
export const TimestampService = new TimestampServiceClass();
// ============================================================================
// SQL HELPERS
// ============================================================================
/**
 * Generate NOW() for SQL queries
 * AUDIT-7: Always use server-side NOW() in queries
 */
export function sqlNow() {
    return 'NOW()';
}
/**
 * Generate UTC_TIMESTAMP for SQL queries
 */
export function sqlUTCTimestamp() {
    return "CURRENT_TIMESTAMP AT TIME ZONE 'UTC'";
}
//# sourceMappingURL=TimestampService.js.map