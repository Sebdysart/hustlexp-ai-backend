/**
 * PROOF REQUEST SERVICE
 * 
 * Handles AI proof request creation with policy enforcement.
 */
import { ProofService } from './ProofService.js';
import { ProofPolicy } from './ProofPolicy.js';
import { ProofType, ProofReason, ProofState } from './types.js';
import { neon } from '@neondatabase/serverless';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('ProofRequestService');

let sql: ReturnType<typeof neon> | null = null;

function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}

interface AIProofRequestParams {
    taskId: string;
    proofType?: ProofType;
    reason: ProofReason;
    customInstructions?: string;
    deadlineHours?: number;
}

export class ProofRequestService {
    /**
     * AI requests proof for task
     * Enforces policy guardrails
     */
    static async aiRequestProof(params: AIProofRequestParams): Promise<{
        success: boolean;
        requestId?: string;
        error?: string;
    }> {
        const db = getDb();
        if (!db) return { success: false, error: 'Database not available' };

        try {
            // 1. Get task context
            const [task] = await db`
                SELECT id, category, status, price, created_by, assigned_to
                FROM tasks WHERE id = ${params.taskId}::uuid
            ` as any[];

            if (!task) {
                return { success: false, error: 'Task not found' };
            }

            // 2. Get user context (hustler)
            let userContext = {
                id: task.assigned_to,
                trustTier: 3, // default
                proofRequestsToday: 0,
                disputeRate: 0
            };

            if (task.assigned_to) {
                const [user] = await db`
                    SELECT id, level as trust_tier FROM users WHERE id = ${task.assigned_to}::uuid
                ` as any[];
                if (user) {
                    userContext.trustTier = Math.min(5, Math.max(1, user.trust_tier || 3));
                }
            }

            // 3. Get existing proof count
            const [proofCount] = await db`
                SELECT COUNT(*) as cnt FROM proof_requests WHERE task_id = ${params.taskId}::uuid
            ` as any[];
            const existingProofCount = Number(proofCount.cnt);

            // 4. Determine proof type
            const proofType = params.proofType ||
                ProofPolicy.getRecommendedProofType(task.category, params.reason);

            // 5. Check policy
            const policyCheck = ProofPolicy.canRequestProof(
                {
                    id: task.id,
                    category: task.category,
                    status: task.status,
                    price: Number(task.price)
                },
                userContext,
                proofType,
                params.reason,
                existingProofCount
            );

            if (!policyCheck.allowed) {
                logger.warn({ taskId: params.taskId, reason: policyCheck.reason }, 'Proof request denied by policy');
                return { success: false, error: policyCheck.reason };
            }

            // 6. Generate instructions
            const instructions = params.customInstructions ||
                ProofPolicy.generateInstructions(task.category, params.reason, proofType);

            // 7. Create request
            const result = await ProofService.createRequest({
                taskId: params.taskId,
                proofType,
                reason: params.reason,
                requestedBy: 'ai',
                instructions,
                deadlineHours: params.deadlineHours || 24
            });

            return result;
        } catch (err: any) {
            logger.error({ error: err.message }, 'AI proof request failed');
            return { success: false, error: err.message };
        }
    }

    /**
     * System auto-requests proof based on task attributes
     */
    static async autoRequestIfRequired(taskId: string): Promise<{
        required: boolean;
        requestId?: string;
    }> {
        const db = getDb();
        if (!db) return { required: false };

        try {
            // Get task
            const [task] = await db`
                SELECT id, category, status, price, assigned_to
                FROM tasks WHERE id = ${taskId}::uuid
            ` as any[];

            if (!task || !task.assigned_to) {
                return { required: false };
            }

            // Get hustler context
            const [user] = await db`
                SELECT id, level as trust_tier FROM users WHERE id = ${task.assigned_to}::uuid
            ` as any[];

            const hustlerContext = {
                id: task.assigned_to,
                trustTier: Math.min(5, Math.max(1, user?.trust_tier || 3)),
                proofRequestsToday: 0,
                disputeRate: 0
            };

            // Check if proof is required
            const required = ProofPolicy.isProofRequired(
                {
                    id: task.id,
                    category: task.category,
                    status: task.status,
                    price: Number(task.price)
                },
                hustlerContext
            );

            if (!required) {
                return { required: false };
            }

            // Create auto-request
            const proofType = ProofPolicy.getRecommendedProofType(
                task.category,
                ProofReason.TASK_COMPLETION
            );

            const instructions = ProofPolicy.generateInstructions(
                task.category,
                ProofReason.TASK_COMPLETION,
                proofType
            );

            const result = await ProofService.createRequest({
                taskId,
                proofType,
                reason: ProofReason.TASK_COMPLETION,
                requestedBy: 'system',
                instructions,
                deadlineHours: 48
            });

            return {
                required: true,
                requestId: result.requestId
            };
        } catch (err: any) {
            logger.error({ error: err.message }, 'Auto proof request failed');
            return { required: false };
        }
    }

    /**
     * Get pending proof requests for task
     */
    static async getPendingRequests(taskId: string): Promise<any[]> {
        const db = getDb();
        if (!db) return [];

        const requests = await db`
            SELECT * FROM proof_requests 
            WHERE task_id = ${taskId}::uuid 
            AND state = ${ProofState.REQUESTED}
            ORDER BY created_at DESC
        ` as any[];

        return requests as any[];
    }
}
