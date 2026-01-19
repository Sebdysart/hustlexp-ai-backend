/**
 * FRONTEND API ROUTES (BUILD_GUIDE Aligned)
 *
 * Provides endpoints for the React Native frontend:
 * - /api/users/:id/xp-progress - Server-authoritative XP data (INV-UI-5)
 * - /api/tasks/:id/escrow-status - Escrow state display
 * - /api/tasks/:id/proof-status - Proof submission state
 * - /api/tasks/:id/submit-proof - Photo proof upload
 *
 * CONSTITUTIONAL COMPLIANCE:
 * - INV-UI-5: No client-side XP calculations
 * - INV-3: COMPLETED requires ACCEPTED proof
 * - INV-4: All money operations through escrow
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
import { getSql } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { LEVEL_THRESHOLDS, calculateLevel, getStreakMultiplier, } from '../services/AtomicXPService.js';
import { TrustTierService, TIER_NAMES } from '../services/TrustTierService.js';
const logger = createLogger('FrontendRoutes');
// ============================================================================
// ROUTE PLUGIN
// ============================================================================
export default async function frontendRoutes(fastify, opts) {
    const sql = getSql();
    // ==========================================================================
    // GET /api/users/:id/xp-progress
    // Server-authoritative XP data (INV-UI-5)
    // ==========================================================================
    fastify.get('/api/users/:userId/xp-progress', async (request, reply) => {
        const { userId } = request.params;
        try {
            // Get user data
            const [user] = await sql `
        SELECT 
          id,
          xp,
          level,
          streak,
          trust_tier,
          last_active_at,
          updated_at
        FROM users
        WHERE id = ${userId}
        LIMIT 1
      `;
            if (!user) {
                reply.code(404);
                return { error: 'User not found' };
            }
            // Count completed tasks
            const [taskStats] = await sql `
        SELECT COUNT(*)::int as completed
        FROM tasks
        WHERE assigned_to = ${userId}
          AND status = 'completed'
      `;
            // Get total XP earned from ledger
            const [xpStats] = await sql `
        SELECT 
          COALESCE(SUM(final_xp), 0)::int as total_earned,
          MAX(created_at) as last_awarded_at
        FROM xp_ledger
        WHERE user_id = ${userId}
      `;
            // Calculate level progress
            const currentXP = user.xp || 0;
            const currentLevel = user.level || calculateLevel(currentXP);
            const currentThreshold = LEVEL_THRESHOLDS[currentLevel - 1]?.xpRequired || 0;
            const nextThreshold = LEVEL_THRESHOLDS[currentLevel]?.xpRequired ||
                LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1].xpRequired;
            const xpInCurrentLevel = currentXP - currentThreshold;
            const xpToNextLevel = nextThreshold - currentThreshold;
            const levelProgress = Math.min(100, (xpInCurrentLevel / xpToNextLevel) * 100);
            // Get streak multiplier
            const streakDays = user.streak || 0;
            const streakMultiplier = getStreakMultiplier(streakDays);
            const response = {
                currentXP,
                level: currentLevel,
                xpToNextLevel,
                xpInCurrentLevel,
                levelProgress: Math.round(levelProgress * 100) / 100,
                streakDays,
                streakMultiplier: streakMultiplier.toFixed(1),
                trustTier: (user.trust_tier || 1),
                completedTasks: taskStats?.completed || 0,
                lastAwardedAt: xpStats?.last_awarded_at?.toISOString() || null,
                totalEarned: xpStats?.total_earned || 0,
            };
            logger.debug({ userId, response }, 'XP progress fetched');
            return response;
        }
        catch (error) {
            logger.error({ error, userId }, 'Failed to fetch XP progress');
            reply.code(500);
            return { error: 'Failed to fetch XP progress' };
        }
    });
    // ==========================================================================
    // GET /api/tasks/:id/escrow-status
    // Escrow state for EscrowStatusCard
    // ==========================================================================
    fastify.get('/api/tasks/:taskId/escrow-status', async (request, reply) => {
        const { taskId } = request.params;
        try {
            // Get money state lock
            const [moneyState] = await sql `
        SELECT 
          task_id,
          current_state,
          amount_cents,
          updated_at
        FROM money_state_lock
        WHERE task_id = ${taskId}
        LIMIT 1
      `;
            if (!moneyState) {
                // No escrow yet - return pending state
                const [task] = await sql `
          SELECT price FROM tasks WHERE id = ${taskId}
        `;
                if (!task) {
                    reply.code(404);
                    return { error: 'Task not found' };
                }
                return {
                    state: 'pending',
                    amountCents: Math.round(task.price * 100),
                    hustlerPayoutCents: 0,
                    platformFeeCents: 0,
                    updatedAt: new Date().toISOString(),
                };
            }
            // Map internal states to frontend states
            const stateMap = {
                'pending': 'pending',
                'funded': 'held',
                'locked': 'locked_dispute',
                'locked_dispute': 'locked_dispute',
                'released': 'released',
                'refunded': 'refunded',
                'partial_refund': 'partial_refund',
            };
            const amountCents = moneyState.amount_cents || 0;
            // Get task for hustler trust tier (to calculate fees)
            const [task] = await sql `
        SELECT t.id, t.assigned_to, u.trust_tier
        FROM tasks t
        LEFT JOIN users u ON u.id = t.assigned_to
        WHERE t.id = ${taskId}
      `;
            const trustTier = task?.trust_tier || 1;
            const feeRate = trustTier === 4 ? 0.10 : trustTier === 3 ? 0.12 : trustTier === 2 ? 0.15 : 0.20;
            const platformFeeCents = Math.floor(amountCents * feeRate);
            const hustlerPayoutCents = amountCents - platformFeeCents;
            // Check for dispute
            const [dispute] = await sql `
        SELECT id FROM disputes WHERE task_id = ${taskId} AND status != 'resolved'
        LIMIT 1
      `;
            const response = {
                state: stateMap[moneyState.current_state] || 'pending',
                amountCents,
                hustlerPayoutCents,
                platformFeeCents,
                updatedAt: moneyState.updated_at?.toISOString() || new Date().toISOString(),
                ...(dispute ? { disputeId: dispute.id } : {}),
            };
            return response;
        }
        catch (error) {
            logger.error({ error, taskId }, 'Failed to fetch escrow status');
            reply.code(500);
            return { error: 'Failed to fetch escrow status' };
        }
    });
    // ==========================================================================
    // GET /api/tasks/:id/proof-status
    // Proof submission state for ProofSubmissionCard
    // ==========================================================================
    fastify.get('/api/tasks/:taskId/proof-status', async (request, reply) => {
        const { taskId } = request.params;
        try {
            // Get proof from proof_submissions table
            const [proof] = await sql `
        SELECT 
          id,
          status,
          photo_urls,
          rejection_reason,
          expires_at,
          created_at,
          updated_at
        FROM proof_submissions
        WHERE task_id = ${taskId}
        ORDER BY created_at DESC
        LIMIT 1
      `;
            if (!proof) {
                return {
                    state: 'not_started',
                    photos: [],
                };
            }
            // Map internal status to frontend state
            const stateMap = {
                'pending': 'pending_review',
                'reviewing': 'pending_review',
                'accepted': 'accepted',
                'rejected': 'rejected',
                'expired': 'expired',
            };
            // Parse photo URLs
            let photos = [];
            if (proof.photo_urls) {
                try {
                    const urls = typeof proof.photo_urls === 'string'
                        ? JSON.parse(proof.photo_urls)
                        : proof.photo_urls;
                    photos = urls.map(uri => ({
                        uri,
                        width: 0,
                        height: 0,
                        timestamp: proof.created_at?.toISOString() || new Date().toISOString(),
                    }));
                }
                catch (e) {
                    logger.warn({ taskId, error: e }, 'Failed to parse photo URLs');
                }
            }
            const response = {
                state: stateMap[proof.status] || 'not_started',
                photos,
                ...(proof.rejection_reason ? { rejectionReason: proof.rejection_reason } : {}),
                ...(proof.expires_at ? { expiresAt: proof.expires_at.toISOString() } : {}),
            };
            return response;
        }
        catch (error) {
            logger.error({ error, taskId }, 'Failed to fetch proof status');
            reply.code(500);
            return { error: 'Failed to fetch proof status' };
        }
    });
    // ==========================================================================
    // POST /api/tasks/:id/submit-proof
    // Submit photo proof (INV-3 compliance)
    // ==========================================================================
    fastify.post('/api/tasks/:taskId/submit-proof', async (request, reply) => {
        const { taskId } = request.params;
        const { photos } = request.body;
        if (!photos || photos.length === 0) {
            reply.code(400);
            return { error: 'At least one photo is required' };
        }
        try {
            // Verify task exists and is in correct state
            const [task] = await sql `
        SELECT id, status, assigned_to
        FROM tasks
        WHERE id = ${taskId}
        LIMIT 1
      `;
            if (!task) {
                reply.code(404);
                return { error: 'Task not found' };
            }
            if (task.status !== 'accepted') {
                reply.code(400);
                return { error: `Cannot submit proof for task in ${task.status} state` };
            }
            // Check for existing proof
            const [existingProof] = await sql `
        SELECT id, status FROM proof_submissions
        WHERE task_id = ${taskId}
        ORDER BY created_at DESC
        LIMIT 1
      `;
            if (existingProof && existingProof.status === 'accepted') {
                reply.code(400);
                return { error: 'Proof already accepted for this task' };
            }
            // Calculate expiration (24 hours from now)
            const expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + 24);
            // Create proof submission
            const photoUrls = photos.map(p => p.uri);
            const [newProof] = await sql `
        INSERT INTO proof_submissions (
          task_id,
          hustler_id,
          status,
          photo_urls,
          expires_at
        ) VALUES (
          ${taskId},
          ${task.assigned_to},
          'pending',
          ${JSON.stringify(photoUrls)},
          ${expiresAt}
        )
        RETURNING id
      `;
            // Update task status
            await sql `
        UPDATE tasks
        SET status = 'proof_submitted', updated_at = NOW()
        WHERE id = ${taskId}
      `;
            logger.info({ taskId, proofId: newProof.id, photoCount: photos.length }, 'Proof submitted');
            return {
                success: true,
                proofId: newProof.id,
            };
        }
        catch (error) {
            logger.error({ error, taskId }, 'Failed to submit proof');
            reply.code(500);
            return { error: 'Failed to submit proof' };
        }
    });
    // ==========================================================================
    // GET /api/users/:id/trust
    // Trust tier information for TrustBadge
    // ==========================================================================
    fastify.get('/api/users/:userId/trust', async (request, reply) => {
        const { userId } = request.params;
        try {
            const stats = await TrustTierService.getUserTrustStats(userId);
            return {
                tier: stats.currentTier,
                tierName: TIER_NAMES[stats.currentTier],
                completedTasks: stats.completedTasks,
                avgRating: stats.avgRating,
                disputeRate: stats.disputeRate,
                canUpgrade: stats.canUpgrade,
                eligibleTier: stats.eligibleTier,
            };
        }
        catch (error) {
            logger.error({ error, userId }, 'Failed to fetch trust info');
            reply.code(500);
            return { error: 'Failed to fetch trust info' };
        }
    });
    logger.info('Frontend routes registered');
}
//# sourceMappingURL=frontend.js.map