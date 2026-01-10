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
import { aiRouter } from './ai';
import { liveRouter } from './live';
import { healthRouter } from './health';
import { uiRouter } from './ui';

export const appRouter = router({
  task: taskRouter,
  escrow: escrowRouter,
  user: userRouter,
  ai: aiRouter,
  live: liveRouter,
  health: healthRouter,
  ui: uiRouter,
});

export type AppRouter = typeof appRouter;
