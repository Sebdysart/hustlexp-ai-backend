import { logger } from '../utils/logger.js';
import { requireAuth } from '../middleware/firebaseAuth.js';
export default async function authRoutes(fastify) {
    /**
     * POST /auth/logout
     * Log out user (server-side audit only)
     * Client must discard token.
     */
    fastify.post('/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
        const user = request.user;
        logger.info({
            uid: user?.uid,
            ip: request.ip,
            action: 'USER_LOGOUT'
        }, 'User logged out');
        return {
            success: true,
            message: 'Logged out successfully'
        };
    });
}
//# sourceMappingURL=auth.js.map