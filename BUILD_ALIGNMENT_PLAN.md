# HustleXP Build Alignment Plan

> **Date**: January 2025  
> **Purpose**: Align backend implementation with HUSTLEXP-DOCS constitutional specifications  
> **Status**: 🟡 **IN PROGRESS** — Starting Phase 0: Schema Sync

---

## 🎯 Alignment Goal

**Achieve 100% alignment** between:
- ✅ HUSTLEXP-DOCS constitutional specs (PRODUCT_SPEC.md v1.4.0, UI_SPEC.md v1.5.0, schema.sql v1.1.0)
- ❌ Backend implementation (hustlexp-ai-backend)

**Target**: Full constitutional alignment following BUILD_GUIDE.md phases 0-14

---

## 📊 Current Status Assessment

### Backend Schema Status

| Component | HUSTLEXP-DOCS | Backend Repo | Gap |
|-----------|---------------|--------------|-----|
| **schema.sql** | v1.1.0 (1,935 lines) | v1.0.0 (1,383 lines) | ❌ **Missing 14 critical gap tables** |
| **Core Tables** | 18 tables | 18 tables | ✅ Match |
| **AI Tables** | 5 tables | 5 tables | ✅ Match |
| **Live Mode Tables** | 2 tables | 2 tables | ✅ Match |
| **Human Systems** | 4 tables/views | 4 tables/views | ✅ Match |
| **Critical Gap Tables** | **14 tables + 1 view** | **0 tables** | ❌ **CRITICAL GAP** |
| **Total** | **32 tables + 4 views** | **18 tables** | ❌ **Missing 14 tables** |

### Backend Services Status

| Service Category | Required | Implemented | Status |
|-----------------|----------|-------------|--------|
| **Core Services** | 10 | 10 | ✅ Complete |
| **AI Infrastructure** | 6 | 6 | ✅ Complete |
| **Live Mode** | 2 | 0 | ❌ Missing |
| **Human Systems** | 6 | 0 | ❌ Missing |
| **Critical Gaps** | 8 | 3 (partial) | ⚠️ **Partial** |
| - Messaging | 1 | 0 | ❌ Missing |
| - Notifications | 1 | 1 (legacy) | ⚠️ Needs alignment |
| - Ratings | 1 | 0 | ❌ Missing |
| - Analytics | 1 | 0 | ❌ Missing |
| - Fraud Detection | 1 | 1 (legacy) | ⚠️ Needs alignment |
| - Content Moderation | 1 | 1 (legacy) | ⚠️ Needs alignment |
| - GDPR | 1 | 0 | ❌ Missing |
| - Task Discovery | 1 | 0 | ❌ Missing |

### API Layer Status

| Router | Required Endpoints | Implemented | Status |
|--------|-------------------|-------------|--------|
| **task** | 8+ endpoints | 7 endpoints | 🟡 Partial |
| **escrow** | 4 endpoints | 3 endpoints | 🟡 Partial |
| **user** | 6 endpoints | 4 endpoints | 🟡 Partial |
| **ai** | 4 endpoints | 3 endpoints | 🟡 Partial |
| **live** | 3 endpoints | 3 endpoints | ✅ Complete |
| **messaging** | 3 endpoints | 0 | ❌ Missing |
| **notifications** | 5 endpoints | 0 | ❌ Missing |
| **ratings** | 4 endpoints | 0 | ❌ Missing |
| **analytics** | 4 endpoints | 0 | ❌ Missing |
| **fraud** | 4 endpoints | 0 | ❌ Missing |
| **moderation** | 4 endpoints | 0 | ❌ Missing |
| **privacy** | 5 endpoints | 0 | ❌ Missing |

---

## 🔧 Alignment Phases

### Phase 0: Schema Sync (CRITICAL - DO FIRST)

**Status**: 🟡 **IN PROGRESS**

**Goal**: Sync backend schema with HUSTLEXP-DOCS schema.sql v1.1.0

**Tasks**:
1. ✅ [ ] Copy HUSTLEXP-DOCS schema.sql v1.1.0 to backend/database/
2. ✅ [ ] Update backend/database/constitutional-schema.sql to v1.1.0
3. ✅ [ ] Remove old backend/database/schema.sql (333 lines, outdated)
4. ✅ [ ] Verify all 32 tables + 4 views exist
5. ✅ [ ] Verify all triggers, indexes, views created
6. ✅ [ ] Run verification queries from BUILD_GUIDE.md §3.4
7. ✅ [ ] Apply schema to production database
8. ✅ [ ] Update schema version to v1.1.0

**Gate Criteria**:
- All 32 tables + 4 views exist in backend database
- All critical gap tables present (task_matching_scores, task_messages, notifications, etc.)
- All triggers verified working
- Schema version v1.1.0 recorded

**Effort**: 2-3 hours

---

### Phase 1: Core Services Alignment

