/**
 * Capability Onboarding Stack Navigator (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * System B: Capability-driven onboarding (eligibility authority).
 * 
 * Entry Guard: isAuthenticated(state) && isCalibrationComplete(state) && needsCapability(state)
 * Exit Condition: isCapabilityComplete(state) → HustlerMain or PosterMain
 * 
 * Flow: Sequential with conditional branches (Phases 3-5 conditional based on Phase 2)
 * 
 * ============================================================================
 */

import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { CapabilityOnboardingStackParamList } from './types';

// Screen Imports
import { RoleDeclarationScreen } from '../screens/onboarding/capability/RoleDeclarationScreen';
import { LocationSelectionScreen } from '../screens/onboarding/capability/LocationSelectionScreen';
import { CapabilityDeclarationScreen } from '../screens/onboarding/capability/CapabilityDeclarationScreen';
import { CredentialClaimScreen } from '../screens/onboarding/capability/CredentialClaimScreen';
import { LicenseMetadataScreen } from '../screens/onboarding/capability/LicenseMetadataScreen';
import { InsuranceClaimScreen } from '../screens/onboarding/capability/InsuranceClaimScreen';
import { RiskWillingnessScreen } from '../screens/onboarding/capability/RiskWillingnessScreen';
import { CapabilitySummaryScreen } from '../screens/onboarding/capability/CapabilitySummaryScreen';

const Stack = createNativeStackNavigator<CapabilityOnboardingStackParamList>();

export function CapabilityOnboardingStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
      }}
      initialRouteName="RoleDeclaration"
    >
      <Stack.Screen name="RoleDeclaration" component={RoleDeclarationScreen} />
      <Stack.Screen name="LocationSelection" component={LocationSelectionScreen} />
      <Stack.Screen name="CapabilityDeclaration" component={CapabilityDeclarationScreen} />
      <Stack.Screen name="CredentialClaim" component={CredentialClaimScreen} />
      <Stack.Screen name="LicenseMetadata" component={LicenseMetadataScreen} />
      <Stack.Screen name="InsuranceClaim" component={InsuranceClaimScreen} />
      <Stack.Screen name="RiskWillingness" component={RiskWillingnessScreen} />
      <Stack.Screen name="CapabilitySummary" component={CapabilitySummaryScreen} />
    </Stack.Navigator>
  );
}
