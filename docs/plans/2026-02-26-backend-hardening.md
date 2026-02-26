# Backend Hardening — Full Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `hustlexp-ai-backend` zero-error, zero-warning, scale-proof, and audit-proof — no AI or human reviewer should find a structural, type, security, or reliability issue.

**Architecture:** Risk-first (fix 5 production failure modes) + Layer-by-layer sweep (TypeScript → error handling → route decomposition → tests → CI). Preserve all existing functionality. Delete all Citadel/autonomous SDLC overhead.

**Tech Stack:** Node.js 20, TypeScript 5 (strict), Fastify, Hono, tRPC, Zod, Vitest, ESLint, Firebase Auth, Stripe, BullMQ, PostgreSQL (Neon), Redis (Upstash)

---

## Phase 0 — Purge the Noise

### Task 1: Delete Citadel and autonomous SDLC workflows

**Files:**
- Delete: `.github/workflows/citadel.yml`
- Delete: `.github/workflows/claude-implement.yml`
- Delete: `.github/workflows/orchestrator.yml`
- Delete: `.github/workflows/holodeck.yml`
- Delete: `.github/workflows/claude-review-fix.yml`

**Step 1: Delete the workflow files**
```bash
rm .github/workflows/citadel.yml
rm .github/workflows/claude-implement.yml
rm .github/workflows/orchestrator.yml
rm .github/workflows/holodeck.yml
rm .github/workflows/claude-review-fix.yml
ls .github/workflows/
# Expected: ci.yml  deploy-aws.yml  deploy.yml  security.yml
```

**Step 2: Verify only good workflows remain**
```bash
ls .github/workflows/
# Must show ONLY: ci.yml  deploy-aws.yml  deploy.yml  security.yml
```

**Step 3: Commit**
```bash
git add .github/workflows/
git commit -m "chore: remove Citadel Governor and autonomous SDLC workflows"
```

---

### Task 2: Delete Citadel scripts and artifacts

**Files:**
- Delete: `scripts/citadel-constitution-enforcer.ts`
- Delete: `scripts/citadel-integrity-lock.sh`
- Delete: `scripts/citadel-mutation-gate.ts`
- Delete: `scripts/citadel-oracle-ensemble.ts`
- Delete: `scripts/citadel-provenance.ts`
- Delete: `scripts/compute-readiness-score.ts`
- Delete: `scripts/classify-pr-changes.ts`
- Delete: `scripts/citadel-rules/` (directory)
- Delete: `citadel-provenance.sqlite`
- Delete: `citadel-constitution-report.md`
- Delete: `citadel-provenance-report.md`
- Delete: `stryker.config.ts`

**Step 1: Delete files**
```bash
rm -f scripts/citadel-constitution-enforcer.ts
rm -f scripts/citadel-integrity-lock.sh
rm -f scripts/citadel-mutation-gate.ts
rm -f scripts/citadel-oracle-ensemble.ts
rm -f scripts/citadel-provenance.ts
rm -f scripts/compute-readiness-score.ts
rm -f scripts/classify-pr-changes.ts
rm -rf scripts/citadel-rules/
rm -f citadel-provenance.sqlite
rm -f citadel-constitution-report.md
rm -f citadel-provenance-report.md
rm -f stryker.config.ts
```

**Step 2: Remove Citadel npm scripts from package.json**

Open `package.json` and remove these entries from `"scripts"`:
```json
"citadel:mutate": "...",
"citadel:constitution": "...",
"citadel:oracle": "...",
"citadel:provenance": "..."
```

**Step 3: Remove Citadel devDependencies from package.json**

Remove from `"devDependencies"`:
```json
"@noble/ed25519": "...",
"@noble/hashes": "...",
"@stryker-mutator/core": "...",
"@stryker-mutator/vitest-runner": "...",
"better-sqlite3": "...",
"@types/better-sqlite3": "..."
```

**Step 4: Reinstall and verify**
```bash
npm install
npm ls @noble/ed25519 2>&1 | grep "empty"
# Expected: "(empty)" — package gone
```

**Step 5: Update .gitignore to remove citadel entries**

