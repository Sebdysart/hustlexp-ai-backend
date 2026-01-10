# Agent Alignment Checklist

> **Status**: ✅ MCP-Enabled for Flawless Alignment  
> **Purpose**: Quick reference checklist for verifying agent work against HustleXP constitutional specifications

## Quick Alignment Check

Before approving any agent work, verify these:

### 1. Constitutional Documentation Alignment ⭐ **REQUIRED**

- [ ] **PRODUCT_SPEC.md** - Feature matches spec requirements
- [ ] **ARCHITECTURE.md** - Follows layer model (0-3)
- [ ] **AI_INFRASTRUCTURE.md** - Respects authority model (A0-A3)
- [ ] **schema.sql** - Database operations respect invariants

**Location**: `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/`  
**Access**: Use MCP to read docs directly

### 2. Implementation Quality

- [ ] **Error Handling**: Uses HX error codes (HX001-HX905)
- [ ] **Type Safety**: TypeScript types match schema
- [ ] **Service Pattern**: Returns `ServiceResult<T>`
- [ ] **Code Style**: Matches existing patterns
- [ ] **Documentation**: References spec sections

### 3. Architecture Compliance

**If Backend Service:**
- [ ] Layer 1 (Services): Orchestrates only, relies on DB triggers
- [ ] No bypassing: Doesn't skip database invariants
- [ ] Error handling: Catches HX error codes correctly

**If API Endpoint:**
- [ ] Layer 2 (API): Uses tRPC router
- [ ] Validation: Uses Zod schemas
- [ ] Returns: Proper ServiceResult types

**If AI Function:**
- [ ] Layer 3 (AI): Checks authority level
- [ ] No A0 violations: Doesn't execute forbidden actions
- [ ] Proposals: Validates A2 proposals correctly

### 4. Integration Points

- [ ] **Backend API**: Uses correct tRPC endpoints
- [ ] **Database**: Respects constitutional schema
- [ ] **AI System**: Follows authority constraints
- [ ] **Frontend**: Matches UI_SPEC.md (if applicable)

---

## Verification Commands

### Check Alignment Automatically

```bash
# Verify specific file
tsx scripts/verify-docs-alignment.ts backend/src/services/YourService.ts

# Check all files
tsx scripts/verify-docs-alignment.ts
```

### Access Documentation

```bash
# Open HustleXP docs
cd /Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS

# View key specs
cat PRODUCT_SPEC.md
cat ARCHITECTURE.md
cat AI_INFRASTRUCTURE.md
cat schema.sql
```

### Search for References

```bash
# Find invariant references
grep -r "INV-1" /Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS

# Find authority level references
grep -r "A0\|A1\|A2\|A3" /Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS

# Find layer references
grep -r "Layer 0\|Layer 1\|Layer 2\|Layer 3" /Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS
```

---

## MCP-Enabled Workflow

With MCP configured, you can:

1. **Direct Doc Access**
   - Read: `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/PRODUCT_SPEC.md`
   - Reference: Specific sections automatically
   - Verify: Alignment in real-time

2. **Automatic Verification**
   - Check: Against all constitutional docs
   - Validate: Architecture compliance
   - Confirm: Authority model respect

3. **Flawless Alignment**
   - All work: Matches specs perfectly
   - No drift: Consistent with documentation
   - Quality: Constitutional compliance guaranteed

---

## Example Review Response

```
## Review of Agent [ID] Output

### ✅ Strengths
- Properly references PRODUCT_SPEC.md §3.2
- Follows ARCHITECTURE.md Layer 1 pattern
- Uses correct HX error codes

### ⚠️ Areas for Improvement
- Missing authority check (see AI_INFRASTRUCTURE.md §3.2)
- Should reference schema.sql for table structure

### 🚨 Blockers
- Violates INV-1 (see ARCHITECTURE.md §1.2)
- Missing A2 proposal validation (see AI_INFRASTRUCTURE.md §3.3)

### 📚 Documentation References
- PRODUCT_SPEC.md §3.2 - Task creation requirements
- ARCHITECTURE.md §1 - Layer model compliance
- AI_INFRASTRUCTURE.md §3.2 - Authority levels

### ✅ Status: Needs Revision / Approved
```

---

## Key Constitutional Points

### Layer 0 (Database) - Highest Authority
- Invariants enforced via triggers
- Cannot be bypassed by application code
- References: `schema.sql`, `ARCHITECTURE.md §1`

### Layer 1 (Services) - Orchestration Only
- Relies on DB triggers for enforcement
- Handles HX error codes
- References: `ARCHITECTURE.md §1.1`

### Layer 2 (API) - tRPC with Validation
- Uses tRPC routers
- Zod schema validation
- References: `ARCHITECTURE.md §1.2`

### Layer 3 (AI) - Authority Model
- A0: Forbidden (XP, trust, payments, bans)
- A1: Read-only (summaries, views)
- A2: Proposals (validated by rules)
- A3: Restricted execution (proof requests)
- References: `AI_INFRASTRUCTURE.md §3`

---

## Quick Reference

**HustleXP Docs Path**: `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/`

**Key Files**:
- `PRODUCT_SPEC.md` - What features should do
- `ARCHITECTURE.md` - How system should be built
- `AI_INFRASTRUCTURE.md` - What AI can/cannot do
- `schema.sql` - How database enforces rules
- `UI_SPEC.md` - How UI should look

**Verification Script**: `scripts/verify-docs-alignment.ts`

**Status**: ✅ **MCP-ENABLED FOR FLAWLESS ALIGNMENT**
