/**
 * TaskService — stub for src/ context.
 * The full implementation lives in backend/src/services/TaskService.ts.
 */

export interface SrcTask {
  id: string;
  status: string;
  clientId: string;
  assignedHustlerId: string | null;
  escrowId?: string;
  amountCents?: number;
}

export const TaskService = {
  getTask: async (_taskId: string): Promise<SrcTask | null> => {
    return null;
  },
};
