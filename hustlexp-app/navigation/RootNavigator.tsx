/**
 * Root Navigator (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Root navigation structure.
 * 
 * Guards determine initial route and stack access.
 * Guards reference state, they do not compute it.
 * 
 * ============================================================================
 */

import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RootStackParamList, NavigationState } from './types';
import { getInitialRoute } from './guards';

// Stack Imports
import { AuthStack } from './AuthStack';
import { CalibrationOnboardingStack } from './CalibrationOnboardingStack';
import { CapabilityOnboardingStack } from './CapabilityOnboardingStack';
import { HustlerStack } from './HustlerStack';
import { PosterStack } from './PosterStack';
import { SettingsStack } from './SettingsStack';
import { SharedModalsStack } from './SharedModalsStack';

const RootStack = createNativeStackNavigator<RootStackParamList>();

/**
 * Root Navigator Props
 * 
 * Props for root navigation container.
 */
export interface RootNavigatorProps {
  /** Navigation state (mock for Phase N1, real for Phase N2) */
  navigationState: NavigationState;
}

/**
 * Root Navigator Component
 * 
 * Root navigation structure with declarative guards.
 * 
 * Initial route is determined by getInitialRoute(state).
 * Guards reference state, they do not compute it.
 * 
 * @param props - Root navigator props
 * @returns React component
 */
export function RootNavigator({ navigationState }: RootNavigatorProps) {
  // Determine initial route based on state
  const initialRoute = getInitialRoute(navigationState);

  return (
    <NavigationContainer>
      <RootStack.Navigator
        screenOptions={{
          headerShown: false,
        }}
        initialRouteName={initialRoute}
      >
        {/* Auth Flow */}
        <RootStack.Screen name="Auth" component={AuthStack} />

        {/* Onboarding Flows (sequential) */}
        <RootStack.Screen 
          name="CalibrationOnboarding" 
          component={CalibrationOnboardingStack} 
        />
        <RootStack.Screen 
          name="CapabilityOnboarding" 
          component={CapabilityOnboardingStack} 
        />

        {/* Main Flows (role-based) */}
        <RootStack.Screen name="HustlerMain" component={HustlerStack} />
        <RootStack.Screen name="PosterMain" component={PosterStack} />

        {/* Settings (accessible from main) */}
        <RootStack.Screen 
          name="Settings" 
          component={SettingsStack}
          options={{ presentation: 'modal' }}
        />

        {/* Shared Modals (accessible from any) */}
        <RootStack.Screen 
          name="SharedModal" 
          component={SharedModalsStack}
          options={{ presentation: 'modal' }}
        />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
