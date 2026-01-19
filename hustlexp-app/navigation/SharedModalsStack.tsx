/**
 * Shared Modals Stack Navigator (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Shared modals and edge states (accessible from any stack).
 * 
 * Entry Guard: None (accessible from any stack when state requires)
 * 
 * Access: Modal overlay from any stack
 * 
 * ============================================================================
 */

import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SharedModalStackParamList } from './types';

// Screen Imports
import TrustTierLadderScreen from '../screens/shared/TrustTierLadderScreen';
import TrustChangeExplanationScreen from '../screens/shared/TrustChangeExplanationScreen';
import DisputeEntryScreen from '../screens/shared/DisputeEntryScreen';
import NoTasksAvailableScreen from '../screens/edge/NoTasksAvailableScreen';
import EligibilityMismatchScreen from '../screens/edge/EligibilityMismatchScreen';
import TrustTierLockedScreen from '../screens/edge/TrustTierLockedScreen';

const Stack = createNativeStackNavigator<SharedModalStackParamList>();

export function SharedModalsStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_bottom',
        presentation: 'modal',
      }}
      initialRouteName="NoTasksAvailable"
    >
      <Stack.Screen name="TrustTierLadder" component={TrustTierLadderScreen} />
      <Stack.Screen name="TrustChangeExplanation" component={TrustChangeExplanationScreen} />
      <Stack.Screen name="DisputeEntry" component={DisputeEntryScreen} />
      <Stack.Screen name="NoTasksAvailable" component={NoTasksAvailableScreen} />
      <Stack.Screen name="EligibilityMismatch" component={EligibilityMismatchScreen} />
      <Stack.Screen name="TrustTierLocked" component={TrustTierLockedScreen} />
    </Stack.Navigator>
  );
}