Open `.gitignore` and remove lines:
```
citadel-constitution-report.md
citadel-oracle-report.json
citadel-oracle-report.md
stryker-report.json
reports/
```

**Step 6: Close GitHub issue #12 and delete auto label**
```bash
gh issue close 12 --comment "Closing — autonomous SDLC pipeline removed"
gh label delete "auto" --yes
```

**Step 7: Commit**
```bash
git add -A
git commit -m "chore: remove Citadel scripts, artifacts, and unused devDeps"
```

---

## Phase 1 — Fix the 5 Production Risks

### Task 3: Fix auth request typing (blocks all Phase 2 `any` fixes)

The root cause of most `(request as any).user?.uid` usages is that Fastify's `FastifyRequest` doesn't know about the `user` property added by Firebase auth middleware.

**Files:**
- Create: `src/types/fastify.d.ts`
- Modify: `src/index.ts`

**Step 1: Write the failing typecheck**
```bash
npx tsc --noEmit 2>&1 | grep "request.*as any" | wc -l
# Note the number — we'll reduce it to 0
```

**Step 2: Create the Fastify type augmentation**

Create `src/types/fastify.d.ts`:
```typescript
import 'fastify';
import type { DecodedIdToken } from 'firebase-admin/auth';

declare module 'fastify' {
  interface FastifyRequest {
    user?: DecodedIdToken;
    requestId?: string;
  }
}
```

**Step 3: Replace `(request as any).user?.uid` in src/index.ts**

Run:
```bash
grep -n "(request as any).user" src/index.ts
```

For each occurrence, replace:
```typescript
// BEFORE:
const userId = (request as any).user?.uid || 'anonymous';

// AFTER:
const userId = request.user?.uid ?? 'anonymous';
```

**Step 4: Run typecheck**
```bash
npx tsc --noEmit 2>&1 | grep "request as any" | wc -l
# Expected: 0
```

**Step 5: Commit**
```bash
git add src/types/fastify.d.ts src/index.ts
git commit -m "fix(types): augment FastifyRequest with user and requestId — eliminates request-as-any"
```

---

### Task 4: Fix `catch (error: any)` → `catch (error: unknown)` across all services

**Files:**
- Modify: `src/index.ts`
- Modify: `src/services/StripeService.ts`
- Modify: `src/services/FeedQueryService.ts`
- Modify: `src/services/TaxReportingService.ts`
- Modify: `src/services/BackgroundCheckService.ts`
- Modify: `src/services/DisputeResolutionService.ts`
- Modify: `src/services/DatabaseHealthService.ts`
- Modify: `src/services/CapabilityProfileService.ts`
- Modify: `src/services/LicenseVerificationService.ts`

**Step 1: Count current violations**
```bash
grep -rn "catch (error: any)\|catch (err: any)\|catch (e: any)" src/ --include="*.ts" | wc -l
# Note the count
```

**Step 2: Apply the fix pattern everywhere**

For every `catch (error: any)` block, change to:
```typescript
// BEFORE:
} catch (error: any) {
  logger.error({ error: error.message }, 'Something failed');
  throw new Error(error.message);
}

// AFTER:
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ error: message }, 'Something failed');
  throw new Error(message);
}
```

For `catch (err: any)` used with Sentry:
```typescript
// BEFORE:
} catch (err: any) {
  Sentry.captureException(err);
  throw err;
}

// AFTER:
} catch (err: unknown) {
  Sentry.captureException(err);
  throw err;
}
```

**Step 3: Verify**
```bash
grep -rn "catch (error: any)\|catch (err: any)\|catch (e: any)" src/ --include="*.ts" | wc -l
# Expected: 0
npx tsc --noEmit 2>&1 | wc -l
# Expected: 0
```

**Step 4: Commit**
```bash
git add src/
git commit -m "fix(types): replace catch(error: any) with catch(error: unknown) + type guard"
```

---

### Task 5: Fix DB row typing — replace `row: any` with proper interfaces

