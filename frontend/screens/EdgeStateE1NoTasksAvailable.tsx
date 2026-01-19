/**
 * Edge State E1 — No Tasks Available
 * 
 * Shown when no tasks are available for the current user.
 * 
 * Telemetry:
 * - Impression: Fires once on mount
 * - Exit: Fires on navigation or explicit user action
 */

import React from 'react';
import { View, Text, Button, StyleSheet } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useEdgeStateTelemetry } from '../hooks/useEdgeStateTelemetry';
import { trpc } from '../utils/trpc';

export const EdgeStateE1NoTasksAvailable: React.FC = () => {
  const navigation = useNavigation();
  const { data: user } = trpc.user.getCurrent.useQuery();

  // Wire telemetry
  const { emitExit } = useEdgeStateTelemetry('E1_NO_TASKS_AVAILABLE', {
    role: user?.default_mode === 'poster' ? 'poster' : 'hustler',
    trust_tier: user?.trust_tier || 0,
    location_radius_miles: user?.location_radius,
    instant_mode_enabled: user?.instant_mode_enabled || false,
  });

  // Handle navigation exit (when screen is unfocused)
  useFocusEffect(
    React.useCallback(() => {
      return () => {
        // Screen is unfocused (user navigated away)
        emitExit('back');
      };
    }, [emitExit])
  );

  const handleReturnToDashboard = () => {
    emitExit('continue');
    navigation.navigate('Dashboard');
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>No Tasks Available</Text>
        <Text style={styles.subtitle}>
          No tasks are available right now. New tasks typically appear within 24 hours.
        </Text>
        
        <View style={styles.statusCard}>
          <Text style={styles.statusTitle}>Current Settings</Text>
          <Text style={styles.statusItem}>Instant Mode: {user?.instant_mode_enabled ? 'ON' : 'OFF'}</Text>
          <Text style={styles.statusItem}>Trust Tier: {user?.trust_tier || 0}</Text>
        </View>

        <Button
          title="Return to Dashboard"
          onPress={handleReturnToDashboard}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
    padding: 16,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#8E8E93',
    marginBottom: 24,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  statusCard: {
    backgroundColor: 'rgba(28, 28, 30, 0.6)',
    padding: 16,
    borderRadius: 12,
    marginBottom: 24,
    width: '100%',
    maxWidth: 400,
  },
  statusTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#8E8E93',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  statusItem: {
    fontSize: 14,
    color: '#FFFFFF',
    marginBottom: 4,
  },
});
