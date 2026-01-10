# HustleXP Documentation Alignment Workflow

> **Status**: ✅ MCP Enabled - Ready for Flawless Alignment  
> **Purpose**: Ensure all agent work aligns perfectly with HustleXP constitutional specifications

## Overview

With MCP (Model Context Protocol) configured, we can now execute **flawless HustleXP documentation alignment** automatically. This workflow ensures all agent outputs comply with constitutional specifications.

---

## HustleXP Documentation Structure

### Core Constitutional Documents
Located at: `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/`

| Document | Purpose | Authority Level |
|----------|---------|-----------------|
| `PRODUCT_SPEC.md` | Product requirements, features, business rules | ⭐⭐⭐ Highest |
| `ARCHITECTURE.md` | System architecture, layers, invariants | ⭐⭐⭐ Highest |
| `AI_INFRASTRUCTURE.md` | AI authority model, subsystems, constraints | ⭐⭐⭐ Highest |
| `schema.sql` | Database schema, triggers, invariants | ⭐⭐⭐ Highest (Layer 0) |
| `UI_SPEC.md` | UI constants, colors, components | ⭐⭐ High |
| `ONBOARDING_SPEC.md` | Onboarding flow, questions, roles | ⭐⭐ High |
| `BUILD_GUIDE.md` | Build instructions, dependencies | ⭐ Medium |

### Staging Documents
| Document | Purpose | Status |
|----------|---------|--------|
| `staging/LIVE_MODE_SPEC.md` | Live Mode features | ⏳ In Progress |
| `staging/HUMAN_SYSTEMS_SPEC.md` | Human systems features | ⏳ In Progress |

---

## Alignment Workflow

### Step 1: Document Reference Check

**Before reviewing any agent output**, verify alignment with:

1. **ARCHITECTURE.md** - Layer compliance
   - ✅ Layer 0 (Database): Invariants enforced?
   - ✅ Layer 1 (Services): Orchestration only?
   - ✅ Layer 2 (API): tRPC with Zod validation?
   - ✅ Layer 3 (AI): Authority model respected?

2. **PRODUCT_SPEC.md** - Feature compliance
   - ✅ Feature matches spec?
   - ✅ Business rules followed?
   - ✅ Edge cases handled?

3. **AI_INFRASTRUCTURE.md** - AI authority compliance
   - ✅ Correct authority level (A0-A3)?
   - ✅ No forbidden actions?
   - ✅ Proposals validated?

4. **schema.sql** - Database compliance
   - ✅ Schema matches?
   - ✅ Triggers respected?
   - ✅ Invariants not bypassed?

5. **UI_SPEC.md** - Frontend compliance (if applicable)
   - ✅ Colors match spec?
   - ✅ Components follow spec?
   - ✅ Spacing/typography correct?

### Step 2: Constitutional Verification

**Use MCP to automatically verify:**

```bash
# Check alignment with specific doc
# Agent can now reference docs directly via MCP
```

**Verification Checklist:**
- [ ] All constants match UI_SPEC.md §2
- [ ] All services respect ARCHITECTURE.md §1 (layers)
- [ ] All AI actions respect AI_INFRASTRUCTURE.md §3 (authority)
- [ ] All database operations respect schema.sql (invariants)
- [ ] All features match PRODUCT_SPEC.md requirements

### Step 3: Agent Output Review

**When reviewing agent output, check:**

1. **References Constitutional Docs**
   - ✅ Agent cites relevant spec sections
   - ✅ Agent explains alignment decisions

2. **Follows Spec Patterns**
   - ✅ Code matches documented patterns
   - ✅ Naming conventions match spec

3. **Respects Constraints**
   - ✅ No forbidden operations
   - ✅ Authority levels respected
   - ✅ Invariants not violated

---

## MCP-Enabled Alignment Tools

### Automatic Documentation Access

With MCP configured, agents can now:

1. **Read HustleXP Docs Directly**
   - Access: `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/`
   - Reference specific sections automatically
   - Verify alignment in real-time

2. **Constitutional Verification**
   - Check against PRODUCT_SPEC.md
   - Verify ARCHITECTURE.md compliance
   - Validate AI_INFRASTRUCTURE.md authority

3. **Alignment Checks**
   - Constants match UI_SPEC.md
   - Schema matches schema.sql
   - Features match PRODUCT_SPEC.md

---

## Key Reference Points

### Backend References

```typescript
// backend/ai/authority.ts
export const HUSTLEXP_DOCS_PATH = '/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS';

export const CONSTITUTIONAL_REFERENCES = {
  AI_INFRASTRUCTURE: `${HUSTLEXP_DOCS_PATH}/AI_INFRASTRUCTURE.md`,
  ARCHITECTURE: `${HUSTLEXP_DOCS_PATH}/ARCHITECTURE.md`,
  PRODUCT_SPEC: `${HUSTLEXP_DOCS_PATH}/PRODUCT_SPEC.md`,
  SCHEMA: `${HUSTLEXP_DOCS_PATH}/schema.sql`,
  BUILD_GUIDE: `${HUSTLEXP_DOCS_PATH}/BUILD_GUIDE.md`,
} as const;
```

### Alignment Verification Examples

#### Example 1: Service Implementation
**Check**: Does service respect Layer 1 (Services)?

**Reference**: `ARCHITECTURE.md §1`
- ✅ Service orchestrates only, doesn't bypass DB triggers
- ✅ Service handles HX error codes correctly
- ✅ Service uses proper error handling

#### Example 2: API Endpoint
**Check**: Does endpoint use tRPC with Zod?

