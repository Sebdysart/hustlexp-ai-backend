# Instant Execution Mode v1 - Status Report

## Implementation Status

### ✅ Instrumentation: DONE
- `matched_at` column added to tasks table
- `matched_at` set immediately on instant task creation
- Time-to-accept calculation: `accepted_at - matched_at`
- Metrics endpoint: `instant.metrics` (returns median, p90, min, max)

### ✅ Manual Accept Path: DONE
- Endpoint: `instant.listAvailable` - lists instant tasks in MATCHING state
- Endpoint: `instant.accept` - one-tap accept with time-to-accept calculation
- Endpoint: `instant.metrics` - returns statistics

### ⏳ Median Time-to-Accept: NOT MEASURED
- No test runs completed yet
- Requires: Create 5 instant tasks, accept them, check metrics

### ⏳ p90 Time-to-Accept: NOT MEASURED
- No test runs completed yet

---

## What's Live

**Backend:**
- Task creation with `instantMode: true` sets `state = 'MATCHING'` and `matched_at = NOW()`
- Accept endpoint enforces first-accept-wins at DB level
- Metrics endpoint calculates median/p90 from accepted tasks

**API Endpoints:**
- `trpc.instant.listAvailable` - Get available instant tasks
- `trpc.instant.accept` - Accept instant task (one-tap)
- `trpc.instant.metrics` - Get time-to-accept statistics

---

## Next: Test Flow

1. Create 5 instant tasks via `task.create` with `instantMode: true`
2. Accept each via `instant.accept`
3. Check metrics via `instant.metrics`
4. Report median and p90

---

## Current Status

**Instrumentation:** DONE  
**Manual Accept Path:** DONE  
**Median Time-to-Accept:** NOT MEASURED  
**p90 Time-to-Accept:** NOT MEASURED
