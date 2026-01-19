/**
 * Navigation Guards (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Declarative route guards.
 * Guards reference state, they do not compute it.
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. DECLARATIVE: Guards reference state, they do not compute it.
 * 
 * 2. NO BUSINESS LOGIC: Guards check state, they do not modify it.
 * 
 * 3. CANONICAL ENTRY: Each guard has one responsibility.
 * 
 * ============================================================================
 */

import { NavigationState } from './types';

// ============================================================================
// AUTHENTICATION GUARDS
// ============================================================================

/**
 * Check if user is authenticated.
 * 
 * Guard for: Auth stack vs Main stacks
 */
export function isAuthenticated(state: NavigationState): boolean {
  return state.isAuthenticated;
}

/**
 * Check if user is unauthenticated.
 * 
 * Guard for: Auth stack only
 */
export function isUnauthenticated(state: NavigationState): boolean {
  return !state.isAuthenticated;
}

// ============================================================================
// ROLE-BASED GUARDS
// ============================================================================

/**
 * Check if user is hustler (or both).
 * 
 * Guard for: HustlerMain stack entry
 */
export function canAccessHustlerStack(state: NavigationState): boolean {
  return state.role === 'hustler' || state.role === 'both';
}

/**
 * Check if user is poster (or both).
 * 
 * Guard for: PosterMain stack entry
 */
export function canAccessPosterStack(state: NavigationState): boolean {
  return state.role === 'poster' || state.role === 'both';
}

/**
 * Check if user has any role.
 * 
 * Guard for: Main stacks entry
 */
export function hasRole(state: NavigationState): boolean {
  return state.role !== null;
}

// ============================================================================
// ONBOARDING GUARDS
// ============================================================================

/**
 * Check if calibration onboarding is complete.
 * 
 * Guard for: CalibrationOnboarding → CapabilityOnboarding transition
 */
export function isCalibrationComplete(state: NavigationState): boolean {
  return state.onboarding.calibrationComplete;
}

/**
 * Check if capability onboarding is complete.
 * 
 * Guard for: CapabilityOnboarding → Main stacks transition
 */
export function isCapabilityComplete(state: NavigationState): boolean {
  return state.onboarding.capabilityComplete;
}

/**
 * Check if both onboarding systems are complete.
 * 
 * Guard for: Main stacks entry
 */
export function isOnboardingComplete(state: NavigationState): boolean {
  return (
    state.onboarding.calibrationComplete &&
    state.onboarding.capabilityComplete
  );
}

/**
 * Check if user needs calibration onboarding.
 * 
 * Guard for: CalibrationOnboarding stack entry
 */
export function needsCalibration(state: NavigationState): boolean {
  return !state.onboarding.calibrationComplete;
}

/**
 * Check if user needs capability onboarding.
 * 
 * Guard for: CapabilityOnboarding stack entry
 */
export function needsCapability(state: NavigationState): boolean {
  return !state.onboarding.capabilityComplete;
}

// ============================================================================
// TASK-STATE GUARDS
// ============================================================================

/**
 * Check if task is in EN_ROUTE state.
 * 
 * Guard for: HustlerEnRouteMapScreen (future)
 */
export function isTaskEnRoute(state: NavigationState): boolean {
  return state.currentTask.status === 'EN_ROUTE';
}

/**
 * Check if task is in ACCEPTED state.
 * 
 * Guard for: TaskInProgressScreen entry
 */
export function isTaskAccepted(state: NavigationState): boolean {
  return state.currentTask.status === 'ACCEPTED';
}

/**
 * Check if task is in WORKING state.
 * 
 * Guard for: TaskInProgressScreen entry
 */
export function isTaskWorking(state: NavigationState): boolean {
  return state.currentTask.status === 'WORKING';
}

/**
 * Check if task is in COMPLETED state.
 * 
 * Guard for: TaskCompletionScreen entry
 */
export function isTaskCompleted(state: NavigationState): boolean {
  return state.currentTask.status === 'COMPLETED';
}

/**
 * Check if user has an active task.
 * 
 * Guard for: Task-state-gated routes
 */
export function hasActiveTask(state: NavigationState): boolean {
  return state.currentTask.id !== null && state.currentTask.status !== null;
}

/**
 * Check if task is in EN_ROUTE state (ACCEPTED in schema).
 * 
 * Guard for: Map screens (HustlerEnRouteMapScreen, map sections)
 * 
 * Maps are execution visualizations, not discovery surfaces.
 * Maps are only visible when task.state === 'ACCEPTED' (EN_ROUTE conceptually).
 */
export function canAccessMap(state: NavigationState): boolean {
  // Maps only accessible when task is in EN_ROUTE state (stored as ACCEPTED)
  return state.currentTask.status === 'ACCEPTED' || state.currentTask.status === 'EN_ROUTE';
}

// ============================================================================
// COMBINED GUARDS
// ============================================================================

/**
 * Check if user can access main app.
 * 
 * Combined guard: Auth + Role + Onboarding
 */
export function canAccessMainApp(state: NavigationState): boolean {
  return (
    isAuthenticated(state) &&
    hasRole(state) &&
    isOnboardingComplete(state)
  );
}

/**
 * Determine initial route based on state.
 * 
 * Guard for: Root navigation initial route
 */
export function getInitialRoute(state: NavigationState): keyof typeof routePriorities {
  if (isUnauthenticated(state)) {
    return 'Auth';
  }
  
  if (needsCalibration(state)) {
    return 'CalibrationOnboarding';
  }
  
  if (needsCapability(state)) {
    return 'CapabilityOnboarding';
  }
  
  if (canAccessMainApp(state)) {
    // Default to hustler if both, or role-specific
    if (canAccessHustlerStack(state)) {
      return 'HustlerMain';
    }
    if (canAccessPosterStack(state)) {
      return 'PosterMain';
    }
  }
  
  return 'Auth';
}

/**
 * Route priority order for initial route determination.
 */
const routePriorities = {
  Auth: 0,
  CalibrationOnboarding: 1,
  CapabilityOnboarding: 2,
  HustlerMain: 3,
  PosterMain: 3, // Same priority, choose by role
} as const;
