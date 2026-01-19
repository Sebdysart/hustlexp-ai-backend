# HustleXP iOS App - Agent Coordination Hub

> **Role**: Agent Coordinator - Keeping all agents aligned for iOS app completion

## 🎯 Mission

Coordinate multiple agents working on the HustleXP iOS app to ensure:
- Consistent architecture and patterns
- Proper backend integration
- Alignment with product vision
- Quality standards maintained
- No duplicate work or conflicts

---

## 📋 Project Context

### Backend Status
- **Backend URL**: `https://hustlexp-ai-backend-production.up.railway.app`
- **Status**: ✅ 100% Complete, ready for Seattle Beta
- **Key Features**:
  - AI Orchestration (DeepSeek, GPT-4o, Groq)
  - Gamification (37 badges, quests, XP system)
  - Payments (Stripe Connect, escrow)
  - Safety & moderation
  - Multi-language support

### iOS App Requirements
- Native iOS app (Swift/SwiftUI) or Expo/React Native
- Integration with backend API (tRPC)
- Firebase Auth
- Real-time features
- AI chat interface
- Task marketplace UI
- Gamification UI

### MCP Servers Configured ✅

**Documentation Access**:
- **Filesystem MCP** - Direct access to HustleXP docs (reads files from `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/`)
- **GitHub MCP** - Repository management, PRs, issues (can also access docs if on GitHub)

**iOS Development**:
- **Mobile MCP** - iOS/Android simulator automation
- **XcodeBuildMCP** - Xcode builds, error fixing, TestFlight

**Other**:
- **Expo MCP** - Expo SDK documentation
- **Rive** - Local SSE server

**Configuration**: `~/.cursor/mcp.json`  
**Documentation**: See `docs/GROUNDX_RAG_SETUP.md` for RAG usage

---

## 🔗 Resources

### HustleXP Docs Access
- **Location**: `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/` (Local)
- **MCP-Enabled**: ✅ Agents can access docs directly via MCP
- **Alignment Tool**: Use `scripts/verify-docs-alignment.ts` to verify compliance
- **GitHub Token**: Configured (for fetching remote docs if needed)
- **Fetch Script**: `scripts/fetch-github-docs.ts` (if docs updated on GitHub)

### Key Documentation
- `docs/HUSTLEXP_DOCS_ALIGNMENT.md` - **Documentation alignment workflow (MCP-enabled)**
- `docs/MAX_TIER_GAPS_ALIGNMENT.md` - **Max-tier gaps alignment check (all 7 gaps documented)**
- `docs/AI_TASK_COMPLETION_INTEGRATION.md` - **AI Task Completion System integration summary**
- `docs/DEEP_SCAN_BEST_GIG_APP_AUDIT.md` - **NEW: Comprehensive audit to ensure best gig app ever**
- `docs/FILESYSTEM_MCP_SETUP.md` - Filesystem MCP setup for documentation access
- `docs/GROUNDX_RAG_SETUP.md` - GroundX setup (note: package not found, using filesystem MCP instead)
- `docs/MCP_SERVERS_SETUP.md` - Complete MCP servers configuration summary
- `docs/FRONTEND_INTEGRATION.md` - REST API reference (legacy)
- `docs/IOS_TRPC_INTEGRATION.md` - tRPC integration guide for iOS
- `docs/MOBILE_MCP_SETUP.md` - Mobile MCP setup for device automation
- `AGENT_ALIGNMENT_CHECKLIST.md` - Quick reference checklist for reviews
- `BACKEND_AUDIT.md` - Backend capabilities
- `AI_ORCHESTRATION_COMPLETE.md` - AI integration guide
- `SEATTLE_BETA_READINESS.md` - Production readiness checklist

### HustleXP Constitutional Documentation
**Location**: `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/`

**Core Documents** (⭐ Highest Authority):
- `PRODUCT_SPEC.md` - Product requirements, features, business rules
- `ARCHITECTURE.md` - System architecture, layers, invariants
- `AI_INFRASTRUCTURE.md` - AI authority model, subsystems
- `schema.sql` - Database schema, triggers (Layer 0)

