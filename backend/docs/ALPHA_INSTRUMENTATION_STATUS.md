# Alpha Instrumentation Status

## ✅ IMPLEMENTED

### Core Infrastructure

1. **Database Table** (`alpha_telemetry`)
   - ✅ Migration file: `backend/database/migrations/add_alpha_telemetry_table.sql`
   - ✅ All required columns for all event groups
   - ✅ Indexes for query performance
   - ✅ Composite indexes for common queries

2. **Service Layer** (`AlphaInstrumentation`)
   - ✅ `backend/src/services/AlphaInstrumentation.ts`
   - ✅ All event emission methods:
     - `emitEdgeStateImpression` (Layer 1)
     - `emitEdgeStateExit` (Layer 1)
     - `emitDisputeEntryAttempt` (Layer 3)
     - `emitDisputeSubmissionResult` (Layer 3)
     - `emitProofSubmission` (Layer 4)
     - `emitProofCorrectionOutcome` (Layer 4)
     - `emitTrustDeltaApplied` (Layer 5)
   - ✅ Silent failure handling (instrumentation never breaks core flow)

3. **tRPC Router** (`alphaTelemetry`)
   - ✅ `backend/src/routers/alpha-telemetry.ts`
   - ✅ All dashboard query endpoints:
     - `getEdgeStateDistribution` - Edge state distribution (E1 vs E2 vs E3)
     - `getEdgeStateTimeSpent` - Average time spent per edge state
     - `getDisputeRate` - Dispute attempts per 100 tasks
     - `getProofCorrectionRate` - Proof failure → correction success rate
     - `getTrustTierMovement` - Trust tier movement histogram
   - ✅ Registered in `backend/src/routers/index.ts`

4. **Documentation**
   - ✅ Integration guide: `backend/docs/ALPHA_INSTRUMENTATION_INTEGRATION.md`
   - ✅ Status document: `backend/docs/ALPHA_INSTRUMENTATION_STATUS.md`

## ⏳ PENDING INTEGRATION

### Backend Integration Points

1. **TrustTierService** (`backend/src/services/TrustTierService.ts`)
   - ⏳ Add `emitTrustDeltaApplied` in `applyPromotion`
   - ⏳ Add `emitTrustDeltaApplied` in `banUser`

2. **XPService** (`backend/src/services/XPService.ts`)
   - ⏳ Add `emitTrustDeltaApplied` in `awardXP` for XP deltas
   - ⏳ Add `emitTrustDeltaApplied` for streak deltas (if applicable)

3. **DisputeService** (`backend/src/services/DisputeService.ts`)
   - ⏳ Add `emitDisputeEntryAttempt` before dispute submission
   - ⏳ Add `emitDisputeSubmissionResult` after guard validation
   - ⏳ **Note**: Dispute system implementation status TBD

4. **Proof System** (TBD)
   - ⏳ Add `emitProofSubmission` on proof submission attempts
   - ⏳ Add `emitProofCorrectionOutcome` after proof correction resolution
   - ⏳ **Note**: Proof system location TBD

### Frontend Integration Points

1. **Edge State Screens**
   - ⏳ E1: No Tasks Available - Add `emitEdgeStateImpression` and `emitEdgeStateExit`
   - ⏳ E2: Eligibility Mismatch - Add `emitEdgeStateImpression` and `emitEdgeStateExit`
   - ⏳ E3: Trust Tier Locked - Add `emitEdgeStateImpression` and `emitEdgeStateExit`

2. **tRPC Client Mutations**
   - ⏳ Create `trpc.alphaTelemetry.emitEdgeStateImpression.mutate`
   - ⏳ Create `trpc.alphaTelemetry.emitEdgeStateExit.mutate`
   - ⏳ **Note**: These may need to be added to `alpha-telemetry.ts` router as mutations

## 📋 NEXT STEPS (Execution Order)

1. **Apply Database Migration**
   ```bash
   npm run db:migrate -- add_alpha_telemetry_table.sql
   ```

2. **Backend Integration** (Priority: High)
   - Integrate `TrustTierService.applyPromotion` → `emitTrustDeltaApplied`
   - Integrate `TrustTierService.banUser` → `emitTrustDeltaApplied`
   - Integrate `XPService.awardXP` → `emitTrustDeltaApplied`

3. **Frontend Integration** (Priority: Medium)
   - Add tRPC mutations for edge state events (if needed)
   - Integrate E1, E2, E3 screens with edge state telemetry

4. **Dispute/Proof Integration** (Priority: Low - depends on system implementation)
   - Integrate dispute events when DisputeService is ready
   - Integrate proof events when proof system is ready

## ✅ DONE CRITERIA CHECKLIST

- [x] All edge state event schemas defined
- [x] All dispute event schemas defined
- [x] All proof event schemas defined
- [x] All trust delta event schemas defined
- [x] Database table migration created
- [x] `AlphaInstrumentation` service created
- [x] All event emission methods implemented
- [x] Silent failure handling implemented
- [x] tRPC router for dashboard queries created
- [x] All dashboard query endpoints implemented
- [ ] **Backend integration points wired** ⏳
- [ ] **Frontend integration points wired** ⏳
- [ ] **Database migration applied** ⏳

## 🎯 ALPHA INSTRUMENTATION OBJECTIVE

**Detect trust leaks, confusion, abuse vectors, and silent failure during alpha before they fossilize into user behavior.**

All infrastructure is in place. Remaining work is integration into existing services and frontend screens.