**Status**: ⏳ **PENDING** (After Phase 0)

**Goal**: Verify and align existing core services with updated schema

**Tasks**:
1. ✅ [ ] Verify TaskService aligns with schema
2. ✅ [ ] Verify EscrowService aligns with schema
3. ✅ [ ] Verify ProofService aligns with schema
4. ✅ [ ] Verify XPService aligns with schema
5. ✅ [ ] Verify TrustService aligns with schema
6. ✅ [ ] Verify BadgeService aligns with schema
7. ✅ [ ] Verify DisputeService aligns with schema
8. ✅ [ ] Run all kill tests (inv-1 through inv-5)
9. ✅ [ ] Verify all HX error codes handled

**Gate Criteria**:
- All core services work with new schema
- All kill tests pass
- No HX error code violations

**Effort**: 3-4 hours

---

### Phase 2: Critical Gap Services Implementation

**Status**: ⏳ **PENDING** (After Phase 1)

**Goal**: Create constitutional services for all critical gaps

**Tasks** (Priority Order):

1. **TaskDiscoveryService** (PRODUCT_SPEC §9)
   - Matching score calculation
   - Relevance score calculation
   - Feed ranking algorithm
   - Filter/sort/search logic

2. **MessagingService** (PRODUCT_SPEC §10)
   - Task-scoped messaging
   - Message lifecycle enforcement
   - Content moderation integration (A2 authority)

3. **NotificationService** (PRODUCT_SPEC §11) - ALIGN EXISTING
   - Align existing NotificationService with schema
   - Notification preferences management
   - Quiet hours enforcement
   - Multi-channel delivery (push, email, SMS, in-app)

4. **RatingService** (PRODUCT_SPEC §12)
   - Bidirectional rating system
   - Rating window enforcement (7 days)
   - Blind rating logic (both parties required)
   - Rating immutability enforcement

5. **AnalyticsService** (PRODUCT_SPEC §13)
   - Event tracking
   - Conversion funnel tracking
   - Cohort analysis
   - A/B test framework

6. **FraudDetectionService** (PRODUCT_SPEC §14) - ALIGN EXISTING
   - Align existing FraudDetectionService with schema
   - Risk score calculation
   - Pattern detection
   - Stripe Radar integration

7. **ContentModerationService** (PRODUCT_SPEC §15) - ALIGN EXISTING
   - Align existing ModerationService with schema
   - Content scanning (A2 authority)
   - Review queue management
   - Appeal process

8. **GDPRService** (PRODUCT_SPEC §16)
   - Data export requests (30-day SLA)
   - Data deletion requests (7-day SLA)
   - Consent management
   - Data breach notifications (72-hour)

**Gate Criteria**:
- All 8 services implemented
- All services use transactions
- All services catch HX errors
- All services log state transitions
- All services return ServiceResult<T>

**Effort**: 3-4 days (1 service per half-day)

---

### Phase 3: Critical Gap API Routers

**Status**: ⏳ **PENDING** (After Phase 2)

**Goal**: Create tRPC routers for all critical gap features

**Tasks**:
1. ✅ [ ] Create `messaging` router (3 endpoints)
2. ✅ [ ] Create `notifications` router (5 endpoints)
3. ✅ [ ] Create `ratings` router (4 endpoints)
4. ✅ [ ] Create `analytics` router (4 endpoints)
5. ✅ [ ] Create `fraud` router (4 endpoints)
6. ✅ [ ] Create `moderation` router (4 endpoints)
7. ✅ [ ] Create `privacy` router (5 endpoints)
8. ✅ [ ] Create `taskDiscovery` router (3 endpoints)
9. ✅ [ ] Integrate all routers into appRouter
10. ✅ [ ] Add Zod schemas for all endpoints
11. ✅ [ ] Add auth middleware to all endpoints
12. ✅ [ ] Test all endpoints

**Gate Criteria**:
- All routers implemented
- All endpoints tested
- All Zod schemas validate
- All auth middleware enforced
- All routers integrated into appRouter

**Effort**: 2-3 days

---

### Phase 4: Live Mode Services (Parallel)

**Status**: ⏳ **PENDING** (Can run in parallel)

**Goal**: Implement Live Mode services

**Tasks**:
1. ✅ [ ] Create LiveBroadcastService
2. ✅ [ ] Create LiveSessionService
3. ✅ [ ] Verify Live Mode invariants (LIVE-1, LIVE-2)
4. ✅ [ ] Test Live Mode endpoints

**Gate Criteria**:
- Both services implemented
- All Live Mode invariants enforced
- All Live Mode endpoints working

**Effort**: 1 day

---

### Phase 5: Human Systems Services (Parallel)

**Status**: ⏳ **PENDING** (Can run in parallel)

**Goal**: Implement Human Systems services

