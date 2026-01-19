# Phase N2.1 — Read-Only Backend Handlers Checklist

**Date:** 2025-01-17  
**Status:** READY FOR IMPLEMENTATION  
**Priority:** CRITICAL (must complete before N2.2)

---

## Executive Summary

Implement **read-only backend handlers** for Phase N2.1. Zero side effects. No writes. No verification submission. All handlers must enforce authority boundaries already locked.

---

## Pre-Flight (BLOCKING)

### Required Before Implementation

- [ ] Commit `NAVIGATION_ARCHITECTURE.md` to **HUSTLEXP-DOCS** repository
- [ ] Update `EXECUTION_TODO.md` → Mark Phase N1 as COMPLETE
- [ ] Freeze navigation (no new routes during N2)

**Done Criteria:** Docs pushed and referenced. No code yet.

---

## N2.1 — Read-Only Handlers (Zero Side Effects)

### Rule: NO POST, NO PATCH, NO OPTIMISTIC UI

All handlers in Phase N2.1 are **read-only queries**. No mutations. No writes. No side effects.

---

## Handler 1: Eligibility Snapshot

### Endpoint
- **tRPC Route:** `capability.getProfile` (NEW - needs creation)
- **Purpose:** Source of truth for eligibility status

### Returns
```typescript
{
  trustTier: TrustTier; // 'A' | 'B' | 'C' | 'D' | 'E'
  riskClearance: RiskLevel[]; // ['low'] | ['low', 'medium'] | etc.
  verifiedTrades: string[]; // ['electrician'] | []
  insuranceValid: boolean;
  backgroundCheckValid: boolean;
  locationState: string; // 'WA'
  locationCity?: string; // 'Seattle'
  expiryFlags: {
    licenses: Array<{ trade: string; expiresAt: string }>;
    insurance: string | null;
  };
}
```

### Authority
- **Source:** `capability_profiles` table (derived, recomputed)
- **Never:** Modifies capability profile (read-only)
- **Never:** Computes eligibility (backend already computed)

### Usage
- **Settings → Work Eligibility Screen:** Displays verification status
- **Task Feed:** Backend uses for feed filtering (not frontend)

### Implementation
- [ ] Create tRPC procedure `capability.getProfile`
- [ ] Query `capability_profiles` table by `user_id`
- [ ] Return read-only capability profile
- [ ] Type response strictly from schema

---

## Handler 2: Feed Query

### Endpoint
- **tRPC Route:** `tasks.list` (EXISTS - may need enhancement for eligibility filtering)
- **Purpose:** Task feed with backend eligibility enforcement

### Returns
```typescript
{
  tasks: Array<{
    id: string;
    title: string;
    category: TaskCategory;
    location: string;
    payout: number;
    timePosted: string;
    scheduledTime?: string;
  }>;
  cursor: string | null; // For cursor-based pagination
}
```

### Authority (CRITICAL)
- **Backend JOIN:** Feed query performs eligibility JOIN server-side
- **Frontend Trust:** UI assumes ALL returned tasks are eligible
- **Never:** Client-side eligibility filtering
- **Never:** Disabled buttons or eligibility warnings

### Implementation
- [ ] Verify `tasks.list` performs eligibility JOIN
- [ ] Ensure feed query uses `capability_profiles` for filtering
- [ ] Add cursor-based pagination if missing
- [ ] Type response strictly from schema

### Feed Query Logic (Backend)
```sql
SELECT tasks.* 
FROM tasks
JOIN capability_profiles cp ON cp.user_id = :currentUser
WHERE cp.verified_trades CONTAINS tasks.required_trade
  AND cp.trust_tier >= tasks.required_trust_tier
  AND (tasks.insurance_required = false OR cp.insurance_valid = true)
  AND tasks.status = 'OPEN'
ORDER BY tasks.created_at DESC
LIMIT :limit
OFFSET :offset
```

---

## Handler 3: Task History

### Endpoint
- **tRPC Route:** `tasks.listHistory` (NEW - needs creation)
- **Purpose:** Past tasks only (COMPLETED, CANCELLED, EXPIRED)

### Returns
```typescript
{
  tasks: Array<{
    id: string;
    title: string;
    price: number; // in cents
    location: string;
    status: 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
    resolvedAt: string; // ISO 8601
  }>;
}
```

### Authority
- **Scope:** ONLY past/resolved tasks
- **Never:** Queries available tasks (TaskFeedScreen is canonical)
- **Never:** Shares feed query logic
- **Never:** Shows eligibility-gated content

### Implementation
- [ ] Create tRPC procedure `tasks.listHistory`
- [ ] Query tasks with status IN ('COMPLETED', 'CANCELLED', 'EXPIRED')
- [ ] Filter by `user_id` (hustler tasks only)
- [ ] Type response strictly from schema

---

## Handler 4: Task Execution State

