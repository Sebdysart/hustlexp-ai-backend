import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TPEEService } from '../services/TPEEService.js';
import { StripeService } from '../services/StripeService.js';
import { DisputeService, type DisputeStatus } from '../services/DisputeService.js';
import { SafetyService } from '../services/SafetyService.js';
import { MetricsService } from '../services/MetricsService.js';
import { EventLogger, type EventType } from '../utils/EventLogger.js';
import { JobController } from '../services/JobController.js';
import { CityService } from '../services/CityService.js';
import { RulesService } from '../services/RulesService.js';
import { FeatureFlagService } from '../services/FeatureFlagService.js';
import { getProviderHealth, getAllCircuitStates, resetCircuit } from '../utils/reliability.js';
import { NotificationService } from '../services/NotificationService.js';
import { InviteService } from '../services/InviteService.js';
import { getAPIDocs, getEndpointsByTag } from '../utils/apiDocs.js';
import { TaskOutcomeService } from '../services/TaskOutcomeService.js';
import { TPEEAIEscalation } from '../services/TPEEAIEscalation.js';
import { ProofValidationService } from '../services/ProofValidationService.js';
import { logger } from '../utils/logger.js';
import { requireAuth, requireFreshToken, requireAdminFromJWT } from '../middleware/firebaseAuth.js';

// ============================================
// Admin Route Module
// ============================================

// Parse date range from query params
function parseDateRange(query: { since?: string; until?: string }): { since?: Date; until?: Date } {
    return {
        since: query.since ? new Date(query.since) : undefined,
        until: query.until ? new Date(query.until) : undefined,
    };
}

const ResolveDisputeSchema = z.object({
    resolution: z.enum(['refund', 'payout', 'split']),
    resolutionNote: z.string().optional(),
    splitAmountHustler: z.number().optional(),
    splitAmountPoster: z.number().optional(),
});