**Files:**
- Modify: `src/services/FeedQueryService.ts`
- Modify: `src/services/TaxReportingService.ts`
- Modify: `src/services/StripeService.ts`
- Modify: `src/services/BackgroundCheckService.ts`
- Modify: `src/services/DisputeResolutionService.ts`
- Modify: `src/services/CapabilityProfileService.ts`
- Modify: `src/services/LicenseVerificationService.ts`

**Step 1: For each service, identify the row shape being mapped**

Example — `FeedQueryService.ts` line 231:
```typescript
// BEFORE:
function formatTask(row: any, options: FeedQueryOptions): FeedTask {

// AFTER — add a private interface above the function:
interface TaskRow {
  task_id: string;
  title: string;
  description: string;
  price_amount: number;
  task_state: string;
  poster_id: string;
  city: string;
  state: string;
  category: string;
  created_at: string;
  // add all fields actually accessed in formatTask
}

function formatTask(row: TaskRow, options: FeedQueryOptions): FeedTask {
```

**Step 2: For SQL query results, use type assertion at query site (not in every row)**
```typescript
// BEFORE:
const rows = await sql`SELECT * FROM tasks WHERE ...`;
return rows.map((row: any) => formatTask(row));

// AFTER:
interface TaskRow { task_id: string; title: string; /* ... */ }
const rows = await sql`SELECT * FROM tasks WHERE ...` as TaskRow[];
return rows.map((row) => formatTask(row));
```

**Step 3: Fix transaction callbacks**
```typescript
// BEFORE:
await transaction(async (tx: any) => { ... });

// AFTER — define the tx type from the actual transaction utility:
import type { TransactionClient } from '../db/index.js';
await transaction(async (tx: TransactionClient) => { ... });
```

If `TransactionClient` doesn't exist in `src/db/index.ts`, add it:
```typescript
// In src/db/index.ts, add:
export type TransactionClient = typeof sql; // or the actual pg client type
```

**Step 4: Verify count drops**
```bash
grep -rn ": any\|as any\|any>" src/ --include="*.ts" | grep -v "\.test\." | wc -l
# Should be significantly lower — target: < 10
npx tsc --noEmit
```

**Step 5: Commit**
```bash
git add src/
git commit -m "fix(types): replace row: any with typed interfaces in all service DB queries"
```

---

### Task 6: Fix remaining `any` casts in src/index.ts and StripeMoneyEngine

**Files:**
- Modify: `src/index.ts`
- Modify: `src/services/StripeMoneyEngine.ts`

**Step 1: Fix `category as any` cast in src/index.ts (line ~1268)**
```typescript
// BEFORE:
category: body.category as any,

// AFTER — import the enum type:
import type { TaskCategory } from './types/index.js';
// Then use a Zod parse or type assertion with the enum:
category: body.category as TaskCategory,
// OR better: validate with Zod first so it's actually safe
```

**Step 2: Fix Stripe API version cast in StripeMoneyEngine.ts (line ~55)**
```typescript
// BEFORE:
new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' as any })

// AFTER — Stripe v17+ accepts the string directly:
new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' })
// If TypeScript rejects it, upgrade stripe package:
// npm install stripe@latest
```

**Step 3: Fix `executeHoldEscrow(payload: any)` in StripeMoneyEngine.ts (line ~126)**
```typescript
// BEFORE:
async function executeHoldEscrow(payload: any): Promise<{...}> {

// AFTER — define the payload type:
interface HoldEscrowPayload {
  taskId: string;
  amount: number;
  currency: string;
  customerId: string;
  // add all fields actually used
}
async function executeHoldEscrow(payload: HoldEscrowPayload): Promise<{...}> {
```

**Step 4: Fix BetaMetricsService and AlertService stub types**

These are stubs but have `...args: any[]`. Replace with `...args: unknown[]`:
```typescript
// src/services/BetaMetricsService.ts
killswitchActivated: (..._args: unknown[]) => {},
record: (..._args: unknown[]) => {},

// src/services/AlertService.ts
fire: async (..._args: unknown[]) => {},
notify: async (..._args: unknown[]) => {},
```

**Step 5: Final typecheck — must be zero**
```bash
npx tsc --noEmit
# Expected: exits 0, no output
grep -rn ": any\|as any\|any>" src/ --include="*.ts" | grep -v "\.test\." | grep -v "//.*any"
# Expected: 0 lines (or only intentional casts with comments)
```