### Endpoint
- **tRPC Route:** `tasks.getState` (EXISTS or needs creation)
- **Purpose:** Task state for task-state-gated routes (maps, in-progress, completion)

### Returns
```typescript
{
  taskId: string;
  status: 'ACCEPTED' | 'EN_ROUTE' | 'WORKING' | 'COMPLETED';
  acceptedAt?: string; // ISO 8601
  enRouteAt?: string; // ISO 8601
  workingAt?: string; // ISO 8601
  completedAt?: string; // ISO 8601
}
```

### Authority
- **Usage:** Gates map screens and execution screens
- **Guards:** `isTaskEnRoute(state)`, `hasActiveTask(state)`, etc.
- **Never:** Modifies task state (N2.1 is read-only)

### Implementation
- [ ] Verify `tasks.getState` exists or create it
- [ ] Query `tasks` table for `task_id` and `status`
- [ ] Return task state transitions (timestamps)
- [ ] Type response strictly from schema

---

## Implementation Checklist

### Phase N2.1.1: Eligibility Snapshot Handler

- [ ] Create `backend/trpc/routes/capability/getProfile/route.ts`
- [ ] Implement `capability.getProfile` tRPC procedure
- [ ] Query `capability_profiles` table
- [ ] Type response from schema
- [ ] Add to `app-router.ts`
- [ ] Test with mock data

### Phase N2.1.2: Feed Query Handler

- [ ] Review existing `tasks.list` tRPC procedure
- [ ] Verify eligibility JOIN is performed server-side
- [ ] Add cursor-based pagination if missing
- [ ] Type response strictly
- [ ] Test feed returns only eligible tasks

### Phase N2.1.3: Task History Handler

- [ ] Create `backend/trpc/routes/tasks/listHistory/route.ts`
- [ ] Implement `tasks.listHistory` tRPC procedure
- [ ] Query past tasks only (COMPLETED, CANCELLED, EXPIRED)
- [ ] Type response strictly
- [ ] Add to `app-router.ts`
- [ ] Test with mock data

### Phase N2.1.4: Task State Handler

- [ ] Review existing `tasks.getState` or create it
- [ ] Implement `tasks.getState` tRPC procedure
- [ ] Query task status and transitions
- [ ] Type response strictly
- [ ] Test with mock data

### Phase N2.1.5: Frontend Integration

- [ ] Create `hustlexp-app/services/api/capability.ts`
- [ ] Create `hustlexp-app/services/api/tasks.ts`
- [ ] Wire tRPC client calls
- [ ] Replace mock data with real API calls in screens
- [ ] Verify no side effects (read-only)

---

## tRPC Client Setup (Frontend)

### Required Setup

```typescript
// hustlexp-app/services/api/client.ts
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../../../backend/trpc/app-router';

const API_URL = 'https://hustlexp-ai-backend-production.up.railway.app';

export const trpc = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${API_URL}/trpc`,
    }),
  ],
});
```

### Usage Example

```typescript
// Read capability profile
const profile = await trpc.capability.getProfile.query();

// Read task feed
const feed = await trpc.tasks.list.query({ limit: 20, offset: 0 });

// Read task history
const history = await trpc.tasks.listHistory.query();

// Read task state
const taskState = await trpc.tasks.getState.query({ taskId: 'task-uuid' });
```

---

## Authority Validation

### For Each Handler, Verify:

- [ ] Handler is read-only (NO POST, NO PATCH)
- [ ] Response types match schema exactly
- [ ] No client-side eligibility checks
- [ ] No optimistic UI
- [ ] No side effects

### Feed Query Specifically:

- [ ] Backend performs eligibility JOIN
- [ ] Frontend trusts all returned tasks are eligible
- [ ] No disabled buttons or eligibility warnings
- [ ] No client-side filtering

### Task History Specifically:

- [ ] Queries ONLY past tasks (COMPLETED, CANCELLED, EXPIRED)
- [ ] Does NOT query available tasks
- [ ] Does NOT share feed query logic

---

## Testing Checklist

### Phase N2.1 Testing

- [ ] Eligibility Snapshot: Returns capability profile correctly
- [ ] Feed Query: Returns only eligible tasks (backend filtered)
- [ ] Task History: Returns only past tasks
- [ ] Task State: Returns task status correctly
- [ ] All handlers are read-only (no writes observed)
- [ ] All handlers typed strictly from schema

---

## Done Criteria (Phase N2.1 Complete)

Phase N2.1 is complete when:

- [ ] All 4 read-only handlers implemented
- [ ] Frontend integrated with tRPC client
- [ ] UI renders real data (replaces mock data)
- [ ] Zero writes observed (all handlers are queries)
- [ ] Feed is fully backend-driven (eligibility JOIN server-side)
- [ ] Task History queries only past tasks
- [ ] No client-side eligibility checks anywhere

---

**Status:** READY FOR IMPLEMENTATION  
**Next Phase:** N2.2 — Execution-Critical Writes (after N2.1 completes)
