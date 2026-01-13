# MCP Authority Contract Template

**Date**: January 2025  
**Purpose**: Define authority tiers and enforcement rules for all MCP servers  
**Status**: **OPERATIONAL REQUIREMENT** — Must be enforced

---

## 🎯 Authority Tiers

### Tier 0 — Truth & Enforcement (Cannot be bypassed)

These MCPs define **reality**. They are the source of truth.

| MCP | Authority | Enforcement Rule |
|-----|-----------|------------------|
| **filesystem** | Full workspace access | AI must verify code against specs |
| **database** | READ-ONLY schema inspection | AI must verify logic against constraints |
| **test-runner** | Execute tests | No logic ships without passing tests |
| **xcodebuild** | iOS build authority | No UI ships without successful build |
| **github** | Repository access (restricted) | PRs only, no push to main, read-only default |

**Hard Rules**:
- ❌ No UI ships without Rive compile success
- ❌ No logic ships without tests passing
- ❌ No build ships without xcodebuild success
- ❌ No MCP can invent behavior
- ❌ No MCP can write irreversible state

---

### Tier 1 — Compilers / Validators

These MCPs validate correctness.

| MCP | Authority | Enforcement Rule |
|-----|-----------|------------------|
| **rive** | Rive animation compiler | No UI ships without Rive compile success |
| **typescript** | Type checking (implicit) | Must pass before any deployment |
| **lint** | Code quality (implicit) | Must pass before any deployment |

**Hard Rules**:
- ✅ All code must compile
- ✅ All types must be valid
- ✅ All lint rules must pass

---

### Tier 2 — Assistive (Low Authority)

These MCPs provide assistance but have no authority over correctness.

| MCP | Authority | Enforcement Rule |
|-----|-----------|------------------|
| **svgmaker** | Static SVG generation | Icons/visuals only, no interaction/state |
| **mobile-mcp** | Diagnostics only (if enabled) | Zero authority on "build works" |

**Hard Rules**:
- ✅ Outputs marked "non-authoritative"
- ✅ Cannot touch repo or UI artifacts
- ✅ Cannot imply state or behavior

---

## 🚫 Disabled MCPs

### magic-mcp — DISABLED

**Reason**: Actively undermines architecture
- ❌ Invents UI
- ❌ Invents flows
- ❌ Bypasses compilers
- ❌ Does not respect escrow/trust/XP semantics

**Status**: **DISABLED** (not "limited" or "careful")

**If re-enabled later**:
- Must be sandboxed
- Outputs marked "non-authoritative"
- Cannot touch repo or UI artifacts

---

## ✅ Current MCP Configuration

### Tier 0 — Truth & Enforcement

#### 1. filesystem ✅
```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem@latest", "/Users/sebastiandysart/HustleXP"]
}
```
**Authority**: Tier 0 (Truth)  
**Access**: Full workspace (recursive)  
**Enforcement**: AI must verify code against specs

---

#### 2. database ❌ MISSING
**Status**: **REQUIRED** — Must be added

**Required Capabilities**:
- Schema inspection (read-only)
- Constraint visibility
- Audit table access
- Query execution (read-only)

**Configuration**: See `docs/MCP_DATABASE_CONFIG.md` (to be created)

---

#### 3. test-runner ❌ MISSING
**Status**: **REQUIRED** — Must be added

**Required Capabilities**:
- Execute backend tests
- Execute contract tests
- Execute invariant tests
- Report test results

**Configuration**: See `docs/MCP_TEST_RUNNER_CONFIG.md` (to be created)

---

#### 4. xcodebuild ✅
```json
{
  "command": "npx",
  "args": ["-y", "xcodebuildmcp@latest"],
  "env": {
    "INCREMENTAL_BUILDS_ENABLED": "true"
  }
}
```
**Authority**: Tier 0 (Execution)  
**Enforcement**: Any UI or logic touching native paths **must** pass this MCP

---

#### 5. github ⚠️ RESTRICTED
```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github@latest"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "...",
    "GITHUB_REPOSITORY": "sebastiandysart/hustlexp-ai-backend",
    "GITHUB_DEFAULT_BRANCH": "main",
    "GITHUB_ALLOWED_BRANCHES": "develop,feature/*",
    "GITHUB_READ_ONLY": "true"
  }
}
```
**Authority**: Tier 0 (Repository)  
**Restrictions**:
- ❌ No push to `main`
- ❌ No force pushes
- ✅ PRs only
- ✅ Read-only by default
- ✅ Only allowed branches: `develop`, `feature/*`

