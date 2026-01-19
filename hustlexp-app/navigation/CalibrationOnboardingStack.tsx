/**
 * Calibration Onboarding Stack Navigator (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * System A: Calibration onboarding (role inference, UX personalization).
 * 
 * Entry Guard: isAuthenticated(state) && needsCalibration(state)
 * Exit Condition: isCalibrationComplete(state) → CapabilityOnboarding
 * 
 * Flow: Sequential (Framing → Calibration → RoleConfirmation → PreferenceLock)
 * 
 * ============================================================================
 */

import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { CalibrationOnboardingStackParamList } from './types';

// Screen Imports
import { FramingScreen } from '../screens/onboarding/FramingScreen';
import { CalibrationScreen } from '../screens/onboarding/CalibrationScreen';
import { RoleConfirmationScreen } from '../screens/onboarding/RoleConfirmationScreen';
import { PreferenceLockScreen } from '../screens/onboarding/PreferenceLockScreen';

const Stack = createNativeStackNavigator<CalibrationOnboardingStackParamList>();

export function CalibrationOnboardingStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
      }}
      initialRouteName="Framing"
    >
      <Stack.Screen name="Framing" component={FramingScreen} />
      <Stack.Screen name="Calibration" component={CalibrationScreen} />
      <Stack.Screen name="RoleConfirmation" component={RoleConfirmationScreen} />
      <Stack.Screen name="PreferenceLock" component={PreferenceLockScreen} />
    </Stack.Navigator>
  );
}
