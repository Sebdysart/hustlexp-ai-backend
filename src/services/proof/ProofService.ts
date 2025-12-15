/**
 * PROOF SERVICE
 * 
 * Core state machine for proof lifecycle.
 * Proofs are append-only and immutable once locked.
 */
import { neon } from '@neondatabase/serverless';
import { ulid } from 'ulidx';
import {
    ProofState,
    ProofType,
    ProofReason,
    ProofEventType,
    canTransition,
    type ProofRequest,
    type ProofSubmission,
    type ForensicsResult
} from './types.js';
import { serviceLogger } from '../../utils/logger.js';
import { BetaMetricsService } from '../BetaMetricsService.js';

const logger = serviceLogger.child({ module: 'ProofService' });

let sql: ReturnType<typeof neon> | null = null;

function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}

export class ProofService {
    /**
     * Create a proof request
     */
    static async createRequest(params: {
        taskId: string;
        proofType: ProofType;
        reason: ProofReason;
        requestedBy: 'ai' | 'system' | 'poster';
        instructions: string;
        deadlineHours?: number;
    }): Promise<{ success: boolean; requestId?: string; error?: string }> {
        const db = getDb();
        if (!db) return { success: false, error: 'Database not available' };

        try {
            const deadline = params.deadlineHours
                ? new Date(Date.now() + params.deadlineHours * 60 * 60 * 1000)
                : null;

            const [request] = await db`
                INSERT INTO proof_requests (task_id, proof_type, reason, requested_by, instructions, deadline, state)
                VALUES (${params.taskId}::uuid, ${params.proofType}, ${params.reason}, ${params.requestedBy}, 
                        ${params.instructions}, ${deadline}, ${ProofState.REQUESTED})
                RETURNING id
            ` as any[];

            // Log event
            await this.logEvent({
                proofRequestId: request.id,
                taskId: params.taskId,
                eventType: ProofEventType.REQUEST_CREATED,
                actor: params.requestedBy,
                actorType: params.requestedBy === 'ai' ? 'ai' : params.requestedBy === 'poster' ? 'user' : 'system',
                details: { proofType: params.proofType, reason: params.reason }
            });

            logger.info({ requestId: request.id, taskId: params.taskId }, 'Proof request created');

            // Emit metric
            BetaMetricsService.proofRequested();

            return { success: true, requestId: request.id };
        } catch (err: any) {
            logger.error({ error: err.message }, 'Failed to create proof request');
            return { success: false, error: err.message };
        }
    }

