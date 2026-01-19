/**
 * Edge State E2 — Eligibility Mismatch
 * 
 * Shown when tasks exist but the user is not eligible (trust tier, location, etc.).
 * 
 * Telemetry:
 * - Impression: Fires once on mount
 * - Exit: Fires on navigation or explicit user action
 */

import React from 'react';
import { View, Text, Button, StyleSheet, ScrollView } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useEdgeStateTelemetry } from '../hooks/useEdgeStateTelemetry';
import { trpc } from '../utils/trpc';

export const EdgeStateE2EligibilityMismatch: React.FC = () => {
  const navigation = useNavigation();
  const { data: user } = trpc.user.getCurrent.useQuery();

  // Wire telemetry
  const { emitExit } = useEdgeStateTelemetry('E2_ELIGIBILITY_MISMATCH', {
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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Capability Locked</Text>
        <Text style={styles.subtitle}>
          This task type requires a higher trust clearance.
        </Text>
      </View>

      <View style={styles.systemCard}>
        <Text style={styles.cardTitle}>Why this is restricted</Text>
        <Text style={styles.bullet}>• Some task types involve higher risk or tighter response guarantees.</Text>
        <Text style={styles.bullet}>• Access is gated by trust tier to protect all participants.</Text>
        <Text style={styles.bullet}>• This restriction is enforced automatically.</Text>
      </View>

      <View style={styles.eligibilityCard}>
        <Text style={styles.cardTitle}>What this does NOT mean</Text>
        <Text style={styles.bullet}>• Your account is not penalized.</Text>
        <Text style={styles.bullet}>• Your trust score has not decreased.</Text>
        <Text style={styles.bullet}>• You have not lost access to standard tasks.</Text>
      </View>

      <Button
        title="Return to Dashboard"
        onPress={handleReturnToDashboard}
      />
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  content: {
    padding: 16,
    paddingTop: 24,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#8E8E93',
    lineHeight: 20,
  },
  systemCard: {
    backgroundColor: 'rgba(28, 28, 30, 0.6)',
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
  },
  eligibilityCard: {
    backgroundColor: 'rgba(28, 28, 30, 0.6)',
    padding: 16,
    borderRadius: 12,
    marginBottom: 24,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 12,
  },
  bullet: {
    fontSize: 14,
    color: '#8E8E93',
    marginBottom: 8,
    lineHeight: 20,
  },
});
