/**
 * HustleXP App Router v2.0.0
 *
 * CONSTITUTIONAL: Main tRPC router combining all domain routers
 *
 * Domain Organization:
 *   HUSTLER  — Procedures requiring default_mode='worker' (hustlerProcedure)
 *   POSTER   — Procedures requiring default_mode='poster' (posterProcedure)
 *   SHARED   — Both roles use these (protectedProcedure)
 *   ADMIN    — Requires admin_roles entry (adminProcedure)
 *   SYSTEM   — Internal / public infrastructure
 *
 * @see ARCHITECTURE.md §1
 * @see docs/plans/2026-03-14-domain-reorganization.md
 */

import { router } from '../trpc.js';

// ── HUSTLER DOMAIN ──────────────────────────────────────────────────────
// Workers discovering, claiming, and completing tasks.
// All procedures gated by hustlerProcedure (default_mode = 'worker').
import { taskDiscoveryRouter } from './taskDiscovery.js';
import { instantRouter } from './instant.js';
import { liveRouter } from './live.js';
import { stripeConnectRouter } from './stripeConnect.js';
import { xpTaxRouter } from './xpTax.js';
import { skillsRouter } from './skills.js';
import { referralRouter } from './referral.js';
import { geofenceRouter } from './geofence.js';
import { trackingRouter } from './tracking.js';
import { heatmapRouter } from './heatmap.js';
import { insuranceRouter } from './insurance.js';
import { challengesRouter } from './challenges.js';
import { capabilityRouter } from './capability.js';
import { batchingRouter } from './batching.js';
import { tippingRouter } from './tipping.js';
import { expertiseSupplyRouter } from './expertiseSupply.js';
import { biometricRouter } from './biometric.js';
import { aiRouter } from './ai.js';
import { intentRouter } from './intent.js';

// ── POSTER DOMAIN ───────────────────────────────────────────────────────
// Employers creating, managing, and paying for tasks.
// All procedures gated by posterProcedure (default_mode = 'poster').
import { recurringTaskRouter } from './recurringTask.js';
import { featuredRouter } from './featured.js';
import { pricingRouter } from './pricing.js';
import { subscriptionRouter } from './subscription.js';

// ── SHARED DOMAIN ───────────────────────────────────────────────────────
// Both roles use these. Mixed routers (task, escrow, squad) contain
// per-procedure role guards internally.
import { taskRouter } from './task.js';
import { escrowRouter } from './escrow.js';
import { userRouter } from './user.js';
import { squadRouter } from './squad.js';
import { messagingRouter } from './messaging.js';
import { notificationRouter } from './notification.js';
import { ratingRouter } from './rating.js';
import { uploadRouter } from './upload.js';
import { juryRouter } from './jury.js';
import { analyticsRouter } from './analytics.js';
import { gdprRouter } from './gdpr.js';
import { tutorialRouter } from './tutorial.js';
import { batchQuestRouter } from './batchQuest.js';
import { uiRouter } from './ui.js';
import { disputeRouter } from './dispute.js';

// ── ADMIN DOMAIN ────────────────────────────────────────────────────────
// Requires admin_roles table entry. Platform operations.
import { adminRouter } from './admin.js';
import { disputeAIRouter } from './disputeAI.js';
import { incidentsRouter } from './incidents.js';
import { moderationRouter } from './moderation.js';
import { matchmakerRouter } from './matchmaker.js';
import { betaDashboardRouter } from './betaDashboard.js';
import { reputationRouter } from './reputation.js';

// ── SYSTEM DOMAIN ───────────────────────────────────────────────────────
// Health checks, fraud detection, feature flags, telemetry.
// Public or internal — no user-facing role requirements.
import { healthRouter } from './health.js';
import { fraudRouter } from './fraud.js';
import { flagsRouter } from './flags.js';
import { alphaTelemetryRouter } from './alphaTelemetry.js';
import { geoRouter } from './geo.js';

// ============================================================================
// APP ROUTER
// ============================================================================

export const appRouter = router({
  // ── Hustler Domain ─────────────────────────────────────────────────────
  taskDiscovery: taskDiscoveryRouter,
  instant: instantRouter,
  live: liveRouter,
  stripeConnect: stripeConnectRouter,
  xpTax: xpTaxRouter,
  skills: skillsRouter,
  referral: referralRouter,
  geofence: geofenceRouter,
  tracking: trackingRouter,
  heatmap: heatmapRouter,
  insurance: insuranceRouter,
  challenges: challengesRouter,
  capability: capabilityRouter,
  batching: batchingRouter,
  tipping: tippingRouter,
  expertiseSupply: expertiseSupplyRouter,
  biometric: biometricRouter,
  ai: aiRouter,
  intent: intentRouter,

  // ── Poster Domain ──────────────────────────────────────────────────────
  recurringTask: recurringTaskRouter,
  featured: featuredRouter,
  pricing: pricingRouter,
  subscription: subscriptionRouter,

  // ── Shared Domain (per-procedure role guards inside) ───────────────────
  task: taskRouter,
  escrow: escrowRouter,
  user: userRouter,
  squad: squadRouter,
  messaging: messagingRouter,
  notification: notificationRouter,
  rating: ratingRouter,
  upload: uploadRouter,
  jury: juryRouter,
  analytics: analyticsRouter,
  gdpr: gdprRouter,
  tutorial: tutorialRouter,
  batchQuest: batchQuestRouter,
  ui: uiRouter,
  dispute: disputeRouter,

  // ── Admin Domain ───────────────────────────────────────────────────────
  admin: adminRouter,
  disputeAI: disputeAIRouter,
  incidents: incidentsRouter,
  moderation: moderationRouter,
  matchmaker: matchmakerRouter,
  betaDashboard: betaDashboardRouter,
  reputation: reputationRouter,

  // ── System Domain ──────────────────────────────────────────────────────
  health: healthRouter,
  fraud: fraudRouter,
  flags: flagsRouter,
  alphaTelemetry: alphaTelemetryRouter,
  geo: geoRouter,
});

export type AppRouter = typeof appRouter;
