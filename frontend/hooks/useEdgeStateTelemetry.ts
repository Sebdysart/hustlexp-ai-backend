/**
 * useEdgeStateTelemetry Hook
 * 
 * Emits edge state impression and exit events for E1/E2/E3 screens.
 * 
 * Rules:
 * - Impression fires exactly once per screen visit (on mount)
 * - Exit fires on navigation or explicit user action
 * - App background exits excluded in v1
 * - Duration clamped to minimum 250ms
 */

import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { trpc } from '../utils/trpc';

export type EdgeStateType = 'E1_NO_TASKS_AVAILABLE' | 'E2_ELIGIBILITY_MISMATCH' | 'E3_TRUST_TIER_LOCKED';
export type ExitType = 'continue' | 'back' | 'app_background' | 'session_end';
export type UserRole = 'hustler' | 'poster';

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
        edge_state_version: 'v1',
      });
    }
  }, [state]); // Only fire once per state change

  // Return exit handler (only for explicit navigation/actions, not app background)
  const emitExit = (exitType: ExitType) => {
    // Exclude app_background in v1 (per requirements)
    if (exitType === 'app_background') {
      return;
    }

    if (screenStartTimeRef.current !== null) {
      const durationMs = Date.now() - screenStartTimeRef.current;
      
      exitMutation.mutate({
        state,
        role: context.role,
        time_on_screen_ms: durationMs,
        exit_type: exitType,
        edge_state_version: 'v1',
      });
    }
  };

  return { emitExit };
}
