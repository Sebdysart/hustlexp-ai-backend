# iOS tRPC Integration Guide

> **Status**: ✅ API Layer Complete - Ready for iOS Integration

## Overview

The HustleXP backend uses **tRPC** (TypeScript RPC) for type-safe API communication. The iOS app will need to use a tRPC client to interact with the backend.

## Backend URL

```
https://hustlexp-ai-backend-production.up.railway.app
```

## tRPC Endpoint

The tRPC server is exposed at:
```
/trpc/*
```

Full URL: `https://hustlexp-ai-backend-production.up.railway.app/trpc/*`

---

## Available Routers

### 1. Task Router (`task.*`)

**Endpoints**:
- `task.getById` - Get task by ID
- `task.listByPoster` - List tasks by poster
- `task.listByWorker` - List tasks by worker
- `task.listOpen` - List open tasks (feed)
- `task.create` - Create a new task
- `task.accept` - Accept a task (worker claims it)
- `task.complete` - Complete a task
- `task.cancel` - Cancel a task

**Example** (TypeScript):
```typescript
// Create task
const task = await trpc.task.create.mutate({
  title: "Help moving furniture",
  description: "Need help moving a couch",
  price: 50.00,
  category: "moving",
  location: { latitude: 47.6062, longitude: -122.3321 },
  mode: "standard", // or "live"
});

// List open tasks
const tasks = await trpc.task.listOpen.query({
  limit: 20,
  offset: 0,
});
```

### 2. Escrow Router (`escrow.*`)

**Endpoints**:
- `escrow.getById` - Get escrow by ID
- `escrow.getByTaskId` - Get escrow by task ID
- `escrow.release` - Release escrow (payout to worker)

**Example**:
```typescript
// Get escrow for a task
const escrow = await trpc.escrow.getByTaskId.query({
  taskId: "task-uuid",
});

// Release escrow (poster approves)
await trpc.escrow.release.mutate({
  escrowId: "escrow-uuid",
  posterId: "user-uuid",
});
```

### 3. User Router (`user.*`)

**Endpoints**:
- `user.getProfile` - Get user profile
- `user.updateProfile` - Update user profile
- `user.getStats` - Get user statistics (XP, level, streak, etc.)

**Example**:
```typescript
// Get user profile
const profile = await trpc.user.getProfile.query({
  userId: "user-uuid",
});

// Get user stats
const stats = await trpc.user.getStats.query({
  userId: "user-uuid",
});
```

### 4. AI Router (`ai.*`)

**Endpoints**:
- `ai.submitCalibration` - Submit calibration prompt for role inference
- `ai.getInferenceResult` - Get AI inference result
- `ai.confirmRole` - Confirm role and complete onboarding

**Example**:
```typescript
// Submit calibration (onboarding)
await trpc.ai.submitCalibration.mutate({
  calibrationPrompt: "I want to earn money by doing tasks",
  onboardingVersion: "1.0.0",
});

// Get inference result
const inference = await trpc.ai.getInferenceResult.query();

// Confirm role
await trpc.ai.confirmRole.mutate({
  confirmedMode: "worker", // or "poster"
  overrideAI: false,
});
```

### 5. Live Router (`live.*`)

**Endpoints**:
- `live.toggle` - Toggle Live Mode on/off
- `live.getStatus` - Get Live Mode status
- `live.listBroadcasts` - List active Live Mode broadcasts

**Example**:
```typescript
// Toggle Live Mode
await trpc.live.toggle.mutate({
  enabled: true,
});

// Get Live Mode status
const status = await trpc.live.getStatus.query();

// List broadcasts near location
const broadcasts = await trpc.live.listBroadcasts.query({
  latitude: 47.6062,
  longitude: -122.3321,
  radiusMiles: 5,
});
```

### 6. Health Router (`health.*`)

**Endpoints**:
- `health.ping` - Basic health check
- `health.status` - Full system health check

