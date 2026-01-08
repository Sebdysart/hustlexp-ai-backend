/**
 * HustleXP App Router v1.0.0
 * 
 * CONSTITUTIONAL: Main tRPC router combining all domain routers
 * 
 * @see ARCHITECTURE.md §1
 */

import { router } from '../trpc';
import { taskRouter } from './task';
import { escrowRouter } from './escrow';
import { userRouter } from './user';
import { healthRouter } from './health';

export const appRouter = router({
  task: taskRouter,
  escrow: escrowRouter,
  user: userRouter,
  health: healthRouter,
});

export type AppRouter = typeof appRouter;
