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
import { instantRouter } from './instant';
// Phase 3: Critical gap routers
import { taskDiscoveryRouter } from './taskDiscovery';
import { messagingRouter } from './messaging';
import { notificationRouter } from './notification';
import { ratingRouter } from './rating';
import { gdprRouter } from './gdpr';
import { analyticsRouter } from './analytics';
import { fraudRouter } from './fraud';
import { moderationRouter } from './moderation';
import { alphaTelemetryRouter } from './alpha-telemetry';
// v1.8.0: Gamification routers
import { xpTaxRouter } from './xpTax';
import { insuranceRouter } from './insurance';
import { biometricRouter } from './biometric';
// v2.0.0: Business model gap-fill routers
import { skillsRouter } from './skills';
import { pricingRouter } from './pricing';
import { geofenceRouter } from './geofence';
import { heatmapRouter } from './heatmap';
import { batchQuestRouter } from './batchQuest';
import { tutorialRouter } from './tutorial';
import { juryRouter } from './jury';

export const appRouter = router({
  task: taskRouter,
  escrow: escrowRouter,
  user: userRouter,
  ai: aiRouter,
  live: liveRouter,
  health: healthRouter,
  ui: uiRouter,
  instant: instantRouter,
  // Phase 3: Critical gap routers
  taskDiscovery: taskDiscoveryRouter,
  messaging: messagingRouter,
  notification: notificationRouter,
  rating: ratingRouter,
  gdpr: gdprRouter,
  analytics: analyticsRouter,
  fraud: fraudRouter,
  moderation: moderationRouter,
  // Alpha Instrumentation
  alphaTelemetry: alphaTelemetryRouter,
  // v1.8.0: Gamification routers
  xpTax: xpTaxRouter,
  insurance: insuranceRouter,
  biometric: biometricRouter,
  // v2.0.0: Business model gap-fill routers
  skills: skillsRouter,
  pricing: pricingRouter,
  geofence: geofenceRouter,
  heatmap: heatmapRouter,
  batchQuest: batchQuestRouter,
  tutorial: tutorialRouter,
  jury: juryRouter,
});

export type AppRouter = typeof appRouter;
