/**
 * HustleXP App Entry Point (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Phase N1: Navigation wiring with mock state.
 * 
 * Guards reference state, they do not compute it.
 * App.tsx supplies mock state, guards read it.
 * 
 * ============================================================================
 */

import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { RootNavigator } from './navigation/RootNavigator';
import { NavigationState, defaultNavigationState } from './navigation/types';

// ============================================================================
// MOCK STATE (Phase N1)
// ============================================================================

/**
 * Mock navigation state for Phase N1.
 * 
 * This will be replaced with real state in Phase N2.
 * 
 * Test different states by modifying these values:
 */
const mockNavigationState: NavigationState = {
  // Authentication state
  isAuthenticated: true,
  
  // Role (set after onboarding completes)
  role: null,
  
  // Onboarding state - NEW USERS START HERE
  // Users must complete both onboarding phases before accessing main app
  onboarding: {
    calibrationComplete: false,  // Start with calibration onboarding
    capabilityComplete: false,   // Then capability onboarding
  },
  
  // Task state (for task-state-gated routes)
  currentTask: {
    id: null,
    status: null,
  },
};

// ============================================================================
// APP COMPONENT
// ============================================================================

/**
 * HustleXP App
 * 
 * Root app component with navigation wiring.
 * 
 * Phase N1: Uses mock state for routing validation.
 * Phase N2: Will integrate with backend state.
 * 
 * @returns React component
 */
export default function App() {
  // Use mock state for Phase N1
  const navigationState = mockNavigationState;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <RootNavigator navigationState={navigationState} />
    </SafeAreaProvider>
  );
}