    /**
     * Submit proof for a request
     * HARDENED: Checks for hash reuse across tasks
     */
    static async submitProof(params: {
        requestId: string;
        submittedBy: string;
        fileUrl: string;
        fileHash: string;
        mimeType: string;
        fileSize: number;
        metadata: Record<string, any>;
    }): Promise<{ success: boolean; submissionId?: string; error?: string; escalated?: boolean }> {
        const db = getDb();
        if (!db) return { success: false, error: 'Database not available' };

        try {
            // Get request
            const [request] = await db`
                SELECT id, task_id, state FROM proof_requests WHERE id = ${params.requestId}::uuid
            ` as any[];

            if (!request) {
                return { success: false, error: 'Proof request not found' };
            }

            if (request.state !== ProofState.REQUESTED) {
                return { success: false, error: `Cannot submit proof in state ${request.state}` };
            }

            // HARDENING: Check for hash reuse across OTHER tasks
            const [existingHash] = await db`
                SELECT task_id FROM proof_hash_bindings 
                WHERE file_hash = ${params.fileHash} 
                AND task_id != ${request.task_id}::uuid
            ` as any[];

            let escalated = false;
            if (existingHash) {
                // Same image used on different task - auto-escalate
                logger.warn({
                    fileHash: params.fileHash,
                    originalTask: existingHash.task_id,
                    newTask: request.task_id
                }, 'Proof hash reuse detected - auto-escalating');
                escalated = true;
            }

            // Bind hash to this task
            await db`
                INSERT INTO proof_hash_bindings (file_hash, task_id, proof_request_id, user_id)
                VALUES (${params.fileHash}, ${request.task_id}::uuid, ${params.requestId}::uuid, ${params.submittedBy}::uuid)
                ON CONFLICT (file_hash, task_id) DO NOTHING
            `;

            // Create submission
            const initialState = escalated ? ProofState.ESCALATED : ProofState.SUBMITTED;
            const [submission] = await db`
                INSERT INTO proof_submissions (request_id, task_id, submitted_by, file_url, file_hash, mime_type, file_size, metadata, state)
                VALUES (${params.requestId}::uuid, ${request.task_id}::uuid, ${params.submittedBy}::uuid, 
                        ${params.fileUrl}, ${params.fileHash}, ${params.mimeType}, ${params.fileSize},
                        ${JSON.stringify(params.metadata)}, ${initialState})
                RETURNING id
            ` as any[];

            // Update request state
            await db`
                UPDATE proof_requests SET state = ${initialState}, updated_at = NOW()
                WHERE id = ${params.requestId}::uuid
            `;

            // Log event
            await this.logEvent({
                proofRequestId: params.requestId,
                proofSubmissionId: submission.id,
                taskId: request.task_id,
                eventType: escalated ? ProofEventType.ESCALATED : ProofEventType.SUBMISSION_RECEIVED,
                actor: params.submittedBy,
                actorType: 'user',
                details: {
                    fileHash: params.fileHash,
                    mimeType: params.mimeType,
                    hashReuseDetected: escalated,
                    originalTask: existingHash?.task_id
                }
            });

            logger.info({ submissionId: submission.id, requestId: params.requestId, escalated }, 'Proof submitted');

            // Emit metrics
            BetaMetricsService.proofSubmitted();
            if (escalated) {
                BetaMetricsService.proofEscalated();
            }

            return { success: true, submissionId: submission.id, escalated };
        } catch (err: any) {
            logger.error({ error: err.message }, 'Failed to submit proof');
            return { success: false, error: err.message };
        }
    }

