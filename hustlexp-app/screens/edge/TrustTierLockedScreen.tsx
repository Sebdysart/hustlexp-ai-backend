/**
 * E3: Trust Tier Locked Screen
 * 
 * Edge state: Shows locked trust tier requirements.
 * Makes trust boring, deterministic, and earned. Requirements document, not marketing.
 * 
 * LOCKED: Spec matches E3-trust-tier-locked.md
 */

import React from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { GlassCard } from '../../ui/GlassCard';
import { PrimaryActionButton } from '../../ui/PrimaryActionButton';
import { SectionHeader } from '../../ui/SectionHeader';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';

interface TrustTierLockedScreenProps {
  variant?: 'hustler' | 'poster';
  lockedTierName?: string;
  lockedTierDescription?: string;
  requirements?: Array<{
    label: string;
    current: string;
    required: string;
  }>;
  affects?: string[];
  onContinue?: () => void;
}

export default function TrustTierLockedScreen({
  variant = 'hustler',
  lockedTierName = 'In-Home Tasks',
  lockedTierDescription = 'Required for tasks involving private spaces or sensitive access.',
  requirements = [
    { label: '25 completed tasks', current: '18 completed', required: '25' },
    {
      label: '5 five-star reviews from different posters',
      current: '3 reviews',
      required: '5',
    },
    { label: '30 days account age', current: '22 days active', required: '30' },
    { label: 'Security deposit locked', current: 'Not locked', required: 'Locked' },
  ],
  affects = [
    'In-home tasks',
    'Instant high-priority matching',
    'Care-related work',
  ],
  onContinue,
}: TrustTierLockedScreenProps) {
  // Adjust requirements for hustler variant
  const displayRequirements =
    variant === 'hustler'
      ? [
          { label: '10 completed tasks', current: '7 completed', required: '10' },
          { label: '0 disputes', current: '0 disputes', required: '0' },
          { label: '30 days account age', current: '22 days active', required: '30' },
          { label: 'Verified ID', current: 'Not verified', required: 'Verified' },
        ]
      : requirements;

  const displayAffects =
    variant === 'hustler'
      ? [
          'In-home tasks',
          'Instant high-priority matching',
          'Care-related work',
          'Higher-value task eligibility',
        ]
      : affects;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Trust Tier Locked</Text>
          <Text style={styles.subtitle}>
            Access is earned through verified actions.
          </Text>
        </View>

        {/* Tier Card */}
        <GlassCard>
          <View style={styles.tierBadgeRow}>
            <MaterialIcons name="lock" size={18} color={colors.textPrimary} />
            <Text style={styles.tierBadgeText}>{lockedTierName}</Text>
          </View>
          <Text style={styles.tierDescription}>{lockedTierDescription}</Text>
        </GlassCard>

        {/* Requirements Section */}
        <GlassCard>
          <SectionHeader title="Requirements" />
          <View style={styles.requirementsList}>
            {displayRequirements.map((req, index) => (
              <View key={index} style={styles.requirementItem}>
                <View style={styles.requirementHeader}>
                  <Text style={styles.requirementLabel}>{req.label}</Text>
                </View>
                <Text style={styles.requirementCurrent}>{req.current}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* What This Affects */}
        <GlassCard variant="secondary">
          <SectionHeader title="What this affects" />
          <View style={styles.bulletList}>
            {displayAffects.map((affect, index) => (
              <Text key={index} style={styles.bulletItem}>
                • {affect}
              </Text>
            ))}
          </View>
        </View>

        {/* Bottom Spacer */}
        <View style={styles.bottomSpacer} />
      </ScrollView>

      {/* Primary Action */}
      <View style={styles.actionContainer}>
        <PrimaryActionButton
          label="Continue"
          onPress={onContinue || (() => {})}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 100,
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing.section,
    gap: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 34,
    letterSpacing: -0.5,
    color: colors.textPrimary,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 21,
    color: colors.muted,
    textAlign: 'center',
  },
  tierBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  tierBadgeText: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  tierDescription: {
    fontSize: 14,
    lineHeight: 22.4,
    color: colors.textSecondary,
  },
  requirementsList: {
    gap: spacing.card,
  },
  requirementItem: {
    gap: 4,
  },
  requirementHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  requirementLabel: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  requirementCurrent: {
    fontSize: 12,
    color: colors.muted,
    marginLeft: 24,
  },
  bulletList: {
    gap: 8,
    marginTop: 12,
  },
  bulletItem: {
    fontSize: 14,
    lineHeight: 22.4,
    color: colors.textSecondary,
  },
  bottomSpacer: {
    height: spacing.section,
  },
  actionContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    paddingBottom: 32,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
    borderTopWidth: 1,
    borderTopColor: colors.glassBorderPrimary,
  },
});
