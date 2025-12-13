
import '../../config/env.js'; // Ensure DotEnv runs first
import { serviceLogger } from '../../utils/logger';

/**
 * ORDERING GUARD (Forensic Auditor)
 */
export class OrderingGuard {
    static async scanForAnomalies() {
        const { sql } = await import('../../db'); // Dynamic Import
        const logger = serviceLogger.child({ module: 'OrderingGuard' });
        logger.info('Starting Ordering Guard Scan...');

        // 1. Check for Causality Violations
        const actualViolations = await sql`
             SELECT 
                t1.task_id,
                t1.created_at as hold_time,
                t2.created_at as release_time
            FROM money_events_audit t1
            JOIN money_events_audit t2 ON t1.task_id = t2.task_id
            WHERE t1.event_type = 'HOLD_ESCROW' 
            AND t2.event_type = 'RELEASE_PAYOUT'
            AND t2.created_at < t1.created_at
        `;

        if (actualViolations.length > 0) {
            logger.error({ count: actualViolations.length, sample: actualViolations }, 'CRITICAL: Causality Violation Detected (Time Travel)');
        } else {
            logger.info('PASS: No Time Travel detected.');
        }

        // 2. Check for Duplicate Leads
        const doubleDips = await sql`
            SELECT task_id, count(*) as hold_count
            FROM money_events_audit
            WHERE event_type = 'HOLD_ESCROW'
            GROUP BY task_id
            HAVING count(*) > 1
        `;

        if (doubleDips.length > 0) {
            logger.warn({ count: doubleDips.length }, 'Warning: Multiple HOLD_ESCROW events for single task');
        } else {
            logger.info('PASS: No duplicate HOLD events.');
        }
    }
}

// FORCE EXECUTION
import('../../config/env.js').then(() => {
    OrderingGuard.scanForAnomalies().then(() => process.exit(0));
});
