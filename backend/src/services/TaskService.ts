import { TaskAbandonService } from './TaskAbandonService.js';
import { TaskAcceptService } from './TaskAcceptService.js';
import { TaskCloseService } from './TaskCloseService.js';
import { TaskCreateService } from './TaskCreateService.js';
import { TaskExecutionService } from './TaskExecutionService.js';
import { TaskProgressService } from './TaskProgressService.js';
import { TaskReadService } from './TaskReadService.js';
import { isTerminalState, isValidTransition } from './TaskServiceShared.js';
export { buildTaskCreateRequestHash } from './TaskServiceShared.js';

export const TaskService = {
  ...TaskReadService,
  ...TaskCreateService,
  ...TaskAcceptService,
  ...TaskExecutionService,
  ...TaskCloseService,
  ...TaskProgressService,
  ...TaskAbandonService,
  isTerminalState,
  isValidTransition,
};

export default TaskService;