**Reference**: `ARCHITECTURE.md §2`
- ✅ Endpoint uses tRPC router
- ✅ Input validated with Zod schema
- ✅ Returns proper ServiceResult types

#### Example 3: AI Function
**Check**: Does AI function respect authority model?

**Reference**: `AI_INFRASTRUCTURE.md §3`
- ✅ Function checks authority level
- ✅ Function doesn't execute A0 forbidden actions
- ✅ Function validates proposals if A2

#### Example 4: UI Component
**Check**: Do colors match UI_SPEC?

**Reference**: `UI_SPEC.md §2`
- ✅ Colors use constants from spec
- ✅ Spacing matches typography spec
- ✅ Components follow spec patterns

---

## Alignment Verification Script

### For Agent Coordination

When an agent submits output, run this checklist:

```markdown
## HustleXP Alignment Verification

### Constitutional Compliance
- [ ] **ARCHITECTURE.md**: Layer compliance verified
- [ ] **PRODUCT_SPEC.md**: Feature requirements met
- [ ] **AI_INFRASTRUCTURE.md**: Authority model respected
- [ ] **schema.sql**: Database invariants not violated

### Implementation Quality
- [ ] **Code Style**: Matches existing patterns
- [ ] **Error Handling**: Proper HX error code handling
- [ ] **Type Safety**: TypeScript types match schema
- [ ] **Documentation**: Code documented with spec references

### Integration Points
- [ ] **Backend API**: Uses correct tRPC endpoints
- [ ] **Database**: Respects constitutional schema
- [ ] **AI System**: Follows authority constraints
- [ ] **Frontend**: Matches UI_SPEC if applicable
```

---

## Quick Reference Commands

### Access Documentation

```bash
# Open HustleXP docs directory
cd /Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS

# View specific spec
cat PRODUCT_SPEC.md
cat ARCHITECTURE.md
cat AI_INFRASTRUCTURE.md

# Search for specific sections
grep -r "INV-1" . # Find invariant references
grep -r "A0" . # Find authority level references
```

### Verify Alignment

```bash
# Check backend references docs correctly
grep -r "HUSTLEXP_DOCS_PATH" backend/

# Verify schema alignment
diff backend/database/constitutional-schema.sql HUSTLEXP-DOCS/schema.sql

# Check UI constants alignment
diff HUSTLEXP-DOCS/constants/colors.js <implementation>
```

---

## MCP Integration

### With MCP Enabled (RAG-Powered)

Agents can now:

1. **RAG-Powered Doc Access** (GroundX MCP) ⭐ **PREVENTS HALLUCINATIONS**
   - Query docs with natural language: "What does PRODUCT_SPEC.md say about task pricing?"
   - Pull exact text from specifications
   - Get real references, not made-up specs
   - Example: "Search all HustleXP docs for 'INV-1' references"

2. **Automatic Doc Access**
   - Read docs directly from `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/`
   - Reference sections in real-time
   - Verify alignment automatically

3. **Constitutional Checks** (RAG-Enhanced)
   - Validate against PRODUCT_SPEC.md with exact quotes
   - Verify ARCHITECTURE.md compliance with spec text
   - Check AI_INFRASTRUCTURE.md authority with real rules
   - Example: "Does this match ARCHITECTURE.md Layer 1?" → Returns exact Layer 1 requirements

4. **Alignment Verification** (Automated RAG)
   - Compare constants with UI_SPEC.md (exact values)
   - Verify schema matches schema.sql (actual schema)
   - Check features against PRODUCT_SPEC.md (real requirements)
   - Example: "Find all services that return ServiceResult<T>"

### RAG Examples

**Query Specs**:
```
"What does PRODUCT_SPEC.md require for task creation?"
→ GroundX returns exact spec requirements

"Does this implementation match ARCHITECTURE.md Layer 1?"
→ GroundX compares with exact Layer 1 requirements

"What does AI_INFRASTRUCTURE.md say about A2 authority?"
→ GroundX returns exact A2 rules from spec
```

**Code Search**:
```
"Find examples of ServiceResult usage in the codebase"
→ GroundX searches code and returns real examples

"Search all HustleXP docs for 'INV-1' references"
→ GroundX finds all INV-1 mentions across docs
```

---

## Next Steps

1. ✅ **MCP Configured** - Ready for doc access
2. ✅ **Documentation Structure** - Clear and organized
3. ⏳ **Agent Workflows** - Use docs for all reviews
4. ⏳ **Automated Checks** - Verify alignment automatically

---

## Summary

With **GroundX MCP (RAG)** configured, we can now execute **flawless HustleXP documentation alignment** by:

1. ✅ **RAG-Powered Access** - Query docs with natural language, get exact spec quotes (prevents hallucinations)
2. ✅ **Automatic Access** - Agents can read docs directly
3. ✅ **Real-time Verification** - Check alignment as code is written with exact spec comparisons
4. ✅ **Constitutional Compliance** - Ensure all work respects specs with real references
5. ✅ **Consistent Quality** - All agents align with same standards (exact spec requirements)
6. ✅ **No Hallucinations** - Pull exact info from Markdown, PDFs, or source files

**Status**: ✅ **READY FOR FLAWLESS RAG-BASED ALIGNMENT**

All agent outputs can now be automatically verified against **exact HustleXP constitutional specifications** using RAG!

**MCP Servers Configured**:
- ✅ GroundX MCP (RAG on docs)
- ✅ Mobile MCP (iOS simulator)
- ✅ XcodeBuildMCP (Xcode builds)
- ✅ GitHub MCP (repo management)
- ✅ Expo MCP (Expo SDK)
