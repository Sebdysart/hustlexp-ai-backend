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
// Phase 3: Critical gap routers
import { taskDiscoveryRouter } from './taskDiscovery';
import { messagingRouter } from './messaging';
import { notificationRouter } from './notification';
import { ratingRouter } from './rating';
import { gdprRouter } from './gdpr';
import { analyticsRouter } from './analytics';
import { fraudRouter } from './fraud';
import { moderationRouter } from './moderation';

export const appRouter = router({
  task: taskRouter,
  escrow: escrowRouter,
  user: userRouter,
  ai: aiRouter,
  live: liveRouter,
  health: healthRouter,
  ui: uiRouter,
  // Phase 3: Critical gap routers
  taskDiscovery: taskDiscoveryRouter,
  messaging: messagingRouter,
  notification: notificationRouter,
  rating: ratingRouter,
  gdpr: gdprRouter,
  analytics: analyticsRouter,
  fraud: fraudRouter,
  moderation: moderationRouter,
});

export type AppRouter = typeof appRouter;
