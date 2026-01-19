import { TrustService } from '../services/TrustService.js';
import { optionalAuth } from '../middleware/firebaseAuth.js';
import { logger } from '../utils/logger.js';
export default async function trustRoutes(fastify) {
    // Public user profile
    fastify.get('/profile/:userId', async (request, reply) => {
        const { userId } = request.params;
        try {
            const profile = await TrustService.getPublicProfile(userId);
            return profile;
        }
        catch (error) {
            if (error?.code === 'USER_NOT_FOUND') {
                reply.status(404);
                return { error: 'User not found' };
            }
            logger.error({ error, userId }, 'Failed to load public profile');
            reply.status(503);
            return { error: 'Trust data unavailable' };
        }
    });
    // Verified task history (completed tasks only)
    fastify.get('/profile/:userId/history', async (request, reply) => {
        const { userId } = request.params;
        const { limit, offset } = request.query;
        try {
            const history = await TrustService.getTaskHistory(userId, {
                limit: limit ? parseInt(limit) : undefined,
                offset: offset ? parseInt(offset) : undefined,
            });
            return {
                user_id: userId,
                total: history.total,
                limit: history.items.length,
                offset: offset ? parseInt(offset) : 0,
                has_more: history.total > ((offset ? parseInt(offset) : 0) + history.items.length),
                tasks: history.items,
            };
        }
        catch (error) {
            logger.error({ error, userId }, 'Failed to load task history');
            reply.status(503);
            return { error: 'Trust data unavailable' };
        }
    });
    // Mutual trust signal between viewer and target
    fastify.get('/mutual/:userId', { preHandler: [optionalAuth] }, async (request, reply) => {
        const { userId } = request.params;
        if (!request.dbUser?.id) {
            reply.status(401);
            return { error: 'Authentication required to compute mutual trust' };
        }
        try {
            const mutual = await TrustService.getMutualTaskConnections(userId, request.dbUser.id);
            return {
                user_id: userId,
                viewer_id: request.dbUser.id,
                mutual_task_connections: mutual,
                explanation: `You and this user have both worked with ${mutual} of the same people`,
            };
        }
        catch (error) {
            logger.error({ error, userId, viewerId: request.dbUser.id }, 'Failed to compute mutual trust');
            reply.status(503);
            return { error: 'Trust data unavailable' };
        }
    });
    // Trust summary for profile view
    fastify.get('/profile/:userId/summary', { preHandler: [optionalAuth] }, async (request, reply) => {
        const { userId } = request.params;
        const viewerId = request.dbUser?.id;
        try {
            const summary = await TrustService.getTrustSummary(userId, viewerId);
            return {
                ...summary,
                mutual_task_connections: viewerId ? summary.mutual_task_connections : null,
            };
        }
        catch (error) {
            logger.error({ error, userId, viewerId }, 'Failed to build trust summary');
            reply.status(503);
            return { error: 'Trust data unavailable' };
        }
    });
}
//# sourceMappingURL=trust.js.map