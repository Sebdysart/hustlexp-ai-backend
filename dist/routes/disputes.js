import z from 'zod';
import { requireAuth, requireAdminFromJWT } from '../middleware/firebaseAuth.js';
import { DisputeService } from '../services/DisputeService.js';
const CreateDisputeSchema = z.object({
    taskId: z.string().uuid(),
    reason: z.string().min(10)
});
const AddEvidenceSchema = z.object({
    urls: z.array(z.string().url()).min(1)
});
const RespondSchema = z.object({
    message: z.string().min(10)
});
export default async function disputeRoutes(fastify) {
    // POST /api/disputes - Create (Poster)
    fastify.post('/', { preHandler: [requireAuth] }, async (request, reply) => {
        if (!request.user)
            return reply.status(401).send({ error: 'Unauthorized' });
        const body = CreateDisputeSchema.parse(request.body);
        const result = await DisputeService.createDispute({
            taskId: body.taskId,
            posterUid: request.user.uid,
            reason: body.reason
        });
        if (!result.success) {
            return reply.status(400).send({ error: result.message });
        }
        return { success: true, disputeId: result.disputeId, status: result.status };
    });
    // POST /api/disputes/:id/evidence - Add Evidence (Poster)
    fastify.post('/:id/evidence', { preHandler: [requireAuth] }, async (request, reply) => {
        if (!request.user)
            return reply.status(401).send({ error: 'Unauthorized' });
        const { id } = request.params;
        const body = AddEvidenceSchema.parse(request.body);
        const result = await DisputeService.addEvidence(id, request.user.uid, body.urls);
        if (!result.success) {
            return reply.status(400).send({ error: result.message });
        }
        return { success: true, message: result.message };
    });
    // POST /api/disputes/:id/respond - Response (Hustler)
    fastify.post('/:id/respond', { preHandler: [requireAuth] }, async (request, reply) => {
        if (!request.user)
            return reply.status(401).send({ error: 'Unauthorized' });
        const { id } = request.params;
        const body = RespondSchema.parse(request.body);
        const result = await DisputeService.submitResponse(id, request.user.uid, body.message);
        if (!result.success) {
            return reply.status(400).send({ error: result.message });
        }
        return { success: true, message: result.message };
    });
    // POST /api/disputes/:id/refund - Admin Resolve (Refund)
    fastify.post('/:id/refund', { preHandler: [requireAuth, requireAdminFromJWT] }, async (request, reply) => {
        const { id } = request.params;
        // Admin ID from token
        const adminId = request.user.uid;
        const result = await DisputeService.resolveRefund(id, adminId);
        if (!result.success) {
            return reply.status(400).send({ error: result.message });
        }
        return { success: true, message: result.message };
    });
    // POST /api/disputes/:id/uphold - Admin Resolve (Uphold)
    fastify.post('/:id/uphold', { preHandler: [requireAuth, requireAdminFromJWT] }, async (request, reply) => {
        const { id } = request.params;
        const adminId = request.user.uid;
        const result = await DisputeService.resolveUphold(id, adminId);
        if (!result.success) {
            return reply.status(400).send({ error: result.message });
        }
        return { success: true, message: result.message };
    });
}
//# sourceMappingURL=disputes.js.map