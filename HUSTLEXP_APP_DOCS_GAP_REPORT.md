# HustleXP App → Docs Gap Report

**Date:** January 16, 2025  
**Purpose:** Identify gaps between app implementation and HUSTLEXP-DOCS spec repo  
**Status:** 🔴 **CRITICAL ARCHITECTURAL MISALIGNMENT**

---

## Executive Summary

**The app is making design decisions independently of the docs.** This violates the "Docs = LAW, App = COMPILER" principle.

**Key Problem:**
- Components were **extracted from code** (Phase 2) instead of being **declared in docs first**
- Design tokens exist **only in app code**, not in HUSTLEXP-DOCS
- Stitch prompts are in the **wrong repo** (`frontend/stitch-prompts/` in backend repo)
- Screen implementations have **weak references** (loose comments, not structured metadata)
- **No binding contract** between app screens and spec files

---

## Gap 1: Components Extracted from Code, Not Declared in Docs

### ❌ Current State

**App has (NEW):**
- `hustlexp-app/ui/GlassCard.tsx` — Primary/secondary variants
- `hustlexp-app/ui/PrimaryActionButton.tsx` — Neutral action button
- `hustlexp-app/ui/SectionHeader.tsx` — Section typography

**HUSTLEXP-DOCS has (OLD):**
- `HUSTLEXP-DOCS/components/Card.js` — Legacy component (not aligned with UI spec)
- `HUSTLEXP-DOCS/components/Button.js` — Legacy component (not aligned with UI spec)
- No `GlassCard.md` spec
- No `PrimaryActionButton.md` spec
- No `SectionHeader.md` spec

**Impact:**
- Components were "discovered" during implementation
- No upstream authority to reference
- Drift is inevitable

---

## Gap 2: Design Tokens Exist Only in App Code

### ❌ Current State

**App has (NEW):**
- `hustlexp-app/ui/colors.ts` — Color constants
- `hustlexp-app/ui/spacing.ts` — Spacing constants
- `hustlexp-app/ui/typography.ts` — Typography constants

**HUSTLEXP-DOCS has (OLD):**
- `HUSTLEXP-DOCS/constants/colors.js` — Legacy constants (likely different values)
- `HUSTLEXP-DOCS/constants/spacing.js` — Legacy constants (likely different values)
- `HUSTLEXP-DOCS/constants/typography.js` — Legacy constants (likely different values)

**Impact:**
- Design tokens were "invented" during extraction
- No single source of truth
- App and docs can diverge silently

---

## Gap 3: Stitch Prompts in Wrong Repository

### ❌ Current State

**Stitch prompts location:**
- `hustlexp-ai-backend/frontend/stitch-prompts/*.md` — 33 files
- Includes all LOCKED specs (01-13, E1-E3)

**Should be:**
- `HUSTLEXP-DOCS/ui-specs/stitch-prompts/*.md` — Canonical location
- Referenced by app implementations

**Impact:**
- Specs live in the backend repo, not the docs repo
- No clear ownership
- App references local `frontend/stitch-prompts/`, not canonical source

---

## Gap 4: Screen Implementations Have Weak References

### ❌ Current State

**App screens have:**
```ts
/**
 * LOCKED: Spec matches 02-hustler-home-LOCKED.md
 */
```

**Should have:**
```ts
/**
 * Screen: HUSTLER_HOME
 * Spec: HUSTLEXP-DOCS/ui-specs/screens/02-hustler-home-LOCKED.md
 * Version: v1
 * Status: LOCKED
 * Required Components:
 *   - GlassCard (primary, secondary)
 *   - SectionHeader
 * Required Tokens:
 *   - colors.glassPrimary
 *   - spacing.section
 */
```

**Impact:**
- No structured metadata
- No component/token dependency tracking
- No version enforcement
- References are ambiguous ("matches X.md" — where?)

---

## Gap 5: No Binding Contract Between App and Docs

### ❌ Current State

**App:**
- Screens reference specs with loose comments
- Components reference nothing
- Tokens reference nothing

