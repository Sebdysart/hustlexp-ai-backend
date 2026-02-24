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
import { uploadRouter } from './upload';
// v2.1.0: AI agent routers
import { matchmakerRouter } from './matchmaker';
import { disputeAIRouter } from './disputeAI';
import { reputationRouter } from './reputation';
// v2.1.0: Business feature routers
import { betaDashboardRouter } from './betaDashboard';
import { challengesRouter } from './challenges';
import { expertiseSupplyRouter } from './expertiseSupply';
import { featuredRouter } from './featured';
import { referralRouter } from './referral';
import { subscriptionRouter } from './subscription';
import { tippingRouter } from './tipping';
// v2.4.0: Squads Mode
import { squadRouter } from './squad';
// v2.5.0: Stripe Connect
import { stripeConnectRouter } from './stripeConnect';
// v2.6.0: Feature Flags
import { flagsRouter } from './flags';
// v3.0.0: Core capability services (audit fix)
import { capabilityRouter } from './capability';
// v3.0.0: Admin Dashboard
import { adminRouter } from './admin';
// Phase 5: Incident Intelligence
import { incidentsRouter } from './incidents';
// Phase 6: Intent Bridge
import { intentRouter } from './intent';
// v3.1.0: Task Batching AI
import { batchingRouter } from './batching';
// v3.1.0: Movement Tracking
import { trackingRouter } from './tracking';

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