**Tasks**:
1. ✅ [ ] Create FatigueService (Live Mode only, per product decision)
2. ✅ [ ] Create PauseService
3. ✅ [ ] Create PosterReputationService
4. ✅ [ ] Create PercentileService
5. ✅ [ ] Create SessionForecastService
6. ✅ [ ] Create MoneyTimelineService
7. ✅ [ ] Verify Human Systems invariants (HX6XX)

**Gate Criteria**:
- All 6 services implemented
- All Human Systems invariants enforced
- All services use money_timeline view

**Effort**: 2 days

---

### Phase 6: Testing & Verification

**Status**: ⏳ **PENDING** (After Phases 1-5)

**Goal**: Comprehensive testing of all implementations

**Tasks**:
1. ✅ [ ] Run all kill tests (inv-1 through inv-5)
2. ✅ [ ] Run all Live Mode kill tests (LIVE-1, LIVE-2)
3. ✅ [ ] Run all Human Systems kill tests (HX6XX)
4. ✅ [ ] Run all Critical Gap kill tests (HX8XX, HX9XX)
5. ✅ [ ] Integration tests for all services
6. ✅ [ ] API endpoint tests for all routers
7. ✅ [ ] Performance tests (< 200ms p95 for feeds)
8. ✅ [ ] Verify all HX error codes work correctly

**Gate Criteria**:
- All kill tests pass
- All integration tests pass
- All API tests pass
- All performance targets met
- No HX error code violations

**Effort**: 2-3 days

---

### Phase 7-14: Critical Gap Features (BUILD_GUIDE.md §10-§17)

**Status**: ⏳ **PENDING** (After Phase 6)

These phases are defined in BUILD_GUIDE.md and should follow the same pattern:
- Schema verification
- Service implementation
- API router creation
- Testing & verification
- Gate criteria

---

## 🚨 Critical Issues to Address

### Issue 1: Schema Out of Sync (CRITICAL)

**Problem**: Backend schema v1.0.0 missing 14 critical gap tables  
**Impact**: Cannot implement critical gap features  
**Fix**: Sync backend schema with HUSTLEXP-DOCS schema.sql v1.1.0  
**Priority**: 🔴 **CRITICAL** — Do first

---

### Issue 2: Services Not Aligned with Schema (HIGH)

**Problem**: Existing services (NotificationService, FraudDetectionService, ModerationService) may not align with constitutional schema  
**Impact**: Services may not work correctly with new schema  
**Fix**: Align existing services with schema, or recreate if needed  
**Priority**: 🔴 **HIGH** — Do after schema sync

---

### Issue 3: Missing Critical Gap Services (HIGH)

**Problem**: Missing services for Messaging, Ratings, Analytics, GDPR, Task Discovery  
**Impact**: Critical features cannot be implemented  
**Fix**: Create all 8 critical gap services  
**Priority**: 🔴 **HIGH** — Do after Phase 1

---

### Issue 4: Missing API Routers (MEDIUM)

**Problem**: Missing tRPC routers for critical gaps  
**Impact**: Frontend cannot access critical gap features  
**Fix**: Create all 7 critical gap routers  
**Priority**: 🟡 **MEDIUM** — Do after Phase 2

---

## 📋 Next Actions (Priority Order)

### Immediate (This Session)

1. **Phase 0: Schema Sync** (2-3 hours)
   - Copy HUSTLEXP-DOCS schema.sql v1.1.0 to backend
   - Update backend/database/constitutional-schema.sql
   - Remove old schema.sql
   - Verify all tables exist

### Next Session

2. **Phase 1: Core Services Alignment** (3-4 hours)
   - Verify all core services work with new schema
   - Run kill tests
   - Fix any alignment issues

3. **Phase 2: Critical Gap Services** (3-4 days)
   - Start with TaskDiscoveryService
   - Then MessagingService
   - Then align existing services (Notification, Fraud, Moderation)
   - Then create missing services (Ratings, Analytics, GDPR)

### Following Sessions

4. **Phase 3: Critical Gap API Routers** (2-3 days)
5. **Phase 4-5: Live Mode & Human Systems** (3 days, parallel)
6. **Phase 6: Testing & Verification** (2-3 days)

---

## 🎯 Success Criteria

**Phase 0 Complete When**:
- ✅ Backend schema v1.1.0 matches HUSTLEXP-DOCS schema.sql v1.1.0
- ✅ All 32 tables + 4 views exist in backend database
- ✅ All critical gap tables present
- ✅ Schema version v1.1.0 recorded

**Full Alignment Complete When**:
- ✅ All BUILD_GUIDE.md phases 0-14 complete
- ✅ All EXECUTION_INDEX.md sections 1-19 implemented
- ✅ All services align with constitutional specs
- ✅ All API routers created and tested
- ✅ All kill tests pass
- ✅ All critical gap features working

---

**Last Updated**: January 2025  
**Status**: Phase 0 in progress  
**Next Review**: After Phase 0 completion