**HUSTLEXP-DOCS:**
- No component specs for GlassCard, PrimaryActionButton, SectionHeader
- No token JSON files matching app constants
- No screen registry mapping app implementations to specs

**Impact:**
- No way to enforce "docs = law"
- No way to detect drift
- No way to audit compliance
- App can diverge without detection

---

## Gap 6: HUSTLEXP-DOCS Contains Legacy Code

### ❌ Current State

**HUSTLEXP-DOCS has:**
- Old React Native components (`Card.js`, `Button.js`) — not aligned with UI spec
- Old screens (`HomeScreen.js`, `LoginScreen.js`) — not the new MAX-tier screens
- Old constants (values likely different from app)

**These should be:**
- Marked as legacy/deprecated
- Or removed
- Or aligned with current UI spec

**Impact:**
- Confusion about which is canonical
- Risk of referencing wrong components
- Spec drift between old and new

---

## Gap 7: No Spec Enforcement Checklist

### ❌ Current State

**No validation that:**
- Screen implements exact spec
- Uses only documented components
- Uses only documented tokens
- Matches version declared in spec

**Impact:**
- Drift goes undetected
- Violations are not caught
- "Docs = law" is not enforced

---

## Immediate Action Items (Priority Order)

### 1. **FREEZE app components/tokens** (do not change)
- `hustlexp-app/ui/GlassCard.tsx`
- `hustlexp-app/ui/PrimaryActionButton.tsx`
- `hustlexp-app/ui/SectionHeader.tsx`
- `hustlexp-app/ui/colors.ts`
- `hustlexp-app/ui/spacing.ts`
- `hustlexp-app/ui/typography.ts`

### 2. **DECLARE components in HUSTLEXP-DOCS** (create docs first)
- `HUSTLEXP-DOCS/ui-specs/components/glass-card.md`
- `HUSTLEXP-DOCS/ui-specs/components/primary-action-button.md`
- `HUSTLEXP-DOCS/ui-specs/components/section-header.md`

### 3. **EXPORT design tokens to HUSTLEXP-DOCS** (JSON files)
- `HUSTLEXP-DOCS/ui-specs/tokens/colors.json`
- `HUSTLEXP-DOCS/ui-specs/tokens/spacing.json`
- `HUSTLEXP-DOCS/ui-specs/tokens/typography.json`

### 4. **MIGRATE stitch prompts to HUSTLEXP-DOCS** (move from backend repo)
- Move `frontend/stitch-prompts/*` → `HUSTLEXP-DOCS/ui-specs/stitch-prompts/*`

### 5. **ADD structured metadata to app screens** (reference docs explicitly)
- Update screen headers with spec path, version, required components/tokens

### 6. **CREATE enforcement contract** (validation checklist)
- Define what makes a screen "compliant"
- Create audit script

---

## Recommended Architecture (Target State)

```
HUSTLEXP-DOCS/
  ui-specs/
    screens/
      01-hustler-home-LOCKED.md
      02-instant-interrupt-card-LOCKED.md
      16-e2-eligibility-mismatch-LOCKED.md
      17-e3-trust-tier-locked-LOCKED.md
    components/
      glass-card.md
      primary-action-button.md
      section-header.md
    tokens/
      colors.json
      spacing.json
      typography.json
    stitch-prompts/
      (all .md files from frontend/stitch-prompts/)
```

**App references:**
- `@spec HUSTLEXP-DOCS/ui-specs/screens/01-hustler-home-LOCKED.md`
- `@component HUSTLEXP-DOCS/ui-specs/components/glass-card.md`
- `@token HUSTLEXP-DOCS/ui-specs/tokens/colors.json`

---

## Status

**Current:** 🔴 **App is making decisions independently**  
**Target:** 🟢 **App is a compiler for HUSTLEXP-DOCS**

---

## Next Step

Choose one:
1. **Create component/token specs in HUSTLEXP-DOCS now** (recommended)
2. **Migrate stitch prompts to HUSTLEXP-DOCS**
3. **Add structured metadata headers to app screens**
4. **Design enforcement contract/checklist**

You're exactly right — the app should only reference HUSTLEXP-DOCS, not invent.