**Step 6: Commit**
```bash
git add src/
git commit -m "fix(types): eliminate all remaining any types — zero any in production src/"
```

---

### Task 7: Stripe webhook — fix duplicate processing race condition

**Files:**
- Modify: `src/index.ts` (Stripe webhook handler section)
- Modify: `src/services/StripeService.ts`

**Step 1: Find the webhook idempotency logic**
```bash
grep -n "processed_stripe_events\|stripe_event_id\|ON CONFLICT\|INSERT INTO.*event" src/index.ts src/services/StripeService.ts
```

**Step 2: Find the INSERT for processed events**

Locate the line that marks an event as processed. It will look like:
```typescript
await sql`INSERT INTO processed_stripe_events (event_id, ...) VALUES (${event.id}, ...)`;
```

**Step 3: Replace with UPSERT**
```typescript
// BEFORE:
await sql`INSERT INTO processed_stripe_events (event_id, processed_at)
          VALUES (${event.id}, NOW())`;

// AFTER:
const result = await sql`
  INSERT INTO processed_stripe_events (event_id, processed_at)
  VALUES (${event.id}, NOW())
  ON CONFLICT (event_id) DO NOTHING
  RETURNING event_id
`;
if (result.length === 0) {
  logger.warn({ eventId: event.id }, 'Duplicate Stripe webhook — already processed, skipping');
  return { received: true, duplicate: true };
}
```

**Step 4: Write a test for this**

Create or add to `tests/unit/stripe-webhook-idempotency.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Stripe webhook idempotency', () => {
  it('processes a new event exactly once', async () => {
    // Mock sql to return a row (not a duplicate)
    const mockSql = vi.fn().mockResolvedValue([{ event_id: 'evt_123' }]);
    const result = await processStripeEvent('evt_123', mockSql);
    expect(result.duplicate).toBe(false);
    expect(mockSql).toHaveBeenCalledOnce();
  });

  it('returns duplicate:true for already-processed event ID', async () => {
    // Mock sql to return empty (ON CONFLICT DO NOTHING matched)
    const mockSql = vi.fn().mockResolvedValue([]);
    const result = await processStripeEvent('evt_already_processed', mockSql);
    expect(result.duplicate).toBe(true);
  });
});
```

**Step 5: Run tests**
```bash
npx vitest run --reporter=verbose 2>&1 | tail -20
```

**Step 6: Commit**
```bash
git add src/ tests/
git commit -m "fix(payments): Stripe webhook idempotency — ON CONFLICT DO NOTHING prevents duplicate processing"
```

---

### Task 8: Auth token revocation — reduce cache window

**Files:**
- Modify: `src/middleware/firebaseAuth.ts` (or wherever Firebase auth cache TTL is set)

**Step 1: Find the cache TTL**
```bash
grep -rn "TTL\|ttl\|expire\|15.*min\|900\|cache" src/middleware/ src/utils/ --include="*.ts" | grep -i "auth\|token\|firebase"
```

**Step 2: Reduce TTL from 15min to 5min**
```typescript
// BEFORE:
const TOKEN_CACHE_TTL = 15 * 60; // 15 minutes

// AFTER:
const TOKEN_CACHE_TTL = 5 * 60; // 5 minutes — reduces revocation window from 15min to 5min
```

**Step 3: Add revocation check on admin routes**

Find admin/financial route handlers. Add a fresh token check before critical operations:
```typescript
// In admin or financial route handlers:
const isRevoked = await checkTokenRevocation(request.user!.uid);
if (isRevoked) {
  return reply.status(401).send({ error: 'Token revoked', code: 'HX_AUTH_REVOKED' });
}
```

**Step 4: Write a test**
```typescript
// tests/unit/auth-revocation.test.ts
it('rejects a token within 5 minutes of revocation', async () => {
  // Mock Redis to return the revocation marker
  const redis = { get: vi.fn().mockResolvedValue('revoked') };
  const result = await verifyAuthToken('valid_token', redis);
  expect(result.revoked).toBe(true);
});
```

