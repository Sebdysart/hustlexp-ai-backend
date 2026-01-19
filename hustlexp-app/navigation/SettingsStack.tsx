/**
 * Settings Stack Navigator (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * User settings navigation (accessible from main stacks).
 * 
 * Entry Guard: canAccessMainApp(state)
 * 
 * Access: Navigated to from main stacks (not initial route)
 * 
 * ============================================================================
 */

import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SettingsStackParamList } from './types';

// Screen Imports
import { ProfileScreen } from '../screens/settings/ProfileScreen';
import { WalletScreen } from '../screens/settings/WalletScreen';
import { WorkEligibilityScreen } from '../screens/settings/WorkEligibilityScreen';

const Stack = createNativeStackNavigator<SettingsStackParamList>();

export function SettingsStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
      }}
      initialRouteName="Profile"
    >
      <Stack.Screen name="Profile" component={ProfileScreen} />
      <Stack.Screen name="Wallet" component={WalletScreen} />
      <Stack.Screen name="WorkEligibility" component={WorkEligibilityScreen} />
    </Stack.Navigator>
  );
}
