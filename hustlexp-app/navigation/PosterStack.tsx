/**
 * Poster Main Stack Navigator (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Poster primary workflow navigation.
 * 
 * Entry Guard: canAccessMainApp(state) && canAccessPosterStack(state)
 * 
 * Task-State Gated Routes:
 * - HustlerOnWay: hasActiveTask(state) && (isTaskAccepted(state) || isTaskEnRoute(state) || isTaskWorking(state))
 * 
 * ============================================================================
 */

import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { PosterMainStackParamList } from './types';

// Screen Imports
import TaskCreationScreen from '../screens/poster/TaskCreationScreen';
import HustlerOnWayScreen from '../screens/poster/HustlerOnWayScreen';
import TaskCompletionScreen from '../screens/poster/TaskCompletionScreen';
import TaskConversationScreen from '../screens/shared/TaskConversationScreen';
import FeedbackScreen from '../screens/poster/FeedbackScreen';

const Stack = createNativeStackNavigator<PosterMainStackParamList>();

export function PosterStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
      }}
      initialRouteName="TaskCreation"
    >
      <Stack.Screen name="TaskCreation" component={TaskCreationScreen} />
      <Stack.Screen name="HustlerOnWay" component={HustlerOnWayScreen} />
      <Stack.Screen name="TaskCompletion" component={TaskCompletionScreen} />
      <Stack.Screen name="TaskConversation" component={TaskConversationScreen} />
      <Stack.Screen name="Feedback" component={FeedbackScreen} />
    </Stack.Navigator>
  );
}