**Step 5: Commit**
```bash
git add src/ tests/
git commit -m "fix(auth): reduce token cache TTL to 5min, add revocation check on admin routes"
```

---

### Task 9: Escrow + XP atomic transaction

**Files:**
- Modify: `src/services/EscrowStateMachine.ts`
- Modify: `src/services/AtomicXPService.ts`

**Step 1: Find the escrow release + XP award code**
```bash
grep -n "XP\|xp\|award\|release" src/services/EscrowStateMachine.ts | head -20
```

**Step 2: Verify both operations happen inside ONE transaction**

The pattern must be:
```typescript
// CORRECT: Both operations inside single transaction
await db.transaction(async (tx) => {
  await releaseEscrow(escrowId, tx);   // Step 1: release funds
  await awardXP(userId, amount, tx);   // Step 2: award XP
  // If awardXP throws → entire transaction rolls back → escrow NOT released
});
```

If they're in separate transactions, combine them:
```typescript
// BEFORE (incorrect — two separate transactions):
await releaseEscrow(escrowId);
await awardXP(userId, xpAmount);

// AFTER (correct — atomic):
await db.transaction(async (tx) => {
  await releaseEscrowWithTx(escrowId, tx);
  await awardXPWithTx(userId, xpAmount, tx);
});
```

**Step 3: Write the invariant test**
```typescript
// tests/unit/escrow-xp-atomicity.test.ts
it('rolls back escrow release if XP award fails', async () => {
  const mockTx = createMockTransaction();
  vi.spyOn(AtomicXPService, 'awardXP').mockRejectedValue(new Error('XP service down'));

  await expect(releaseEscrowWithXP(testEscrowId, mockTx)).rejects.toThrow('XP service down');
  expect(mockTx.rolledBack).toBe(true);
  expect(mockTx.committed).toBe(false);
});
```

**Step 4: Run the test**
```bash
npx vitest run tests/unit/escrow-xp-atomicity.test.ts --reporter=verbose
```

**Step 5: Commit**
```bash
git add src/ tests/
git commit -m "fix(financial): make escrow release + XP award a single atomic transaction"
```

---

### Task 10: AI cascade failure — add degraded mode and request queuing

**Files:**
- Modify: `src/ai/orchestrator.ts`
- Modify: `src/config/env.ts`

**Step 1: Add AI_DEGRADED_MODE env var to env config**
```typescript
// In src/config/env.ts, add to the schema:
AI_DEGRADED_MODE: z.enum(['true', 'false']).default('false'),
AI_MAX_QUEUE_WAIT_MS: z.coerce.number().default(5000),
```

**Step 2: Add degraded mode handler to orchestrator**
```typescript
// In src/ai/orchestrator.ts:
export async function orchestrate(params: OrchestrateParams): Promise<OrchestrateResult> {
  if (env.AI_DEGRADED_MODE === 'true') {
    logger.warn({ params }, 'AI orchestrator in degraded mode — returning queued response');
    return {
      status: 'queued',
      jobId: await enqueueAIRequest(params),
      message: 'AI service temporarily unavailable. Your request is queued and will be processed shortly.',
    };
  }

  try {
    return await runOrchestrate(params);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, 'All AI models failed — entering degraded mode');
    return {
      status: 'queued',
      jobId: await enqueueAIRequest(params),
      message: 'AI service temporarily unavailable. Your request is queued.',
    };
  }
}
```

**Step 3: Add /health/ai endpoint to src/index.ts**
```typescript
fastify.get('/health/ai', async (_request, reply) => {
  return reply.send({
    degradedMode: env.AI_DEGRADED_MODE === 'true',
    models: {
      openai: await checkModelHealth('openai'),
      groq: await checkModelHealth('groq'),
      deepseek: await checkModelHealth('deepseek'),
    },
    timestamp: new Date().toISOString(),
  });
});
```

**Step 4: Commit**
```bash
git add src/
git commit -m "fix(ai): add degraded mode fallback and /health/ai endpoint for circuit breaker visibility"
```

---

## Phase 2 — Route Decomposition (src/index.ts is 4,584 lines)

### Task 11: Extract route groups from src/index.ts

