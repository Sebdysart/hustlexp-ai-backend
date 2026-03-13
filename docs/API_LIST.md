# API List — tRPC Procedures

**Base path:** `/trpc`  
**Auth:** `Authorization: Bearer <firebase_jwt>` for protected/admin procedures.  
**Last updated:** 2026-03-13

---

## Summary

| Router | Procedures | Auth |
|--------|------------|------|
| task | 20 | protected |
| escrow | 10 | protected |
| user | 17 | public + protected |
| ai | 3 | protected |
| live | 3 | protected |
| health | 3 | public |
| ui | 5 | protected |
| instant | 4 | protected |
| taskDiscovery | 11 | public + protected |
| messaging | 7 | protected |
| notification | 11 | protected + admin |
| rating | 7 | protected + admin |
| gdpr | 6 | protected |
| analytics | 8 | public + protected + admin |
| fraud | 9 | admin |
| moderation | 11 | protected + admin |
| alphaTelemetry | 7 | protected |
| xpTax | 4 | protected |
| insurance | 5 | protected + admin |
| biometric | 4 | protected |
| skills | 8 | public + protected |
| pricing | 3 | protected |
| geofence | 3 | protected |
| heatmap | 2 | protected |
| batchQuest | 2 | protected |
| tutorial | 3 | protected |
| jury | 2 | protected |
| upload | 1 | protected |
| matchmaker | 3 | protected + admin |
| disputeAI | 3 | admin |
| reputation | 4 | protected |
| betaDashboard | 14 | protected + admin |
| challenges | 2 | protected |
| expertiseSupply | 12 | protected + admin |
| featured | 3 | protected |
| referral | 3 | protected |
| subscription | 4 | protected |
| tipping | 5 | protected |
| squad | 10 | protected |
| recurringTask | 9 | protected |
| stripeConnect | 11 | protected |
| flags | 2 | protected + admin |
| capability | 18 | protected |
| admin | 7 | admin |
| incidents | 5 | protected |
| intent | 2 | protected |
| batching | 2 | protected |
| tracking | 4 | protected |

---

## By router (procedure names)

### task
`getById` `getState` `listByPoster` `listByWorker` `listOpen` `create` `accept` `start` `getProof` `submitProof` `reviewProof` `complete` `cancel` `applyForTask` `listApplicants` `assignWorker` `rejectApplicant` `withdrawApplication`

### escrow
`getById` `getState` `getByTaskId` `createPaymentIntent` `confirmFunding` `release` `refund` `lockForDispute` `getHistory` `awardXP`

### user
`me` `getById` `getStreakStatus` `xpHistory` `badges` `register` (public) `updateProfile` `getOnboardingStatus` `completeOnboarding` `getVerificationUnlockStatus` `checkVerificationEligibility` `getVerificationEarningsLedger` `xpLeaderboard` `requestErasure`

### ai
`submitCalibration` `getInferenceResult` `confirmRole`

### live
`toggle` `getStatus` `listBroadcasts`

### health
`ping` `status` `verifySchema` (all public)

### ui
`getXPCelebrationStatus` `markXPCelebrationShown` `getBadgeAnimationStatus` `markBadgeAnimationShown` `reportViolation`

### instant
`listAvailable` `accept` `dismiss` `metrics`

### taskDiscovery
`browseTasks` (public) `getFeed` `calculateFeedScores` `calculateMatchingScore` `getExplanation` `getAISuggestions` `search` `saveSearch` `getSavedSearches` `deleteSavedSearch` `executeSavedSearch`

### messaging
`sendMessage` `sendPhotoMessage` `getTaskMessages` `markAsRead` `markAllAsRead` `getUnreadCount` `getConversations`

### notification
`getList` `getUnreadCount` `getById` `markAsRead` `markAllAsRead` `markAsClicked` `getPreferences` `updatePreferences` `registerDeviceToken` `unregisterDeviceToken` `sendTestPush` (admin)

### rating
`submitRating` `getTaskRatings` `getUserRatingSummary` `getMyRatings` `getRatingsReceived` `getTextReviews` `processAutoRatings` (admin)

### gdpr
`createRequest` `getRequestStatus` `getMyRequests` `cancelRequest` `getConsentStatus` `updateConsent`

### analytics
`trackEvent` (public) `trackBatch` (public) `getUserEvents` `getTaskEvents` `calculateFunnel` (admin) `calculateCohortRetention` (admin) `trackABTest` `getEventCounts` (admin)

### fraud
`calculateRiskScore` `getLatestRiskScore` `getRiskAssessment` `getHighRiskScores` `updateRiskScoreStatus` `detectPattern` `getUserPatterns` `getDetectedPatterns` `updatePatternStatus` (all admin)