**Note**: These restrictions must be enforced at the MCP level or via GitHub branch protection rules.

---

### Tier 1 — Compilers / Validators

#### 6. rive ✅
```json
{
  "url": "http://localhost:9791/sse"
}
```
**Authority**: Tier 1 (Compiler)  
**Enforcement**: "No UI ships without Rive compile success"

**Note**: This enforcement rule must be implemented mechanically (not just documented).

---

### Tier 2 — Assistive

#### 7. svgmaker ✅
```json
{
  "command": "npx",
  "args": ["-y", "@genwave/svgmaker-mcp@latest"],
  "env": {
    "SVGMAKER_API_KEY": "svgmaker-iod1eb75967cdf8154"
  }
}
```
**Authority**: Tier 2 (Assistive)  
**Allowed**: Icons, static visuals  
**Forbidden**: Interaction, signaling, state implication

---

## 🚫 Disabled MCPs

### mobile-mcp — DISABLED

**Reason**: Competing mobile authority
- Already have: Expo tooling, xcodebuild MCP
- Sits in undefined middle layer
- Ambiguously powerful

**Status**: **DISABLED** (Option A - Recommended)

**If re-enabled later** (Option B):
- Demote to diagnostics only
- Zero authority on "build works"
- Must be explicitly scoped

---

### magic-mcp — DISABLED

**Reason**: Actively undermines architecture
- Invents UI
- Invents flows
- Bypasses compilers
- Does not respect escrow/trust/XP semantics

**Status**: **DISABLED** (not "limited" or "careful")

---

## 📋 Enforcement Checklist

### Tier 0 Enforcement

- [ ] **filesystem**: AI verifies code against specs (automated check)
- [ ] **database**: AI verifies logic against constraints (read-only access)
- [ ] **test-runner**: No logic ships without passing tests (automated gate)
- [ ] **xcodebuild**: No UI ships without successful build (automated gate)
- [ ] **github**: No push to main, PRs only (branch protection + MCP restrictions)

### Tier 1 Enforcement

- [ ] **rive**: No UI ships without Rive compile success (automated gate)
- [ ] **typescript**: All code must compile (CI/CD gate)
- [ ] **lint**: All lint rules must pass (CI/CD gate)

### Tier 2 Enforcement

- [ ] **svgmaker**: Outputs marked "non-authoritative", icons only
- [ ] **mobile-mcp**: Disabled (if re-enabled, diagnostics only)

---

## 🎯 Done Criteria

You are done when:

- ✅ No UI ships without Rive compile
- ✅ No logic ships without tests
- ✅ No build ships without xcodebuild
- ✅ No MCP can invent behavior
- ✅ No MCP can write irreversible state
- ✅ Database MCP added (read-only)
- ✅ Test runner MCP added
- ✅ All enforcement rules implemented mechanically

At that point, you don't "use MCPs."

You **run a constrained AI operating system**.

---

## 📝 Missing MCPs (CRITICAL)

### 1. Database MCP (READ-ONLY) ❌

**Required**:
- Schema inspection
- Constraint visibility
- Audit table access
- Query execution (read-only)

**Without this**:
- AI can design impossible logic
- Escrow/XP/trust drift silently
- UI can imply illegal states

**Configuration**: See `docs/MCP_DATABASE_CONFIG.md` (to be created)

---

### 2. Test Runner MCP ❌

**Required**:
- Execute backend tests
- Execute contract tests
- Execute invariant tests
- Report test results

**Without this**:
- Nothing executes backend logic
- Nothing verifies invariants
- Nothing catches regressions

**Configuration**: See `docs/MCP_TEST_RUNNER_CONFIG.md` (to be created)

---

## 🔧 Immediate Fix Checklist

1. ✅ **Disable `magic-mcp`** — DONE
2. ✅ **Lock down GitHub MCP permissions** — DONE (added restrictions, but enforcement needed)
3. ✅ **Remove `mobile-mcp`** — DONE
4. ⏳ **Add database READ-ONLY MCP** — TODO
5. ⏳ **Add test runner MCP** — TODO
6. ⏳ **Write authority rules for each MCP** — DONE (this document)
7. ⏳ **Implement mechanical enforcement** — TODO

---

**Last Updated**: January 2025  
**Status**: Authority contract defined, 2 MCPs missing, enforcement pending