A 4,584-line file is untestable and unmaintainable. Split it into logical route files.

**Files:**
- Create: `src/routes/tasks.ts`
- Create: `src/routes/escrow.ts`
- Create: `src/routes/users.ts`
- Create: `src/routes/ai.ts`
- Create: `src/routes/stripe.ts`
- Create: `src/routes/admin.ts`
- Modify: `src/index.ts` (shrink to ~200 lines: server setup + plugin registration)

**Step 1: Identify route groups in src/index.ts**
```bash
grep -n "fastify\.\(get\|post\|put\|delete\|patch\)" src/index.ts | head -50
# Review and group by domain
```

**Step 2: Create src/routes/tasks.ts with task routes**
```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TaskService } from '../services/TaskService.js';
import { requireAuth } from '../middleware/firebaseAuth.js';

export async function taskRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/tasks', { preHandler: [requireAuth] }, async (request, reply) => {
    // Moved from src/index.ts
  });

  fastify.get('/tasks/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    // Moved from src/index.ts
  });

  // ... all task routes
}
```

**Step 3: Register in src/index.ts**
```typescript
// In src/index.ts — replace inline route definitions with:
import { taskRoutes } from './routes/tasks.js';
import { escrowRoutes } from './routes/escrow.js';
import { userRoutes } from './routes/users.js';
import { aiRoutes } from './routes/ai.js';
import { stripeRoutes } from './routes/stripe.js';
import { adminRoutes } from './routes/admin.js';

await fastify.register(taskRoutes, { prefix: '/api' });
await fastify.register(escrowRoutes, { prefix: '/api' });
await fastify.register(userRoutes, { prefix: '/api' });
await fastify.register(aiRoutes, { prefix: '/api' });
await fastify.register(stripeRoutes, { prefix: '/api' });
await fastify.register(adminRoutes, { prefix: '/admin' });
```

**Step 4: Verify line count reduction**
```bash
wc -l src/index.ts
# Target: < 300 lines
wc -l src/routes/*.ts
# Each file: < 400 lines
```

**Step 5: Run all tests to verify nothing broke**
```bash
npx vitest run --reporter=verbose
# Expected: all pass
npx tsc --noEmit
# Expected: 0 errors
```

**Step 6: Commit**
```bash
git add src/
git commit -m "refactor: decompose 4584-line src/index.ts into route modules by domain"
```

---

## Phase 3 — ESLint Zero Warnings

### Task 12: Run ESLint and fix all warnings

**Step 1: Run ESLint and capture output**
```bash
npx eslint src/ --ext .ts --max-warnings 0 2>&1 | tee /tmp/eslint-output.txt
wc -l /tmp/eslint-output.txt
```

**Step 2: Auto-fix what can be fixed**
```bash
npx eslint src/ --ext .ts --fix
```

**Step 3: Manually fix remaining warnings**

Common patterns to fix:
```typescript
// Unused variables — prefix with _
const _unused = something; // or remove entirely

// Prefer const over let
const value = compute(); // not let

// No console.log — replace with logger
logger.info('...'); // not console.log('...')

// Explicit return types on exported functions
export async function doThing(input: string): Promise<Result> { ... }
```

**Step 4: Verify zero warnings**
```bash
npx eslint src/ --ext .ts --max-warnings 0
# Expected: exits 0, no output
```

**Step 5: Commit**
```bash
git add src/
git commit -m "fix(lint): resolve all ESLint warnings — zero warnings enforced"
```

---

## Phase 4 — Test Completeness

### Task 13: Run all existing tests and fix failures

**Step 1: Run all tests**
```bash
npx vitest run --reporter=verbose 2>&1 | tee /tmp/test-output.txt
grep -E "FAIL|PASS|Error" /tmp/test-output.txt | tail -30
```

**Step 2: Fix any failing tests**

For each failing test:
1. Read the test to understand what it's asserting
2. Determine if the test is wrong (implementation changed) or the code is wrong
3. Fix the code (preferred) or update the test with a comment explaining the change

**Step 3: Add missing integration tests for the 5 risk fixes**

