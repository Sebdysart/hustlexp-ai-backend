/**
 * HustleXP App Router v1.0.0
 * 
 * CONSTITUTIONAL: Main tRPC router combining all domain routers
 * 
 * @see ARCHITECTURE.md §1
 */

import { router } from '../trpc.js';
import { taskRouter } from './task.js';
import { escrowRouter } from './escrow.js';
import { userRouter } from './user.js';
import { aiRouter } from './ai.js';
import { liveRouter } from './live.js';
import { healthRouter } from './health.js';
import { uiRouter } from './ui.js';
import { instantRouter } from './instant.js';
// Phase 3: Critical gap routers
import { taskDiscoveryRouter } from './taskDiscovery.js';
import { messagingRouter } from './messaging.js';
import { notificationRouter } from './notification.js';
import { ratingRouter } from './rating.js';
import { gdprRouter } from './gdpr.js';
import { analyticsRouter } from './analytics.js';
import { fraudRouter } from './fraud.js';
import { moderationRouter } from './moderation.js';
import { alphaTelemetryRouter } from './alpha-telemetry.js';
// v1.8.0: Gamification routers
import { xpTaxRouter } from './xpTax.js';
import { insuranceRouter } from './insurance.js';
import { biometricRouter } from './biometric.js';
// v2.0.0: Business model gap-fill routers
import { skillsRouter } from './skills.js';
import { pricingRouter } from './pricing.js';
import { geofenceRouter } from './geofence.js';
import { heatmapRouter } from './heatmap.js';
import { batchQuestRouter } from './batchQuest.js';
import { tutorialRouter } from './tutorial.js';
import { juryRouter } from './jury.js';
import { uploadRouter } from './upload.js';
// v2.1.0: AI agent routers
import { matchmakerRouter } from './matchmaker.js';
import { disputeAIRouter } from './disputeAI.js';
import { reputationRouter } from './reputation.js';
// v2.1.0: Business feature routers
import { betaDashboardRouter } from './betaDashboard.js';
import { challengesRouter } from './challenges.js';
import { expertiseSupplyRouter } from './expertiseSupply.js';
import { featuredRouter } from './featured.js';
import { referralRouter } from './referral.js';
import { subscriptionRouter } from './subscription.js';
import { tippingRouter } from './tipping.js';
// v2.4.0: Squads Mode
import { squadRouter } from './squad.js';
// v2.4.0: Recurring Tasks
import { recurringTaskRouter } from './recurringTask.js';
// v2.5.0: Stripe Connect
import { stripeConnectRouter } from './stripeConnect.js';
// v2.6.0: Feature Flags
import { flagsRouter } from './flags.js';
// v3.0.0: Core capability services (audit fix)
import { capabilityRouter } from './capability.js';
// v3.0.0: Admin Dashboard
import { adminRouter } from './admin.js';
// Phase 5: Incident Intelligence
import { incidentsRouter } from './incidents.js';
// Phase 6: Intent Bridge
import { intentRouter } from './intent.js';
// v3.1.0: Task Batching AI
import { batchingRouter } from './batching.js';
// v3.1.0: Movement Tracking
import { trackingRouter } from './tracking.js';

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
  upload: uploadRouter,
  // v2.1.0: AI agent routers
  matchmaker: matchmakerRouter,
  disputeAI: disputeAIRouter,
  reputation: reputationRouter,
  // v2.1.0: Business feature routers
  betaDashboard: betaDashboardRouter,
  challenges: challengesRouter,
  expertiseSupply: expertiseSupplyRouter,
  featured: featuredRouter,
  referral: referralRouter,
  subscription: subscriptionRouter,
  tipping: tippingRouter,
  // v2.4.0: Squads Mode
  squad: squadRouter,
  // v2.4.0: Recurring Tasks
  recurringTask: recurringTaskRouter,
  // v2.5.0: Stripe Connect
  stripeConnect: stripeConnectRouter,
  // v2.6.0: Feature Flags
  flags: flagsRouter,
  // v3.0.0: Core capability services (audit fix)
  capability: capabilityRouter,
  // v3.0.0: Admin Dashboard
  admin: adminRouter,
  // Phase 5: Incident Intelligence
  incidents: incidentsRouter,
  // Phase 6: Intent Bridge
  intent: intentRouter,
  // v3.1.0: Task Batching AI
  batching: batchingRouter,
  // v3.1.0: Movement Tracking
  tracking: trackingRouter,
});

export type AppRouter = typeof appRouter;