const AddStrikeSchema = z.object({
    reason: z.string().min(5),
    severity: z.number().min(1).max(3),
    taskId: z.string().optional(),
});

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
    // ============================================
    // TPEE Admin Endpoints
    // ============================================

    // Get TPEE stats
    fastify.get('/api/admin/tpee/stats', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        const stats = TPEEService.getStats();
        return {
            success: true,
            shadowMode: TPEEService.isShadowMode(),
            stats,
        };
    });

    // Get recent TPEE logs
    fastify.get('/api/admin/tpee/logs', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { limit } = request.query as { limit?: string };
        const logs = TPEEService.getRecentLogs(limit ? parseInt(limit) : 50);
        return {
            success: true,
            count: logs.length,
            logs,
        };
    });

    // Toggle shadow mode (admin only, dangerous)
    fastify.post('/api/admin/tpee/shadow-mode', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request, reply) => {
        const { enabled } = request.body as { enabled: boolean };

        if (typeof enabled !== 'boolean') {
            reply.status(400);
            return { error: 'enabled must be a boolean' };
        }

        TPEEService.setShadowMode(enabled);

        return {
            success: true,
            shadowMode: TPEEService.isShadowMode(),
            message: enabled
                ? 'Shadow mode enabled - TPEE logs but does not block'
                : 'Shadow mode DISABLED - TPEE will block/adjust tasks',
        };
    });

    // Get TPEE decision quality report
    fastify.get('/api/admin/tpee/decision-quality', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        const report = await TaskOutcomeService.getTPEEDecisionQualityReport();
        return {
            success: true,
            report,
        };
    });

    // Get blocked user outcome analysis
    fastify.get('/api/admin/tpee/blocked-user-analysis', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        const analysis = await TaskOutcomeService.getBlockedUserOutcomeAnalysis();
        return {
            success: true,
            analysis,
        };
    });

    // Get AI escalation status
    fastify.get('/api/admin/tpee/ai/status', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        return {
            success: true,
            status: TPEEAIEscalation.getStatus(),
        };
    });

    // Toggle pricing classifier
    fastify.post('/api/admin/tpee/ai/pricing-classifier', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request, reply) => {
        const { enabled } = request.body as { enabled: boolean };
        if (typeof enabled !== 'boolean') {
            reply.status(400);
            return { error: 'enabled must be a boolean' };
        }
        TPEEAIEscalation.setPricingClassifier(enabled);
        return { success: true, status: TPEEAIEscalation.getStatus() };
    });

    // Toggle scam classifier
    fastify.post('/api/admin/tpee/ai/scam-classifier', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request, reply) => {
        const { enabled } = request.body as { enabled: boolean };
        if (typeof enabled !== 'boolean') {
            reply.status(400);
            return { error: 'enabled must be a boolean' };
        }
        TPEEAIEscalation.setScamClassifier(enabled);
        return { success: true, status: TPEEAIEscalation.getStatus() };
    });

    // Master switch for AI escalation
    fastify.post('/api/admin/tpee/ai/escalation', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request, reply) => {
        const { enabled } = request.body as { enabled: boolean };
        if (typeof enabled !== 'boolean') {
            reply.status(400);
            return { error: 'enabled must be a boolean' };
        }
        TPEEAIEscalation.setEscalation(enabled);
        return { success: true, status: TPEEAIEscalation.getStatus() };
    });

    // ============================================
    // Admin Endpoints - Phase C (Disputes, Safety, Strikes)
    // ============================================

    // SECURITY: All admin endpoints use requireAdminFromJWT which validates
    // the admin claim from the cryptographically signed JWT, NOT from DB.

    // List disputes with filters
    fastify.get('/api/admin/disputes', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { status, posterId, hustlerId, limit } = request.query as {
            status?: DisputeStatus;
            posterId?: string;
            hustlerId?: string;
            limit?: string;
        };

        const disputes = await DisputeService.listDisputes({
            status,
            posterId,
            hustlerId,
            limit: limit ? parseInt(limit) : 50,
        });

        return {
            disputes,
            count: disputes.length,
            stats: await DisputeService.getStats(),
        };
    });

    // Get single dispute with full details
    fastify.get('/api/admin/disputes/:disputeId', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request, reply) => {
        const { disputeId } = request.params as { disputeId: string };
        const dispute = await DisputeService.getDispute(disputeId);

        if (!dispute) {
            reply.status(404);
            return { error: 'Dispute not found' };
        }

        // Get related data
        const escrow = StripeService.getEscrow(dispute.taskId);
        const proofs = ProofValidationService.getProofsForTask(dispute.taskId);
        const moderationLogs = SafetyService.getModerationLogs({ taskId: dispute.taskId });
        const hustlerStrikes = await DisputeService.getUserStrikes(dispute.hustlerId);
        const posterStrikes = await DisputeService.getUserStrikes(dispute.posterId);

        return {
            dispute,
            escrow,
            proofs,
            moderationLogs,
            hustlerStrikes: hustlerStrikes.length,
            posterStrikes: posterStrikes.length,
        };
    });

    // Resolve dispute (admin action)
    fastify.post('/api/admin/disputes/:disputeId/resolve', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request, reply) => {
        try {
            const { disputeId } = request.params as { disputeId: string };
            const body = ResolveDisputeSchema.parse(request.body);
            const adminId = (request as { user?: { uid?: string } }).user?.uid || 'admin';

            const result = await DisputeService.resolveDispute(
                disputeId,
                adminId,
                body.resolution,
                {
                    resolutionNote: body.resolutionNote,
                    splitAmountHustler: body.splitAmountHustler,
                    splitAmountPoster: body.splitAmountPoster,
                }
            );

            if (!result.success) {
                reply.status(400);
                return { error: result.message };
            }

            return result;
        } catch (error) {
            logger.error({ error }, 'Dispute resolution error');
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            reply.status(500);
            return { error: 'Failed to resolve dispute' };
        }
    });

    // Get moderation logs with filters
    fastify.get('/api/admin/moderation/logs', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { userId, taskId, type, severity, limit } = request.query as {
            userId?: string;
            taskId?: string;
            type?: string;
            severity?: 'info' | 'warn' | 'critical';
            limit?: string;
        };

        const logs = SafetyService.getModerationLogs({
            userId,
            taskId,
            type: type as string | undefined,
            severity,
            limit: limit ? parseInt(limit) : 100,
        });

        return {
            logs,
            count: logs.length,
            stats: SafetyService.getStats(),
        };
    });

    // Get user strikes
    fastify.get('/api/admin/user/:userId/strikes', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { userId } = request.params as { userId: string };
        const strikes = await DisputeService.getUserStrikes(userId);
        const suspension = await DisputeService.isUserSuspended(userId);

        return {
            strikes,
            count: strikes.length,
            suspension,
        };
    });

    // Add manual strike (admin)
    fastify.post('/api/admin/user/:userId/strikes', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request, reply) => {
        try {
            const { userId } = request.params as { userId: string };
            const body = AddStrikeSchema.parse(request.body);

            const strike = await DisputeService.addStrike(
                userId,
                body.reason,
                body.severity as 1 | 2 | 3,
                'manual',
                { taskId: body.taskId }
            );

            const suspension = await DisputeService.isUserSuspended(userId);

            return {
                strike,
                suspension,
            };
        } catch (error) {
            logger.error({ error }, 'Add strike error');
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            reply.status(500);
            return { error: 'Failed to add strike' };
        }
    });

    // Unsuspend user (admin)
    fastify.post('/api/admin/user/:userId/unsuspend', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request, reply) => {
        const { userId } = request.params as { userId: string };

        const success = await DisputeService.unsuspendUser(userId);

        if (!success) {
            reply.status(400);
            return { error: 'User was not suspended' };
        }

        return { success: true, message: 'Revoked all sessions for user' };
    });

    // DEBUG: Restore Connect account mapping manually (Admin only)
    fastify.post('/api/admin/debug/link-connect', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { userId, accountId } = request.body as { userId: string; accountId: string };
        await StripeService.setConnectAccountId(userId, accountId);
        return { success: true, message: `Linked ${userId} to ${accountId}` };
    });

    // Check user suspension status (public, for app use)
    fastify.get('/api/user/:userId/suspension', async (request) => {
        const { userId } = request.params as { userId: string };
        return DisputeService.isUserSuspended(userId);
    });

    // Safety stats (admin)
    fastify.get('/api/admin/safety/stats', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        return {
            moderation: SafetyService.getStats(),
            disputes: await DisputeService.getStats(),
        };
    });

    // ============================================
    // Admin Insights API - Phase D (Metrics & Analytics)
    // ============================================

    // Get global funnel metrics
    fastify.get('/api/admin/metrics/funnel', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const range = parseDateRange(request.query as { since?: string; until?: string });
        const funnel = MetricsService.getGlobalFunnel(range);

        return {
            ...funnel,
            range: {
                since: range.since?.toISOString(),
                until: range.until?.toISOString(),
            },
        };
    });

    // Get zone health metrics
    fastify.get('/api/admin/metrics/zones', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const range = parseDateRange(request.query as { since?: string; until?: string });
        const zones = MetricsService.getZoneHealth(range);

        return {
            zones,
            count: zones.length,
            range: {
                since: range.since?.toISOString(),
                until: range.until?.toISOString(),
            },
        };
    });

    // Get AI metrics summary
    fastify.get('/api/admin/metrics/ai', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const range = parseDateRange(request.query as { since?: string; until?: string });
        const summary = MetricsService.getAIMetricsSummary(range);

        const totalCalls = summary.reduce((sum, s) => sum + s.calls, 0);
        const totalCost = summary.reduce((sum, s) => sum + s.totalCostUsd, 0);

        return {
            summary,
            totals: {
                calls: totalCalls,
                costUsd: totalCost,
                avgCostPerCall: totalCalls > 0 ? totalCost / totalCalls : 0,
            },
            range: {
                since: range.since?.toISOString(),
                until: range.until?.toISOString(),
            },
        };
    });

    // Get hustler earnings summary
    fastify.get('/api/admin/metrics/hustler/:userId', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { userId } = request.params as { userId: string };
        const range = parseDateRange(request.query as { since?: string; until?: string });

        const summary = MetricsService.getUserEarningsSummary(userId, range);

        return {
            ...summary,
            range: {
                since: range.since?.toISOString(),
                until: range.until?.toISOString(),
            },
        };
    });

    // Get events log (paginated)
    fastify.get('/api/admin/events', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { eventType, userId, taskId, source, limit } = request.query as {
            eventType?: EventType;
            userId?: string;
            taskId?: string;
            source?: 'frontend' | 'backend' | 'ai';
            limit?: string;
        };
        const range = parseDateRange(request.query as { since?: string; until?: string });

        const events = EventLogger.getEvents({
            eventType,
            userId,
            taskId,
            source,
            since: range.since,
            until: range.until,
            limit: limit ? parseInt(limit) : 50,
        });

        return {
            events,
            count: events.length,
        };
    });

    // Get overall stats dashboard
    fastify.get('/api/admin/metrics/overview', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        return MetricsService.getOverallStats();
    });

    // Get sample data for documentation
    fastify.get('/api/admin/metrics/samples', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        return {
            sampleEvent: EventLogger.getSampleEvent(),
            sampleAIMetric: MetricsService.getSampleAIMetric(),
            sampleFunnel: MetricsService.getGlobalFunnel(),
        };
    });

    // ============================================
    // Admin Jobs & Config API - Phase E
    // ============================================

    // --- Background Jobs ---

    // Daily maintenance job
    fastify.post('/api/admin/jobs/run/daily-maintenance', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        return JobController.runDailyMaintenance();
    });

    // Weekly maintenance job
    fastify.post('/api/admin/jobs/run/weekly-maintenance', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        return JobController.runWeeklyMaintenance();
    });

    // Hourly health check
    fastify.post('/api/admin/jobs/run/hourly-health', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        return JobController.runHourlyHealth();
    });

    // Get job history
    fastify.get('/api/admin/jobs/history', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { limit } = request.query as { limit?: string };
        return { jobs: JobController.getJobHistory(limit ? parseInt(limit) : 20) };
    });

    // Get daily metrics snapshots
    fastify.get('/api/admin/metrics/daily', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { cityId, limit } = request.query as { cityId?: string; limit?: string };
        return { snapshots: JobController.getDailySnapshots({ cityId, limit: limit ? parseInt(limit) : 30 }) };
    });

    // Get weekly metrics snapshots
    fastify.get('/api/admin/metrics/weekly', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { cityId, limit } = request.query as { cityId?: string; limit?: string };
        return { snapshots: JobController.getWeeklySnapshots({ cityId, limit: limit ? parseInt(limit) : 12 }) };
    });

    // --- City & Zone Config ---

    // Get all active cities
    fastify.get('/api/admin/cities', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        return { cities: CityService.getActiveCities(), stats: CityService.getCoverageStats() };
    });

    // Get zones for a city
    fastify.get('/api/admin/cities/:cityId/zones', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { cityId } = request.params as { cityId: string };
        return { zones: CityService.getZonesForCity(cityId) };
    });

    // Resolve location (public - useful for app)
    fastify.post('/api/location/resolve', async (request) => {
        const { lat, lng } = request.body as { lat: number; lng: number };
        return CityService.resolveCityFromLatLng(lat, lng);
    });

    // --- Marketplace Rules ---

    // Get all rules for a city
    fastify.get('/api/admin/rules/:cityId', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { cityId } = request.params as { cityId: string };
        return { rules: RulesService.getAllRules(cityId), sample: RulesService.getSampleRuleRow() };
    });

    // Set a rule
    fastify.post('/api/admin/rules/:cityId', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request, reply) => {
        const { cityId } = request.params as { cityId: string };
        const { key, value } = request.body as { key: string; value: unknown };

        if (!key) {
            reply.status(400);
            return { error: 'Key required' };
        }

        RulesService.setRule(cityId, key, value);
        return { success: true, key, value };
    });

    // --- Feature Flags ---

    // Get all flags
    fastify.get('/api/admin/flags', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        return { flags: FeatureFlagService.getAllFlags() };
    });

    // Check if flag enabled (public - useful for app)
    fastify.get('/api/flags/:key', async (request) => {
        const { key } = request.params as { key: string };
        const { cityId, userId } = request.query as { cityId?: string; userId?: string };
        return { enabled: FeatureFlagService.isEnabled(key, { cityId, userId }) };
    });

    // Toggle flag (admin)
    fastify.post('/api/admin/flags/:key/toggle', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { key } = request.params as { key: string };
        const enabled = FeatureFlagService.toggleFlag(key);
        return { key, enabled };
    });

    // Set city override
    fastify.post('/api/admin/flags/:key/city-override', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request, reply) => {
        const { key } = request.params as { key: string };
        const { cityId, enabled } = request.body as { cityId: string; enabled: boolean };

        if (!cityId) {
            reply.status(400);
            return { error: 'cityId required' };
        }

        const override = FeatureFlagService.setCityOverride(key, cityId, enabled);
        return override ? { success: true, override } : { error: 'Flag not found' };
    });

    // --- Reliability & Health ---

    // Get provider health
    fastify.get('/api/admin/health/providers', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        return { providers: getProviderHealth(), circuits: getAllCircuitStates() };
    });

    // Reset a circuit breaker
    fastify.post('/api/admin/health/reset-circuit/:provider', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { provider } = request.params as { provider: string };
        resetCircuit(provider);
        return { success: true, provider, message: 'Circuit reset' };
    });

    // ============================================
    // Phase F — Admin Console, Beta Guardrails & API Docs
    // ============================================

    // --- API Documentation ---

    // Get full API docs (public for mobile app)
    fastify.get('/api/docs', async () => {
        return getAPIDocs();
    });

    // Get docs by tag
    fastify.get('/api/docs/:tag', async (request) => {
        const { tag } = request.params as { tag: string };
        return { endpoints: getEndpointsByTag(tag) };
    });

    // --- Beta Guardrails ---

    // Validate invite code (public - for signup flow)
    fastify.post('/api/beta/validate-invite', async (request) => {
        const { code, role, cityId } = request.body as { code: string; role: 'hustler' | 'poster'; cityId?: string };

        if (!code || !role) {
            return { valid: false, reason: 'MISSING_PARAMS' };
        }

        return InviteService.validate(code, role, cityId);
    });

    // Check signup allowed (public - for signup flow)
    fastify.post('/api/beta/check-signup', async (request) => {
        const { role, cityId, inviteCode } = request.body as {
            role: 'hustler' | 'poster';
            cityId: string;
            inviteCode?: string;
        };

        return InviteService.checkSignupAllowed(role, cityId, inviteCode);
    });

    // Consume invite (called after successful signup)
    fastify.post('/api/beta/consume-invite', { preHandler: [requireAuth] }, async (request) => {
        const { code, userId } = request.body as { code: string; userId: string };

        if (!code || !userId) {
            return { success: false, reason: 'MISSING_PARAMS' };
        }

        const consumed = InviteService.consume(code, userId);
        return { success: consumed };
    });

    // --- Admin Beta Management ---

    // Create invite code
    fastify.post('/api/admin/beta/invites', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { code, role, cityId, maxUses, expiresAt } = request.body as {
            code: string;
            role: 'hustler' | 'poster' | 'both';
            cityId?: string;
            maxUses?: number;
            expiresAt?: string;
        };

        if (!code || !role) {
            return { error: 'code and role required' };
        }

        const invite = InviteService.createInvite(code, role, {
            cityId,
            maxUses,
            expiresAt: expiresAt ? new Date(expiresAt) : undefined,
            createdBy: request.user?.uid,
        });

        return { invite };
    });

    // List all invites
    fastify.get('/api/admin/beta/invites', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        return {
            invites: InviteService.getAllInvites(),
            sample: InviteService.getSampleRow(),
        };
    });

    // Get city capacity stats
    fastify.get('/api/admin/beta/city-stats/:cityId', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { cityId } = request.params as { cityId: string };
        return InviteService.getCityStats(cityId);
    });

    // --- Admin Notifications ---

    // Get notification stats
    fastify.get('/api/admin/notifications/stats', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        return NotificationService.getStats();
    });

    // List notifications
    fastify.get('/api/admin/notifications', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { type, status, limit } = request.query as {
            type?: string;
            status?: 'pending' | 'sent' | 'failed';
            limit?: string;
        };

        return {
            notifications: NotificationService.getAllNotifications({
                type,
                status,
                limit: limit ? parseInt(limit) : 50,
            }),
            sample: NotificationService.getSampleRow(),
        };
    });

    // Get user notifications
    fastify.get('/api/notifications', { preHandler: [requireAuth] }, async (request) => {
        const userId = request.user?.uid;
        if (!userId) return { notifications: [] };

        return {
            notifications: NotificationService.getNotifications(userId, { limit: 20 }),
        };
    });

    // --- Admin Users (extended) ---

    // Force complete a task
    fastify.post('/api/admin/tasks/:taskId/force-complete', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { taskId } = request.params as { taskId: string };
        const { reason } = request.body as { reason?: string };
        const adminId = request.user?.uid ?? 'system';

        EventLogger.logEvent({
            eventType: 'custom',
            taskId,
            source: 'backend',
            metadata: { type: 'admin_action', action: 'force_complete', adminId, reason },
        });

        return { success: true, taskId, action: 'force_complete', reason };
    });

    // Force refund a task
    fastify.post('/api/admin/tasks/:taskId/force-refund', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async (request) => {
        const { taskId } = request.params as { taskId: string };
        const { reason } = request.body as { reason?: string };
        const adminId = request.user?.uid ?? 'system';

        EventLogger.logEvent({
            eventType: 'payout_refunded',
            taskId,
            userId: adminId,
            source: 'backend',
            metadata: { type: 'admin_action', action: 'force_refund', adminId, reason },
        });

        return { success: true, taskId, action: 'force_refund', reason };
    });

    // Get AI routing config
    fastify.get('/api/admin/ai/routes', { preHandler: [requireAdminFromJWT, requireFreshToken] }, async () => {
        return {
            routes: {
                safety: 'openai',
                planning: 'deepseek',
                pricing: 'deepseek',
                intent: 'groq',
                translate: 'groq',
                small_aux: 'groq',
            },
        };
    });
}