Verify tests exist for:
```bash
grep -rn "stripe webhook\|idempotency\|escrow.*xp\|auth.*revok\|ai.*degraded" tests/ --include="*.test.ts" -l
# Each risk should have at least one test file
```

**Step 4: Add a spec-alignment test**

Create `tests/spec-alignment.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';

describe('API surface alignment', () => {
  it('health endpoint responds 200', async () => {
    // Sanity check that server starts and health route works
    const response = await fetch('http://localhost:3000/health');
    expect(response.status).toBe(200);
  });

  it('unauthenticated request to protected route returns 401', async () => {
    const response = await fetch('http://localhost:3000/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'test' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(401);
  });
});
```

**Step 5: Run all tests — all must pass**
```bash
npx vitest run --reporter=verbose
# Expected: 0 failures
```

**Step 6: Commit**
```bash
git add tests/
git commit -m "test: fix all failing tests and add spec-alignment integration tests"
```

---

## Phase 5 — CI Hardening

### Task 14: Update ci.yml to target src/ not just backend/src/

The current `ci.yml` runs `eslint backend/src` — but the active code is in `src/`. Fix it to cover both.

**Files:**
- Modify: `.github/workflows/ci.yml`

**Step 1: Update the lint command**
```yaml
# BEFORE:
- run: npx eslint backend/src --ext .ts --max-warnings 0

# AFTER:
- run: npx eslint src/ backend/src/ --ext .ts --max-warnings 0 --ignore-pattern "**/*.test.ts"
  name: Lint (zero warnings required — src/ and backend/src/)
```

**Step 2: Update the test command to include src/ tests**
```yaml
# BEFORE:
- run: npx vitest run backend/tests/unit/ backend/tests/invariants/...

# AFTER:
- run: npx vitest run --reporter=verbose
  name: Run all tests (zero failures required)
```

**Step 3: Add the typecheck to cover src/**

Verify `tsconfig.json` includes both `src/` and `backend/src/`:
```json
{
  "include": [
    "src/**/*",
    "backend/src/**/*"
  ]
}
```

**Step 4: Commit**
```bash
git add .github/workflows/ci.yml tsconfig.json
git commit -m "ci: update CI to cover src/ and backend/src/ — enforce zero warnings and zero test failures"
```

---

## Phase 6 — Final Verification

### Task 15: Full green verification pass

**Step 1: TypeScript — zero errors**
```bash
npx tsc --noEmit
# Expected: exits 0, zero output
```

**Step 2: ESLint — zero warnings**
```bash
npx eslint src/ backend/src/ --ext .ts --max-warnings 0
# Expected: exits 0, zero output
```

**Step 3: Tests — all pass**
```bash
npx vitest run --reporter=verbose
# Expected: all green, 0 failures
```

**Step 4: Dependency audit — no high/critical**
```bash
npm audit --audit-level=high
# Expected: 0 high or critical vulnerabilities
```

**Step 5: Zero any types in production code**
```bash
grep -rn ": any\|as any\| any>" src/ --include="*.ts" | grep -v "\.test\." | grep -v "// intentional"
# Expected: 0 lines
```

**Step 6: Push and verify CI**
```bash
git push
# Open GitHub Actions — ci.yml must be fully green
```

**Step 7: Final commit**
```bash
git add -A
git commit -m "chore: final verification pass — zero errors, zero warnings, all tests green"
git push
```

---

## Completion Checklist

- [ ] All Citadel/autonomous workflows deleted
- [ ] `npx tsc --noEmit` → exits 0, zero output
- [ ] `npx eslint src/ backend/src/ --ext .ts --max-warnings 0` → exits 0
- [ ] `npx vitest run` → all tests pass, 0 failures
- [ ] `npm audit --audit-level=high` → 0 high/critical
- [ ] Zero `: any` or `as any` in production `src/` files
- [ ] `src/index.ts` is < 300 lines (routes extracted)
- [ ] Stripe webhook uses `ON CONFLICT DO NOTHING`
- [ ] Auth cache TTL is 5 minutes
- [ ] Escrow release + XP award in single transaction
- [ ] AI degraded mode implemented + `/health/ai` endpoint
- [ ] CI passing green on GitHub
