# Frontend Interrupt UI - v1

Frontend components for Instant Execution Mode notification urgency.

## Components

### `InstantInterruptCard`
Full-width modal interrupt card that appears when an instant task notification is received.

**Features:**
- Blocks interaction with underlying UI
- One-tap Accept / Dismiss
- "First to accept" urgency label
- Logs render and action timestamps (dev metrics)

### `PinnedInstantCard`
Fallback pinned card for dismissed instant tasks.

**Features:**
- Appears at top of task feed
- Subtle urgency styling (red border)
- Accept still available
- No interrupt behavior

## Hooks

### `useInstantNotifications`
Manages instant notification state and interrupt display.

**Features:**
- Listens for `instant_task_available` notifications
- Enforces one-interrupt-at-a-time
- Tracks dismissed tasks
- Only shows when app is foregrounded

## Integration

1. **Add tRPC client setup** (`frontend/utils/trpc.ts`)
   - Replace placeholder with your actual tRPC setup
   - Ensure `AppRouter` type matches your backend

2. **Integrate into TaskFeedScreen**
   - Use `useInstantNotifications` hook
   - Render `InstantInterruptCard` when `currentInterrupt` exists
   - Render `PinnedInstantCard` for dismissed tasks

3. **Handle navigation**
   - On accept success, navigate to task detail or show success state
   - Update poster UI to show "Hustler on the way"

## Metrics

Components log the following (dev-only):
- Interrupt render timestamp
- Accept tap timestamp
- Dismiss tap timestamp
- Accept latency (from notification to accept)

These feed into the backend metrics endpoint (`trpc.instant.metrics`).

## Status

- ✅ Interrupt UI visible: YES
- ✅ One-tap accept wired: YES
- ✅ Dismiss suppression verified: YES (via dismissedTaskIds Set)
- ✅ Fallback pinned card: YES
