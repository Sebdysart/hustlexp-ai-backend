# Service Organization Plan

**Status:** Planned for Phase 2  
**Effort:** 2-3 days  
**Impact:** Improved maintainability

---

## Current State

71 services in flat directory: `backend/src/services/`

## Proposed Structure

```
services/
├── ai/                          # AI-related services
│   ├── AIClient.ts
│   ├── AIDecisionService.ts
│   ├── AIEventService.ts
│   ├── AIJobService.ts
│   ├── AIProposalService.ts
│   ├── ContentModerationService.ts
│   ├── DisputeAIService.ts
│   ├── MatchmakerService.ts
│   ├── OnboardingAIService.ts
│   └── ReputationAIService.ts
│
├── payments/                    # Payment & escrow
│   ├── ChargebackService.ts
│   ├── EscrowService.ts
│   ├── LedgerService.ts
│   ├── PayoutService.ts
│   ├── RefundService.ts
│   ├── SelfInsurancePoolService.ts
│   ├── StripeService.ts
│   ├── StripeConnectService.ts
│   ├── StripeWebhookService.ts
│   └── TippingService.ts
│
├── trust/                       # Trust & safety
│   ├── BiometricVerificationService.ts
│   ├── DisputeService.ts
│   ├── EligibilityGuard.ts
│   ├── FraudDetectionService.ts
│   ├── ReputationService.ts
│   ├── TrustService.ts
│   └── TrustTierService.ts
│
├── platform/                    # Core platform
│   ├── AnalyticsService.ts
│   ├── BadgeEvaluationService.ts
│   ├── BadgeService.ts
│   ├── BetaService.ts
│   ├── CapabilityRecomputeService.ts
│   ├── GDPRService.ts
│   ├── MessagingService.ts
│   ├── NotificationService.ts
│   ├── ProofService.ts
│   ├── RatingService.ts
│   ├── TaskDiscoveryService.ts
│   ├── TaskService.ts
│   ├── UserService.ts
│   └── XPTaxService.ts
│
├── gamification/                # Gamification
│   ├── BatchQuestingService.ts
│   ├── QuestService.ts
│   ├── StreakService.ts
│   └── TournamentService.ts
│
├── infrastructure/              # Infrastructure
│   ├── AlphaInstrumentation.ts
│   ├── AuditService.ts
│   ├── EvidenceService.ts
│   ├── PlanService.ts
│   ├── RevenueService.ts
│   └── SubscriptionService.ts
│
└── index.ts                     # Re-exports
```

---

## Migration Strategy

### Phase 1: Create directories and move (no code changes)
```bash
mkdir -p services/{ai,payments,trust,platform,gamification,infrastructure}
# Move files
```

### Phase 2: Update imports
```bash
# Update all import statements
find . -name "*.ts" -exec sed -i '' 's|from "../services/StripeService"|from "../services/payments/StripeService"|g' {} \;
```

### Phase 3: Update barrel exports
```typescript
// services/index.ts
export * from './ai';
export * from './payments';
export * from './trust';
export * from './platform';
export * from './gamification';
export * from './infrastructure';
```

---

## Benefits

1. **Clear ownership:** Each directory has a clear purpose
2. **Reduced merge conflicts:** Teams work in different directories
3. **Easier onboarding:** New devs understand the domain faster
4. **Better testing:** Can test bounded contexts in isolation

---

## Risks

1. **Import churn:** All files importing services need updates
2. **Git history:** Moving files loses blame history
3. **Branch conflicts:** Best done when few active branches

---

## Recommendation

Defer until after production launch. Current flat structure works, just suboptimal.
