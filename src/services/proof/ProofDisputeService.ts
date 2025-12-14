/**
 * PROOF DISPUTE SERVICE
 * 
 * Handles proof snapshotting for disputes.
 * Proof becomes immutable when dispute opens.
 */
import { neon } from '@neondatabase/serverless';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('ProofDisputeService');

let sql: ReturnType<typeof neon> | null = null;

function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}

export class ProofDisputeService {
    /**
     * Snapshot proof state when dispute is opened
     * Creates immutable record attached to dispute
     */
    static async snapshotForDispute(
        disputeId: string,
        taskId: string
    ): Promise<{ success: boolean; snapshotId?: string; error?: string }> {
        const db = getDb();
        if (!db) return { success: false, error: 'Database not available' };

        try {
            // Get all proof data for task
            const requests = await db`
                SELECT * FROM proof_requests WHERE task_id = ${taskId}::uuid
            ` as any[];

            const submissions = await db`
                SELECT * FROM proof_submissions WHERE task_id = ${taskId}::uuid
            ` as any[];

            const events = await db`
                SELECT * FROM proof_events WHERE task_id = ${taskId}::uuid ORDER BY created_at
            ` as any[];

            // Get the most recent submission with forensics
            const latestSubmission = submissions[0];
            const forensicsResult = latestSubmission?.forensics_result || null;

            // Create snapshot
            const snapshotData = {
                snapshotTimestamp: new Date().toISOString(),
                requests: requests,
                submissions: submissions,
                events: events,
                latestState: latestSubmission?.state || null
            };

            const [snapshot] = await db`
                INSERT INTO proof_dispute_snapshots (
                    dispute_id, task_id, proof_request_id, proof_submission_id, 
                    snapshot_data, forensics_result
                )
                VALUES (
                    ${disputeId}::uuid, ${taskId}::uuid, 
                    ${latestSubmission?.request_id || null}::uuid,
                    ${latestSubmission?.id || null}::uuid,
                    ${JSON.stringify(snapshotData)},
                    ${forensicsResult ? JSON.stringify(forensicsResult) : null}
                )
                RETURNING id
            ` as any[];

            // Lock all submissions for this task (prevent further mutation)
            await db`
                UPDATE proof_submissions 
                SET state = 'locked', locked_at = NOW()
                WHERE task_id = ${taskId}::uuid AND state NOT IN ('locked', 'rejected')
            `;

            await db`
                UPDATE proof_requests
                SET state = 'locked', updated_at = NOW()
                WHERE task_id = ${taskId}::uuid AND state NOT IN ('locked', 'rejected')
            `;

            logger.info({ disputeId, taskId, snapshotId: snapshot.id }, 'Proof snapshot created for dispute');
            return { success: true, snapshotId: snapshot.id };
        } catch (err: any) {
            logger.error({ error: err.message }, 'Failed to snapshot proof for dispute');
            return { success: false, error: err.message };
        }
    }

    /**
     * Get proof snapshot for dispute
     */
    static async getDisputeSnapshot(disputeId: string): Promise<any | null> {
        const db = getDb();
        if (!db) return null;

        const [snapshot] = await db`
            SELECT * FROM proof_dispute_snapshots WHERE dispute_id = ${disputeId}::uuid
        ` as any[];

        return snapshot || null;
    }

    /**
     * Check if proof is locked due to dispute
     */
    static async isLockedByDispute(taskId: string): Promise<boolean> {
        const db = getDb();
        if (!db) return false;

        const [locked] = await db`
            SELECT 1 FROM proof_dispute_snapshots WHERE task_id = ${taskId}::uuid
        ` as any[];

        return !!locked;
    }
}