**Implementation Documents** (⭐ High):
- `UI_SPEC.md` - UI constants, colors, components
- `ONBOARDING_SPEC.md` - Onboarding flow, questions
- `BUILD_GUIDE.md` - Build instructions

**MCP-Enabled Access**: 
- ✅ **Filesystem MCP**: Read docs directly from `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/` (official MCP server)
- ✅ **GitHub MCP**: Access docs from GitHub repository if needed
- ✅ **Automated Verification**: Read files and compare with implementations

**Example Queries**:
- "Read PRODUCT_SPEC.md and find information about task pricing"
- "Read ARCHITECTURE.md and check if this matches Layer 1 pattern"
- "Read all HustleXP docs and find all mentions of 'INV-1'"

**Note**: GroundX MCP package doesn't exist. Using official filesystem MCP server instead for direct file access.

### Expo Projects
- `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/` - Main Expo project
- `/Users/sebastiandysart/HustleXP/HustleXP-Fresh/` - Alternative Expo project

---

## 📊 Agent Tracking

### Active Agents
| Agent ID | Focus Area | Status | Last Update | Notes |
|----------|------------|--------|-------------|-------|
| Agent 1 | Backend Constitutional Schema | ✅ Phase 6 Complete | 2025-01-XX | API Layer ready for iOS integration |

### Agent Outputs Log

#### Agent 1 - Backend Constitutional Schema Implementation
**Date**: 2025-01-XX  
**Focus**: Database schema migration and core services with constitutional architecture

**Completed**:
- ✅ Phase 0: Database Schema Migration
  - Created `backend/database/constitutional-schema.sql` (full constitutional schema)
  - Created migration scripts and verification tools
- ✅ Phase 1: Core Invariants Enforcement
  - Updated `backend/src/db.ts` with all HX error codes (HX001-HX905)
  - Added helper functions for invariant checks
  - Updated `backend/src/types.ts` to match constitutional schema
- ✅ Phase 2: Core Services
  - Updated `ProofService.ts` (SUBMITTED/EXPIRED states)
  - Created `TrustService.ts` (trust tier promotions with audit logging)
  - Created `BadgeService.ts` (append-only badge awards)
  - Created `DisputeService.ts` (dispute lifecycle management)
  - Updated `TaskService.ts` with Live Mode support
- ✅ Phase 3: AI Infrastructure (Complete)
  - Created `AIEventService.ts` (immutable AI input logging)
  - Created `AIJobService.ts` (AI job orchestration)
  - Created `AIProposalService.ts`
  - Created `AIDecisionService.ts`
  - Created `EvidenceService.ts`
  - Created `OnboardingAIService.ts`
- ✅ Phase 6: API Layer (Complete - **HIGH PRIORITY FOR iOS**)
  - Task router with Live Mode support (`task.create`, `task.accept`, `task.complete`, `task.cancel`)
  - Escrow router (`escrow.getById`, `escrow.getByTaskId`, `escrow.release`)
  - User router (profile endpoints)
  - AI router (`ai.submitCalibration`, `ai.confirmRole`)
  - Live router (`live.toggle`, `live.getStatus`, `live.listBroadcasts`)
  - Health router (`health.ping`, `health.status`)
  - All routers integrated into main `appRouter`
  - Zod schemas updated for constitutional types

**Remaining Work** (Can proceed in parallel):
- Phase 4: Live Mode services (LiveBroadcastService, LiveSessionService)
- Phase 5: Human Systems (FatigueService, PauseService, PosterReputationService, PercentileService, SessionForecastService, MoneyTimelineService)
- Phase 7: Stripe integration updates
- Phase 8: Testing suite
- Phase 9: Cleanup and documentation

**Review Status**: ✅ **APPROVED - READY FOR iOS INTEGRATION**

