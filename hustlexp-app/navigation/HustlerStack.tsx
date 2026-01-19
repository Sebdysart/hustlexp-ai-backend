/**
 * Hustler Main Stack Navigator (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Hustler primary workflow navigation.
 * 
 * Entry Guard: canAccessMainApp(state) && canAccessHustlerStack(state)
 * 
 * Task-State Gated Routes:
 * - TaskInProgress: hasActiveTask(state) && (isTaskAccepted(state) || isTaskWorking(state))
 * - TaskCompletion: hasActiveTask(state) && isTaskCompleted(state)
 * 
 * ============================================================================
 */

import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { HustlerMainStackParamList } from './types';

// Screen Imports
import HustlerHomeScreen from '../screens/hustler/HustlerHomeScreen';
import { TaskFeedScreen } from '../screens/hustler/TaskFeedScreen';
import { TaskHistoryScreen } from '../screens/hustler/TaskHistoryScreen';
import TaskDetailScreen from '../screens/hustler/TaskDetailScreen';
import TaskInProgressScreen from '../screens/hustler/TaskInProgressScreen';
import TaskCompletionScreen from '../screens/hustler/TaskCompletionScreen';
import TaskConversationScreen from '../screens/shared/TaskConversationScreen';
import HustlerEnRouteMapScreen from '../screens/hustler/HustlerEnRouteMapScreen';
import XPBreakdownScreen from '../screens/hustler/XPBreakdownScreen';
import InstantInterruptCard from '../screens/hustler/InstantInterruptCard';

const Stack = createNativeStackNavigator<HustlerMainStackParamList>();

export function HustlerStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
      }}
      initialRouteName="Home"
    >
      <Stack.Screen name="Home" component={HustlerHomeScreen} />
      <Stack.Screen name="TaskFeed" component={TaskFeedScreen} />
      <Stack.Screen name="TaskHistory" component={TaskHistoryScreen} />
      <Stack.Screen name="TaskDetail" component={TaskDetailScreen} />
      <Stack.Screen name="TaskInProgress" component={TaskInProgressScreen} />
      <Stack.Screen name="TaskCompletion" component={TaskCompletionScreen} />
      <Stack.Screen name="TaskConversation" component={TaskConversationScreen} />
      <Stack.Screen name="HustlerEnRouteMap" component={HustlerEnRouteMapScreen} />
      <Stack.Screen 
        name="XPBreakdown" 
        component={XPBreakdownScreen}
        options={{ presentation: 'modal' }}
      />
      <Stack.Screen 
        name="InstantInterrupt" 
        component={InstantInterruptCard}
        options={{ presentation: 'modal' }}
      />
    </Stack.Navigator>
  );
}