### moderation
`moderateContent` (admin) `getPendingQueue` (admin) `getQueueItemById` (admin) `reviewQueueItem` (admin) `createReport` `getUserReports` (admin) `reviewReport` (admin) `createAppeal` `getUserAppeals` `reviewAppeal` (admin) `getPendingAppeals` (admin)

### alphaTelemetry
`getEdgeStateDistribution` `getEdgeStateTimeSpent` `getDisputeRate` `getProofCorrectionRate` `getTrustTierMovement` `emitEdgeStateImpression` `emitEdgeStateExit`

### xpTax
`getTaxStatus` `getLedger` `recordPayment` `getReminderStatus`

### insurance
`getPoolStatus` `getMyClaims` `fileClaim` `reviewClaim` (admin) `payClaim` (admin)

### biometric
`submitBiometricProof` `analyzeFacePhoto` `createLivenessSession` `getLivenessResult`

### skills
`getCategories` (public) `getSkills` (public) `addSkills` `removeSkill` `getMySkills` `submitLicense` `getLicenseSubmissions` `checkTaskEligibility`

### pricing
`calculate` `getSmartPrice` `updateMyModifier`

### geofence
`checkProximity` `getTaskEvents` `verifyPresence`

### heatmap
`getHeatMap` `getDemandAlerts`

### batchQuest
`getSuggestions` `buildRoute`

### tutorial
`getScenarios` `submitAnswers` `scanEquipment`

### jury
`submitVote` `getVoteTally`

### upload
`getPresignedUrl`

### matchmaker
`rankCandidates` (admin) `explainMatch` `suggestPrice`

### disputeAI
`analyzeDispute` `generateEvidenceRequest` `assessEscalation` (all admin)

### reputation
`calculateTrustScore` (admin) `detectAnomalies` (admin) `generateUserInsight` (admin) `checkTierEligibility`

### betaDashboard
`getMetrics` `getStatus` `getKillSignals` `getRevenueSummary` `getMonthlyPnl` `verifyLedgerIntegrity` `getDisputeRate` `getDailyTaskCounts` `getDailyRevenue` `getActivityFeed` `listUsers` (admin) `getBetaConfig` `requestKillSwitchToggle` `getKillSwitchHistory` (admin)

### challenges
`getTodaysChallenges` `updateProgress`

### expertiseSupply
`listExpertise` `getMyExpertise` `addExpertise` `removeExpertise` `promoteExpertise` `checkCapacity` `getMyWaitlist` `acceptInvite` `getSupplyDashboard` (admin) `updateCapacity` (admin) `triggerRecalc` (admin)

### featured
`promoteTask` `confirmPromotion` `getFeaturedTasks`

### referral
`getOrCreateCode` `redeemCode` `getReferralStats`

### subscription
`getMySubscription` `subscribe` `cancel` `confirmSubscription`

### tipping
`createTip` `confirmTip` `getTipsForTask` `getMyTipsReceived` `getMyTipsSent`

### squad
`create` `listMine` `getById` `invite` `respondToInvite` `listInvites` `leave` `disband` `listTasks` `acceptTask` `leaderboard`

### recurringTask
`create` `listMine` `getById` `pause` `resume` `cancel` `listOccurrences` `skipOccurrence` `setPreferredWorker`

### stripeConnect
`getOnboardingStatus` `createOnboardingLink` `getDashboardLink` `getPayoutSettings` `updatePayoutSettings` `getTaxInfo` `submitTaxInfo` `getEarningsSummary` `get1099Status` `getAccountDetails` `refreshOnboarding`

### flags
`getFlags` `setFlag` (admin)

### capability
`getProfile` `getSummary` `hasCapability` `recomputeProfile` `checkEligibility` `queryFeed` `getNearbyTasks` `submitLicense` `getLicenses` `submitInsurance` `getInsurance` `initiateBackgroundCheck` `getBackgroundCheck` `approveLicense` `rejectLicense` `getPendingLicenses`

### admin
`listUsers` `setUserBan` `listTasks` `listDisputes` `revenueBreakdown` `aiCostSummary` `escrowOverride`

### incidents
`list` `get` `resolve` `diagnose` `stats`

### intent
`analyze` `validateChanges`

### batching
`generateRecommendation` `calculateSavings`

### tracking
`startSession` `updateLocation` `stopSession` `getStats`

---

## Calling the API

- **HTTP:** `POST /trpc/<router>.<procedure>` with JSON body for input (or query params for GET).
- **tRPC client:** Use `@trpc/client` with `AppRouter` type; paths like `task.getById`, `user.me`, etc.
- **Public:** No Bearer token (e.g. `health.ping`, `user.register`, `skills.getCategories`, `taskDiscovery.browseTasks`, `analytics.trackEvent`).
- **Protected:** Valid Firebase JWT required.
- **Admin:** JWT + user must exist in `admin_roles` table.
