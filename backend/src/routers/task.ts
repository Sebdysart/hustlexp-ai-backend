import { router } from '../trpc.js';
import { TaskAcceptProcedures } from './TaskAcceptProcedures.js';
import { TaskApplicationProcedures } from './TaskApplicationProcedures.js';
import { TaskAssignmentProcedures } from './TaskAssignmentProcedures.js';
import { TaskCreateProcedures } from './TaskCreateProcedures.js';
import { TaskExecutionProcedures } from './TaskExecutionProcedures.js';
import { TaskReadProcedures } from './TaskReadProcedures.js';
import { TaskReviewProcedures } from './TaskReviewProcedures.js';
export { checkDraftEvalRateLimit, checkTaskCreateRateLimit } from './task-router-common.js';

// Security invariant: TaskReadProcedures authorizes non-participants through
// the admin_roles allowlist; the public router never trusts a profile role string.

export const taskRouter = router({
  ...TaskReadProcedures,
  ...TaskCreateProcedures,
  ...TaskAcceptProcedures,
  ...TaskExecutionProcedures,
  ...TaskReviewProcedures,
  ...TaskApplicationProcedures,
  ...TaskAssignmentProcedures,
});

export type TaskRouter = typeof taskRouter;