**Next Steps**:
1. ✅ Apply constitutional schema to database (run migration script)
2. ⏳ Test API endpoints with iOS app
3. ⏳ Complete remaining phases as needed

---

## 🎯 Coordination Guidelines

### For All Agents

1. **Backend Integration**
   - Always reference `docs/FRONTEND_INTEGRATION.md` for API endpoints
   - Use backend URL: `https://hustlexp-ai-backend-production.up.railway.app`
   - Test endpoints before implementing UI

2. **Architecture Standards**
   - Follow iOS best practices (SwiftUI preferred)
   - Use MVVM or similar clean architecture
   - Implement proper error handling
   - Add loading states for all async operations

3. **AI Integration**
   - Use `/ai/orchestrate` endpoint for all AI interactions
   - Support multi-language (backend auto-detects)
   - Implement proper context passing (screen, user state)

4. **Authentication**
   - Firebase Auth for user identity
   - Backend expects Firebase UID as `userId`
   - Store auth tokens securely

5. **State Management**
   - Use consistent state management approach
   - Cache API responses appropriately
   - Handle offline scenarios

### Code Review Checklist

When reviewing agent outputs, check:
- [ ] Follows iOS/Swift best practices
- [ ] Properly integrates with backend APIs
- [ ] Error handling implemented
- [ ] Loading states present
- [ ] Matches existing code style
- [ ] No hardcoded values (use config)
- [ ] Properly handles edge cases
- [ ] Documentation/comments where needed

---

## 🔄 Workflow

### When Agent Submits Output

1. **Review the Output**
   - Check against coordination guidelines
   - Verify backend integration
   - Test API endpoints if code provided
   - Check for conflicts with other agents' work

2. **Provide Feedback**
   - Clear, actionable guidance
   - Point to relevant documentation
   - Suggest improvements if needed
   - Approve if ready

3. **Update Tracking**
   - Log agent output in this document
   - Update status in agent tracking table
   - Note any blockers or dependencies

4. **Coordinate with Other Agents**
   - Check for overlapping work
   - Identify dependencies
   - Suggest collaboration if needed

---

## 🚨 Common Issues & Solutions

### Issue: Agent doesn't know backend API structure
**Solution**: Direct them to `docs/FRONTEND_INTEGRATION.md`

### Issue: Agent creates duplicate functionality
**Solution**: Check agent tracking table, redirect to existing implementation

### Issue: Agent uses wrong API endpoint
**Solution**: Provide correct endpoint from integration docs

### Issue: Agent doesn't handle errors properly
**Solution**: Request proper error handling with user-friendly messages

### Issue: Agent hardcodes values
**Solution**: Request configuration-based approach

---

## 📝 Notes & Decisions

### 2025-01-XX - Agent 1 Constitutional Schema Work

**Context**: Agent 1 is implementing a "constitutional schema" architecture that enforces invariants at the database level. This is more robust than the existing application-level enforcement.

**Key Questions**:
1. Is this constitutional schema meant to **replace** the existing backend, or **coexist** with it?
2. Does the iOS app need to wait for this work, or can it use the existing production-ready backend?
3. What's the priority: Complete constitutional schema first, or start iOS app with existing backend?

**Decision Needed**: Clarify relationship between:
- Existing backend (marked "100% Complete, Ready for Seattle Beta")
- New constitutional schema implementation
- iOS app development priorities

**Recommendation**: 
- If constitutional schema is a **future upgrade**: Agent 1 should continue, but iOS app can proceed with existing backend
- If constitutional schema is **required for iOS**: Agent 1 should prioritize API Layer (Phase 6) to expose endpoints iOS needs
- If this is a **parallel refactor**: Need to ensure no conflicts with existing production backend

---

## 🎯 Next Steps

1. Wait for first agent output
2. Review and provide guidance
3. Establish patterns for subsequent agents
4. Maintain consistency across all agent work

---

**Last Updated**: 2025-01-XX - Agent 1 Phase 6 Complete, API Layer ready for iOS
