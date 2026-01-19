# Alpha Instrumentation Integration Guide

This document describes how to integrate Alpha Instrumentation telemetry events into the codebase.

## Event Groups

### Layer 1: Edge State Telemetry (Client-Side)
- **Event**: `edge_state_impression` - Fire once per session per state
- **Event**: `edge_state_exit` - Fire when user leaves the screen
- **Location**: Frontend edge state screens (E1, E2, E3)
- **Implementation**: Client calls `trpc.alphaTelemetry.emitEdgeStateImpression` / `emitEdgeStateExit`

### Layer 2: Dispute Path Pressure Tests
- **Event**: `dispute_entry_attempt` - Fire before dispute submission
- **Event**: `dispute_submission_result` - Fire after dispute guard validation
- **Location**: `backend/src/services/DisputeService.ts`
- **Implementation**: Add calls to `AlphaInstrumentation.emitDisputeEntryAttempt` / `emitDisputeSubmissionResult`

### Layer 3: Proof Loop Instrumentation
- **Event**: `proof_submission` - Fire on every proof submission attempt
- **Event**: `proof_correction_outcome` - Fire after proof correction resolution
- **Location**: Proof submission handlers (TBD - proof system location)
- **Implementation**: Add calls to `AlphaInstrumentation.emitProofSubmission` / `emitProofCorrectionOutcome`

### Layer 4: Trust Change Auditability
- **Event**: `trust_delta_applied` - Fire on every trust update
- **Location**: 
  - `backend/src/services/XPService.ts` - XP awards
  - `backend/src/services/TrustTierService.ts` - Tier promotions/bans
- **Implementation**: Add calls to `AlphaInstrumentation.emitTrustDeltaApplied`

## Integration Points

### TrustTierService.ts

Add instrumentation in `applyPromotion` and `banUser`:

```typescript
import { AlphaInstrumentation } from '../services/AlphaInstrumentation';

// In applyPromotion, after promotion is applied:
await AlphaInstrumentation.emitTrustDeltaApplied({
  user_id: userId,
  role: 'hustler', // TODO: determine role from user context
  delta_type: 'tier',
  delta_amount: newTier - oldTier,
  reason_code: `promotion_${TrustTier[newTier]}`,
  task_id: undefined, // Not task-specific
  timestamp: new Date(),
});

// In banUser:
await AlphaInstrumentation.emitTrustDeltaApplied({
  user_id: userId,
  role: 'hustler', // TODO: determine role
  delta_type: 'tier',
  delta_amount: -999, // Special value for ban
  reason_code: `ban_${reason}`,
  task_id: undefined,
  timestamp: new Date(),
});
```

### XPService.ts

Add instrumentation in `awardXP` after XP is awarded:

```typescript
import { AlphaInstrumentation } from '../services/AlphaInstrumentation';

// After XP ledger entry is inserted:
await AlphaInstrumentation.emitTrustDeltaApplied({
  user_id: userId,
  role: 'hustler', // TODO: determine role
  delta_type: 'xp',
  delta_amount: effectiveXP,
  reason_code: 'task_completion',
  task_id: taskId,
  timestamp: new Date(),
});

// If streak changes, emit separate streak delta:
if (newStreak !== user.current_streak) {
  await AlphaInstrumentation.emitTrustDeltaApplied({
    user_id: userId,
    role: 'hustler',
    delta_type: 'streak',
    delta_amount: newStreak - user.current_streak,
    reason_code: 'task_completion',
    task_id: taskId,
    timestamp: new Date(),
  });
}
```

### DisputeService.ts

Add instrumentation in dispute creation and submission handlers:

```typescript
import { AlphaInstrumentation } from '../services/AlphaInstrumentation';

// Before dispute submission (in createDispute or similar):
await AlphaInstrumentation.emitDisputeEntryAttempt({
  user_id: userId,
  role: 'poster', // or 'hustler'
  task_id: taskId,
  trigger_state: task.state === 'COMPLETED' ? 'APPROVED' : 'BLOCKED',
  time_since_completion_seconds: Math.floor((Date.now() - task.completed_at.getTime()) / 1000),
  reason_selected: disputeReason,
  timestamp: new Date(),
});

// After dispute guard validation (in submitDispute or similar):
await AlphaInstrumentation.emitDisputeSubmissionResult({
  user_id: userId,
  role: 'poster',
  task_id: taskId,
  submitted: true,
  rejected_by_guard: false,
  cooldown_hit: false,
  timestamp: new Date(),
});
```

## Frontend Integration (TODO)

Edge state screens need to call tRPC endpoints:

```typescript
// In E1, E2, E3 screens:

// On mount:
await trpc.alphaTelemetry.emitEdgeStateImpression.mutate({
  user_id: user.id,
  role: userRole,
  state: 'E1_NO_TASKS_AVAILABLE', // or E2, E3
  trust_tier: user.trust_tier,
  location_radius_miles: user.location_radius,
  instant_mode_enabled: user.instant_mode_enabled,
  timestamp: new Date(),
});

// On unmount or exit:
await trpc.alphaTelemetry.emitEdgeStateExit.mutate({
  user_id: user.id,
  role: userRole,
  state: 'E1_NO_TASKS_AVAILABLE',
  time_on_screen_ms: Date.now() - screenStartTime,
  exit_type: 'continue', // or 'back', 'app_background', 'session_end'
  timestamp: new Date(),
});
```

## Database Migration

Run the migration to create the `alpha_telemetry` table:

```bash
npm run db:migrate -- add_alpha_telemetry_table.sql
```

Or apply directly:

```bash
psql $DATABASE_URL -f backend/database/migrations/add_alpha_telemetry_table.sql
```

## Testing

Instrumentation events should **never fail** core flow. All `AlphaInstrumentation` methods are wrapped in try-catch with silent failures.

To verify instrumentation:

```sql
-- Check event counts by group
SELECT event_group, COUNT(*) as count
FROM alpha_telemetry
GROUP BY event_group
ORDER BY count DESC;

-- Check edge state distribution
SELECT state, COUNT(*) as impressions
FROM alpha_telemetry
WHERE event_group = 'edge_state_impression'
GROUP BY state;
```

## Next Steps

1. ✅ Create `alpha_telemetry` table migration
2. ✅ Create `AlphaInstrumentation` service
3. ✅ Create `alphaTelemetry` tRPC router
4. ⏳ Integrate into `TrustTierService.applyPromotion`
5. ⏳ Integrate into `TrustTierService.banUser`
6. ⏳ Integrate into `XPService.awardXP`
7. ⏳ Integrate into `DisputeService` (when dispute system is implemented)
8. ⏳ Create frontend tRPC mutations for edge state events
9. ⏳ Integrate into edge state screens (E1, E2, E3)
