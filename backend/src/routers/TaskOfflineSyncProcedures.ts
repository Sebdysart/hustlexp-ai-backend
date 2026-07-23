import { z } from 'zod';
import { reconcileOfflineActions } from '../services/OfflineActionReconciliationService.js';
import { protectedProcedure, Schemas } from '../trpc.js';

const offlineActionProbe = z.object({
  actionClass: z.enum(['PROOF_COMPLETION', 'SAFETY', 'EXECUTION']),
  clientIdentity: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/),
  clientSequence: z.number().int().positive(),
  priorServerVersion: z.number().int().positive(),
  localOccurredAt: z.string().datetime(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const TaskOfflineSyncProcedures = {
  reconcileOfflineActions: protectedProcedure
    .input(z.object({ taskId: Schemas.uuid, actions: z.array(offlineActionProbe).max(10) }).strict())
    .mutation(({ ctx, input }) => reconcileOfflineActions(input,ctx.user!.id)),
};
