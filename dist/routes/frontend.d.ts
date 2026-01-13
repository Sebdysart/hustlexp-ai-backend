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
import { FastifyInstance, FastifyPluginOptions } from 'fastify';
export default function frontendRoutes(fastify: FastifyInstance, opts: FastifyPluginOptions): Promise<void>;
//# sourceMappingURL=frontend.d.ts.map