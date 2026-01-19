/**
 * Navigation Types (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Type definitions for navigation structure.
 * No business logic. Routing only.
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. DECLARATIVE GUARDS: Guards reference state, they do not compute it.
 * 
 * 2. NO BUSINESS LOGIC: Navigation types define structure only.
 * 
 * 3. CANONICAL ENTRY POINTS: Each screen has exactly one entry point.
 * 
 * ============================================================================
 */

import { NavigatorScreenParams } from '@react-navigation/native';

// ============================================================================
// AUTH NAVIGATION PARAMS
// ============================================================================

export type AuthStackParamList = {
  Login: undefined;
  Signup: undefined;
  ForgotPassword: undefined;
};

// ============================================================================
// CALIBRATION ONBOARDING PARAMS (System A)
// ============================================================================

export type CalibrationOnboardingStackParamList = {
  Framing: undefined;
  Calibration: undefined;
  RoleConfirmation: undefined;
  PreferenceLock: undefined;
};

// ============================================================================
// CAPABILITY ONBOARDING PARAMS (System B)
// ============================================================================

export type CapabilityOnboardingStackParamList = {
  RoleDeclaration: undefined;
  LocationSelection: undefined;
  CapabilityDeclaration: undefined;
  CredentialClaim: undefined;
  LicenseMetadata: {
    regulatedTrades: string[];
    workState?: string;
  };
  InsuranceClaim: undefined;
  RiskWillingness: {
    insuranceClaimed?: boolean;
  };
  CapabilitySummary: undefined;
};

// ============================================================================
// HUSTLER MAIN PARAMS
// ============================================================================

export type HustlerMainStackParamList = {
  Home: undefined;
  TaskFeed: undefined;
  TaskHistory: undefined;
  TaskDetail: {
    taskId: string;
  };
  TaskInProgress: {
    taskId: string;
  };
  TaskCompletion: {
    taskId: string;
    status: 'APPROVED' | 'ACTION_REQUIRED' | 'BLOCKED';
  };
  TaskConversation: {
    taskId: string;
  };
  HustlerEnRouteMap: {
    taskId: string;
  };
  XPBreakdown: undefined;
  InstantInterrupt: {
    taskId: string;
  };
};

// ============================================================================
// POSTER MAIN PARAMS
// ============================================================================

export type PosterMainStackParamList = {
  TaskCreation: undefined;
  HustlerOnWay: {
    taskId: string;
  };
  TaskCompletion: {
    taskId: string;
  };
  TaskConversation: {
    taskId: string;
  };
  Feedback: {
    taskId: string;
  };
};

// ============================================================================
// SETTINGS PARAMS
// ============================================================================

export type SettingsStackParamList = {
  Profile: undefined;
  Wallet: undefined;
  WorkEligibility: undefined;
};

// ============================================================================
// SHARED MODAL PARAMS
// ============================================================================

export type SharedModalStackParamList = {
  TrustTierLadder: undefined;
  TrustChangeExplanation: {
    changeType: 'hustler' | 'poster';
  };
  DisputeEntry: {
    changeType: 'hustler' | 'poster';
    taskId: string;
  };
  NoTasksAvailable: undefined;
  EligibilityMismatch: undefined;
  TrustTierLocked: undefined;
};

// ============================================================================
// ROOT NAVIGATION PARAMS
// ============================================================================

export type RootStackParamList = {
  // Auth Flow
  Auth: NavigatorScreenParams<AuthStackParamList>;
  
  // Onboarding Flows (sequential)
  CalibrationOnboarding: NavigatorScreenParams<CalibrationOnboardingStackParamList>;
  CapabilityOnboarding: NavigatorScreenParams<CapabilityOnboardingStackParamList>;
  
  // Main Flows (role-based)
  HustlerMain: NavigatorScreenParams<HustlerMainStackParamList>;
  PosterMain: NavigatorScreenParams<PosterMainStackParamList>;
  
  // Settings (accessible from main)
  Settings: NavigatorScreenParams<SettingsStackParamList>;
  
  // Shared Modals (accessible from any)
  SharedModal: NavigatorScreenParams<SharedModalStackParamList>;
};

// ============================================================================
// NAVIGATION STATE (Mock - for Phase N1)
// ============================================================================

/**
 * Navigation state for guards.
 * 
 * Guards reference this state, they do not compute it.
 */
export interface NavigationState {
  /** Authentication state */
  isAuthenticated: boolean;
  
  /** User role */
  role: 'hustler' | 'poster' | 'both' | null;
  
  /** Onboarding completion state */
  onboarding: {
    calibrationComplete: boolean;
    capabilityComplete: boolean;
  };
  
  /** Current task state (for task-state-gated routes) */
  currentTask: {
    id: string | null;
    status: 'ACCEPTED' | 'EN_ROUTE' | 'WORKING' | 'COMPLETED' | null;
  };
}

/**
 * Default mock state for Phase N1.
 * 
 * This will be replaced with real state in Phase N2.
 */
export const defaultNavigationState: NavigationState = {
  isAuthenticated: false,
  role: null,
  onboarding: {
    calibrationComplete: false,
    capabilityComplete: false,
  },
  currentTask: {
    id: null,
    status: null,
  },
};
