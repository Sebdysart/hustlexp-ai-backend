/**
 * Edge State E3 — Trust Tier Locked
 * 
 * Shown when user attempts to access a task requiring a higher trust tier.
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

export const EdgeStateE3TrustTierLocked: React.FC = () => {
  const navigation = useNavigation();
  const { data: user } = trpc.user.getCurrent.useQuery();

  // Wire telemetry
  const { emitExit } = useEdgeStateTelemetry('E3_TRUST_TIER_LOCKED', {
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

  const handleContinue = () => {
    emitExit('continue');
    navigation.navigate('Dashboard');
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Trust Tier Locked</Text>
        <Text style={styles.subtitle}>
          Access is earned through verified actions.
        </Text>
      </View>

      <View style={styles.tierCard}>
        <View style={styles.lockIcon}>
          <Text style={styles.lockIconText}>🔒</Text>
        </View>
        <Text style={styles.tierTitle}>In-Home Tasks</Text>
        <Text style={styles.tierDescription}>
          Required for tasks involving private spaces or sensitive access.
        </Text>
      </View>

      <View style={styles.requirementsCard}>
        <Text style={styles.requirementsTitle}>Requirements</Text>
        <View style={styles.requirementItem}>
          <Text style={styles.requirementIcon}>⬜</Text>
          <View style={styles.requirementContent}>
            <Text style={styles.requirementText}>25 completed tasks</Text>
            <Text style={styles.requirementCurrent}>Current: 18 completed</Text>
          </View>
        </View>
        <View style={styles.requirementItem}>
          <Text style={styles.requirementIcon}>⬜</Text>
          <View style={styles.requirementContent}>
            <Text style={styles.requirementText}>5 five-star reviews from different posters</Text>
            <Text style={styles.requirementCurrent}>Current: 3 reviews</Text>
          </View>
        </View>
      </View>

      <Button
        title="Continue"
        onPress={handleContinue}
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
    alignItems: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#8E8E93',
    textAlign: 'center',
    maxWidth: 280,
  },
  tierCard: {
    backgroundColor: 'rgba(28, 28, 30, 0.6)',
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  lockIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  lockIconText: {
    fontSize: 24,
  },
  tierTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  tierDescription: {
    fontSize: 14,
    color: '#8E8E93',
  },
  requirementsCard: {
    backgroundColor: 'rgba(28, 28, 30, 0.6)',
    padding: 16,
    borderRadius: 16,
    marginBottom: 24,
  },
  requirementsTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#8E8E93',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 16,
  },
  requirementItem: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  requirementIcon: {
    fontSize: 18,
    marginRight: 12,
    marginTop: 2,
  },
  requirementContent: {
    flex: 1,
  },
  requirementText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  requirementCurrent: {
    fontSize: 12,
    color: '#8E8E93',
  },
});