    /**
     * Record forensics analysis result
     */
    static async recordForensicsResult(
        submissionId: string,
        result: ForensicsResult
    ): Promise<{ success: boolean; error?: string }> {
        const db = getDb();
        if (!db) return { success: false, error: 'Database not available' };

        try {
            const [submission] = await db`
                UPDATE proof_submissions 
                SET forensics_result = ${JSON.stringify(result)}, state = ${ProofState.ANALYZING}
                WHERE id = ${submissionId}::uuid
                RETURNING id, request_id, task_id
            ` as any[];

            if (!submission) {
                return { success: false, error: 'Submission not found' };
            }

            await this.logEvent({
                proofRequestId: submission.request_id,
                proofSubmissionId: submissionId,
                taskId: submission.task_id,
                eventType: ProofEventType.ANALYSIS_COMPLETED,
                actor: 'forensics',
                actorType: 'system',
                details: {
                    confidenceScore: result.confidenceScore,
                    likelyScreenshot: result.likelyScreenshot,
                    anomalyCount: result.anomalies.length
                }
            });

            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Verify or reject proof (system/admin decision)
     */
    static async finalizeProof(
        submissionId: string,
        decision: 'verified' | 'rejected' | 'escalated',
        actor: string,
        actorType: 'system' | 'admin',
        reason?: string
    ): Promise<{ success: boolean; error?: string }> {
        const db = getDb();
        if (!db) return { success: false, error: 'Database not available' };

        try {
            const newState = decision === 'verified' ? ProofState.VERIFIED
                : decision === 'rejected' ? ProofState.REJECTED
                    : ProofState.ESCALATED;

            const [submission] = await db`
                UPDATE proof_submissions SET state = ${newState}
                WHERE id = ${submissionId}::uuid
                RETURNING id, request_id, task_id, state
            ` as any[];

            if (!submission) {
                return { success: false, error: 'Submission not found' };
            }

            // Update request state
            await db`
                UPDATE proof_requests SET state = ${newState}, updated_at = NOW()
                WHERE id = ${submission.request_id}::uuid
            `;

            const eventType = decision === 'verified' ? ProofEventType.VERIFIED
                : decision === 'rejected' ? ProofEventType.REJECTED
                    : ProofEventType.ESCALATED;

            await this.logEvent({
                proofRequestId: submission.request_id,
                proofSubmissionId: submissionId,
                taskId: submission.task_id,
                eventType,
                actor,
                actorType,
                details: { reason }
            });

            logger.info({ submissionId, decision, actor }, 'Proof finalized');

            // Emit metrics based on decision
            if (decision === 'verified') {
                BetaMetricsService.proofVerified();
            } else if (decision === 'rejected') {
                BetaMetricsService.proofRejected(reason || 'unknown');
            } else if (decision === 'escalated') {
                BetaMetricsService.proofEscalated();
            }

            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Lock proof (make immutable)
     */
    static async lockProof(submissionId: string): Promise<{ success: boolean; error?: string }> {
        const db = getDb();
        if (!db) return { success: false, error: 'Database not available' };

        try {
            const [submission] = await db`
                UPDATE proof_submissions 
                SET state = ${ProofState.LOCKED}, locked_at = NOW()
                WHERE id = ${submissionId}::uuid AND state = ${ProofState.VERIFIED}
                RETURNING id, request_id, task_id
            ` as any[];

            if (!submission) {
                return { success: false, error: 'Cannot lock - submission not in VERIFIED state' };
            }

            await db`
                UPDATE proof_requests SET state = ${ProofState.LOCKED}, updated_at = NOW()
                WHERE id = ${submission.request_id}::uuid
            `;

            await this.logEvent({
                proofRequestId: submission.request_id,
                proofSubmissionId: submissionId,
                taskId: submission.task_id,
                eventType: ProofEventType.LOCKED,
                actor: 'system',
                actorType: 'system',
                details: {}
            });

            logger.info({ submissionId }, 'Proof locked');
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Get proof status for task
     */
    static async getTaskProofStatus(taskId: string): Promise<{
        requests: any[];
        submissions: any[];
        currentState: ProofState;
    }> {
        const db = getDb();
        if (!db) return { requests: [], submissions: [], currentState: ProofState.NONE };

        const requests = await db`
            SELECT * FROM proof_requests WHERE task_id = ${taskId}::uuid ORDER BY created_at DESC
        `;

        const submissions = await db`
            SELECT * FROM proof_submissions WHERE task_id = ${taskId}::uuid ORDER BY created_at DESC
        ` as any[];

        // Determine current state from most recent
        const latestRequest = (requests as any[])[0];
        const currentState = latestRequest?.state || ProofState.NONE;

        return { requests: requests as any[], submissions: submissions as any[], currentState };
    }

    /**
     * Log proof event (immutable audit trail)
     */
    private static async logEvent(params: {
        proofRequestId?: string;
        proofSubmissionId?: string;
        taskId: string;
        eventType: ProofEventType;
        actor: string;
        actorType: 'ai' | 'user' | 'system' | 'admin';
        details: Record<string, any>;
    }): Promise<void> {
        const db = getDb();
        if (!db) return;

        try {
            await db`
                INSERT INTO proof_events (proof_request_id, proof_submission_id, task_id, event_type, actor, actor_type, details)
                VALUES (${params.proofRequestId || null}::uuid, ${params.proofSubmissionId || null}::uuid, 
                        ${params.taskId}::uuid, ${params.eventType}, ${params.actor}, ${params.actorType},
                        ${JSON.stringify(params.details)})
            `;
        } catch (err) {
            logger.error({ error: err }, 'Failed to log proof event');
        }
    }
}