**Example**:
```typescript
// Health check
const health = await trpc.health.ping.query();
// Returns: { status: 'ok', timestamp: '...' }
```

---

## iOS Integration Options

### Option 1: Use tRPC Swift Client (Recommended)

tRPC has official Swift support. You'll need to:

1. **Generate TypeScript types** from the backend
2. **Use tRPC Swift client** to make type-safe calls

**Setup**:
```swift
import TRPC

// Initialize client
let client = TRPCClient(
  baseURL: URL(string: "https://hustlexp-ai-backend-production.up.railway.app/trpc")!,
  headers: [
    "Authorization": "Bearer \(firebaseToken)"
  ]
)

// Make a call
let tasks = try await client.task.listOpen.query(
  input: ListOpenInput(limit: 20, offset: 0)
)
```

### Option 2: REST Adapter (If tRPC Swift not available)

If tRPC Swift client is not available, you can create a REST adapter layer that converts REST calls to tRPC format.

**Note**: The backend currently exposes tRPC at `/trpc/*`. You may need to:
- Use HTTP POST to `/trpc/task.listOpen` with JSON body
- Or create a REST adapter in the backend

### Option 3: Use Existing REST Endpoints

The backend also has REST endpoints at `/api/*` (see `docs/FRONTEND_INTEGRATION.md`). However, the new constitutional schema uses tRPC, so you should use tRPC for new features.

---

## Authentication

All tRPC procedures use `protectedProcedure`, which requires Firebase authentication.

**Headers**:
```
Authorization: Bearer <firebase-id-token>
```

The backend verifies the Firebase token and extracts the user ID from it.

---

## Error Handling

tRPC errors follow this structure:
```json
{
  "error": {
    "code": "BAD_REQUEST" | "NOT_FOUND" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR",
    "message": "Human-readable error message",
    "data": {
      "code": "HX001", // HustleXP error code (if applicable)
      "httpStatus": 400
    }
  }
}
```

**HX Error Codes** (from constitutional schema):
- `HX001` - Task terminal state violation
- `HX002` - Escrow terminal state violation
- `HX101` - XP requires RELEASED escrow (INV-1)
- `HX201` - RELEASED requires COMPLETED task (INV-2)
- `HX301` - COMPLETED requires ACCEPTED proof (INV-3)
- `HX901` - Live broadcast without funded escrow
- `HX902` - Live task below price floor ($15.00)
- `HX904` - Live Mode toggle cooldown violation
- `HX905` - Live Mode banned

---

## Type Safety

The backend uses Zod schemas for validation. The iOS app should:

1. **Generate types** from the backend schema
2. **Validate inputs** before sending
3. **Handle type errors** gracefully

---

## Testing

Test the tRPC endpoints:

```bash
# Health check
curl https://hustlexp-ai-backend-production.up.railway.app/health

# tRPC call (example - requires auth)
curl -X POST https://hustlexp-ai-backend-production.up.railway.app/trpc/health.ping \
  -H "Content-Type: application/json"
```

---

## Migration from REST

If you're currently using REST endpoints from `docs/FRONTEND_INTEGRATION.md`, you can:

1. **Gradually migrate** to tRPC for new features
2. **Keep REST** for existing features until migration complete
3. **Use both** during transition period

---

## Next Steps

1. ✅ Backend API Layer complete
2. ⏳ Apply constitutional schema to database
3. ⏳ Set up tRPC Swift client in iOS app
4. ⏳ Test endpoints with iOS app
5. ⏳ Complete remaining backend phases (4, 5, 7-9)

---

## References

- `backend/src/routers/` - Router implementations
- `backend/src/trpc.ts` - tRPC setup and context
- `backend/src/server.ts` - Server configuration
- `docs/FRONTEND_INTEGRATION.md` - REST API reference (legacy)
- `AGENT_COORDINATION.md` - Agent coordination tracking
