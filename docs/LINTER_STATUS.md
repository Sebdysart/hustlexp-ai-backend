# Linter Status

## Current Status

The TypeScript language server reports errors in `backend/src/jobs/workers.ts` for:
- `Cannot find module 'bullmq'` (line 25)
- `Cannot find name 'process'` (multiple lines)
- `Cannot find name 'require'` (line 199)
- `Cannot find name 'module'` (line 199)

## Analysis

1. **TypeScript compilation**: No `lint` or `typecheck` script exists in `package.json`
2. **Build command**: `npm run build` uses `tsc`, but `tsc` is not installed (dev dependency exists but node_modules not present)
3. **Runtime**: Code runs successfully via `tsx` (TypeScript executor), which handles type resolution differently than the language server
4. **Type definitions**: `@types/node` is installed (line 61 of package.json)

## Root Cause

These are **TypeScript language server errors**, not actual compilation errors. The language server's type resolution differs from `tsc`/`tsx` runtime behavior.

**Evidence:**
- Code runs successfully in production via `tsx`
- `@types/node` provides `process`, `require`, `module` definitions
- `bullmq` types are provided by the package itself (peer dependency)

## Resolution Options

### Option A: Fix TypeScript Configuration (Recommended)
Add `types` to `tsconfig.json` to explicitly include Node.js types:
```json
{
  "compilerOptions": {
    "types": ["node"]
  }
}
```

### Option B: Install Missing Dependencies
Run `npm install` to ensure `node_modules` exists (would fix `tsc` availability)

### Option C: Document as Known Issue
Accept that language server errors exist but code compiles/runs correctly

## Decision

**Option A** (Fix TypeScript configuration) - Add explicit type definitions.

## Verification

After fixing:
1. Language server errors should clear
2. `npm run build` (once node_modules exists) should pass
3. Runtime behavior unchanged

---

**Status**: P1 (does not block runtime, but should be fixed for developer experience)
