# Step 2: Frontend Edge State Wiring — Integration Plan

## Current State

- ✅ Backend telemetry infrastructure exists (`AlphaInstrumentation` service)
- ✅ `alpha_telemetry` table exists and ready
- ❌ E1/E2/E3 React screen components do NOT exist yet (only Stitch prompts)
- ❌ `alphaTelemetryRouter` only has query endpoints (no mutations)
- ✅ Frontend tRPC client is set up (`frontend/utils/trpc.ts`)

## Integration Plan

### Phase 1: Add tRPC Mutations (Backend)

**File**: `backend/src/routers/alpha-telemetry.ts`

Add two mutation endpoints:

```typescript
emitEdgeStateImpression: protectedProcedure
  .input(z.object({
    state: z.enum(['E1_NO_TASKS_AVAILABLE', 'E2_ELIGIBILITY_MISMATCH', 'E3_TRUST_TIER_LOCKED']),
    role: z.enum(['hustler', 'poster']),
    trust_tier: z.number(),
    location_radius_miles: z.number().optional(),
    instant_mode_enabled: z.boolean(),
  }))
  .mutation(async ({ input, ctx }) => {
    await AlphaInstrumentation.emitEdgeStateImpression({
      user_id: ctx.user.id,
      role: input.role,
      state: input.state,
      trust_tier: input.trust_tier,
      location_radius_miles: input.location_radius_miles,
      instant_mode_enabled: input.instant_mode_enabled,
      timestamp: new Date(),
    });
    return { success: true };
  }),

emitEdgeStateExit: protectedProcedure
  .input(z.object({
    state: z.enum(['E1_NO_TASKS_AVAILABLE', 'E2_ELIGIBILITY_MISMATCH', 'E3_TRUST_TIER_LOCKED']),
    role: z.enum(['hustler', 'poster']),
    time_on_screen_ms: z.number(),
    exit_type: z.enum(['continue', 'back', 'app_background', 'session_end']),
  }))
  .mutation(async ({ input, ctx }) => {
    await AlphaInstrumentation.emitEdgeStateExit({
      user_id: ctx.user.id,
      role: input.role,
      state: input.state,
      time_on_screen_ms: input.time_on_screen_ms,
      exit_type: input.exit_type,
      timestamp: new Date(),
    });
    return { success: true };
  }),
```

---

### Phase 2: Create React Hook for Edge State Telemetry

**File**: `frontend/hooks/useEdgeStateTelemetry.ts`

```typescript
import { useEffect, useRef } from 'react';
import { trpc } from '../utils/trpc';
import type { EdgeStateType, ExitType, UserRole } from '../types';

interface EdgeStateContext {
  role: UserRole;
  trust_tier: number;
  location_radius_miles?: number;
  instant_mode_enabled: boolean;
}

export function useEdgeStateTelemetry(
  state: EdgeStateType,
  context: EdgeStateContext
) {
  const impressionMutation = trpc.alphaTelemetry.emitEdgeStateImpression.useMutation();
  const exitMutation = trpc.alphaTelemetry.emitEdgeStateExit.useMutation();
  
  const impressionFiredRef = useRef(false);
  const screenStartTimeRef = useRef<number | null>(null);

  // Fire impression once on mount (when screen becomes primary visible)
  useEffect(() => {
    if (!impressionFiredRef.current) {
      screenStartTimeRef.current = Date.now();
      impressionFiredRef.current = true;
      
      impressionMutation.mutate({
        state,
        role: context.role,
        trust_tier: context.trust_tier,
        location_radius_miles: context.location_radius_miles,
        instant_mode_enabled: context.instant_mode_enabled,
      });
    }
  }, [state]); // Only fire once per state change

  // Return exit handler
  const emitExit = (exitType: ExitType) => {
    if (screenStartTimeRef.current !== null) {
      const durationMs = Date.now() - screenStartTimeRef.current;
      
      exitMutation.mutate({
        state,
        role: context.role,
        time_on_screen_ms: durationMs,
        exit_type: exitType,
      });
    }
  };

  return { emitExit };
}
```

---

### Phase 3: Create Edge State Screen Components

**Files to create**:

1. `frontend/screens/EdgeStateE1NoTasksAvailable.tsx` (E1)
2. `frontend/screens/EdgeStateE2EligibilityMismatch.tsx` (E2)
3. `frontend/screens/EdgeStateE3TrustTierLocked.tsx` (E3)

**Integration Pattern** (example for E1):

```typescript
import React, { useEffect } from 'react';
import { View, Text, Button, StyleSheet } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useEdgeStateTelemetry } from '../hooks/useEdgeStateTelemetry';
import { trpc } from '../utils/trpc';

export const EdgeStateE1NoTasksAvailable: React.FC = () => {
  const navigation = useNavigation();
  const { data: user } = trpc.user.getCurrent.useQuery();

  // Wire telemetry
  const { emitExit } = useEdgeStateTelemetry('E1_NO_TASKS_AVAILABLE', {
    role: user?.default_mode === 'poster' ? 'poster' : 'hustler',
    trust_tier: user?.trust_tier || 0,
    location_radius_miles: user?.location_radius,
    instant_mode_enabled: user?.instant_mode_enabled || false,
  });

  // Handle navigation exit
  useFocusEffect(
    React.useCallback(() => {
      return () => {
        // Screen is unfocused (user navigated away)
        emitExit('back');
      };
    }, [emitExit])
  );

  // Handle app background (via AppState listener - not shown here)

  return (
    <View style={styles.container}>
      {/* Screen content from Stitch prompt */}
      <Text>No Tasks Available</Text>
      <Button
        title="Return to Dashboard"
        onPress={() => {
          emitExit('continue');
          navigation.navigate('Dashboard');
        }}
      />
    </View>
  );
};
```

---

## Event Placement Rules (Enforced)

✅ **DO**:
- Fire impression in `useEffect` on mount (once per screen visit)
- Fire exit in navigation callbacks (`useFocusEffect` cleanup)
- Fire exit on button press (explicit user action)
- Use `useRef` to prevent duplicate impressions

❌ **DON'T**:
- Fire on every render
- Fire from shared layout components
- Fire on button clicks that don't exit the screen
- Fire on retry/refresh attempts
- Fire outside the edge screen boundary

---

## Verification Checklist

- [ ] tRPC mutations added (`emitEdgeStateImpression`, `emitEdgeStateExit`)
- [ ] `useEdgeStateTelemetry` hook created
- [ ] E1 screen component created with telemetry wired
- [ ] E2 screen component created with telemetry wired
- [ ] E3 screen component created with telemetry wired
- [ ] Each screen fires exactly one impression per visit
- [ ] Exit duration is >0 and believable
- [ ] Role is always correct (derived from user.default_mode)
- [ ] No telemetry fires on non-edge screens

---

## Next Step After Implementation

Smoke test simulation:
- Tier B hustler in Instant Mode
- No tasks → E1 (verify impression + exit)
- Change location → E2 (verify impression + exit)
- Attempt in-home task → E3 (verify impression + exit)

Check dashboard queries return matching events.
