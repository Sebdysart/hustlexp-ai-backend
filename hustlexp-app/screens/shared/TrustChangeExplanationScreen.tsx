/**
 * Screen: 12_TRUST_CHANGE_EXPLANATION
 * Spec: HUSTLEXP-DOCS/ui-specs/stitch-prompts/12-trust-change-explanation-LOCKED.md
 * Version: v1
 * Status: LOCKED
 * Variants: Hustler, Poster (same structure, different context)
 * Components (required): GlassCard, PrimaryActionButton, SectionHeader
 * Tokens (required): colors.json, spacing.json, typography.json
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

type TrustChangeVariant = 'hustler' | 'poster';

interface TrustChangeExplanationScreenProps {
  variant: TrustChangeVariant;
  taskTitle: string;
  contractId: string;
  completedAt: string;
  xpGained?: number;
  xpBreakdown?: string;
  reliabilityStatus?: 'Passed' | 'Failed';
  trustTierChanged?: boolean;
  currentTier?: string;
  tierProgress?: string;
  systemImpact?: string[];
  onContinue?: () => void;
}

export default function TrustChangeExplanationScreen({
  variant,
  taskTitle,
  contractId,
  completedAt,
  xpGained = 342,
  xpBreakdown,
  reliabilityStatus,
  trustTierChanged = false,
  currentTier = 'Trusted (Tier C)',
  tierProgress,
  systemImpact = [],
  onContinue,
}: TrustChangeExplanationScreenProps) {
  const primaryColor = '#34C759';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity style={styles.backButton}>
            <MaterialIcons name="arrow-back-ios" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Title */}
        <View style={styles.titleContainer}>
          <Text style={styles.title}>Task Impact Summary</Text>
          <Text style={styles.subtitle}>
            {variant === 'hustler'
              ? 'How this task affected system trust and matching'
              : 'How this task affected matching and system trust'}
          </Text>
        </View>

        {/* Task Summary */}
        <GlassCard>
          <SectionHeader title="Task Summary" />
          <Text style={styles.taskTitle}>{taskTitle}</Text>
          <Text style={styles.contractId}>Contract ID: {contractId}</Text>
          <Text style={styles.completedAt}>Completed on {completedAt}</Text>
        </GlassCard>

        {/* System Updates */}
        <GlassCard>
          <SectionHeader title="System Updates" />
          <View style={styles.updatesList}>
            {/* XP Gained (Hustler only) */}
            {variant === 'hustler' && (
              <View style={styles.updateItem}>
                <MaterialIcons name="emoji-events" size={20} color={primaryColor} />
                <View style={styles.updateContent}>
                  <Text style={styles.updateLabel}>XP Gained</Text>
                  <Text style={styles.updateValue}>+{xpGained} XP</Text>
                  {xpBreakdown && (
                    <Text style={styles.updateHint}>{xpBreakdown}</Text>
                  )}
                </View>
              </View>
            )}

            {/* Reliability Status */}
            {reliabilityStatus && (
              <View style={styles.updateItem}>
                <MaterialIcons name="shield" size={20} color={primaryColor} />
                <View style={styles.updateContent}>
                  <Text style={styles.updateLabel}>
                    Reliability Status for This Task
                  </Text>
                  <Text style={[styles.updateValue, { fontSize: 18, color: primaryColor }]}>
                    {reliabilityStatus}
                  </Text>
                  <Text style={styles.updateHint}>
                    Account Reliability {trustTierChanged ? '(changed)' : '(unchanged)'}
                  </Text>
                </View>
              </View>
            )}

            {/* Trust Tier */}
            <View style={styles.updateItem}>
              <MaterialIcons name="shield" size={20} color={colors.muted} />
              <View style={styles.updateContent}>
                <Text style={styles.updateLabel}>Trust Tier</Text>
                <Text style={[styles.updateValue, { fontSize: 18, color: trustTierChanged ? primaryColor : colors.muted }]}>
                  {trustTierChanged ? 'Changed' : 'Unchanged'}
                </Text>
                <Text style={styles.updateHint}>
                  Current tier: {currentTier}
                  {tierProgress && `. ${tierProgress}`}
                </Text>
              </View>
            </View>
          </View>
        </GlassCard>

        {/* System Impact */}
        {systemImpact.length > 0 && (
          <GlassCard>
            <SectionHeader title="System Impact" />
            <View style={styles.impactItem}>
              <MaterialIcons name="shield" size={20} color={colors.muted} />
              <View style={styles.impactContent}>
                <Text style={styles.impactLabel}>Impact from this task:</Text>
                <View style={styles.impactList}>
                  {systemImpact.map((impact, index) => (
                    <Text key={index} style={styles.impactBullet}>
                      • {impact}
                    </Text>
                  ))}
                </View>
                <Text style={styles.impactNote}>
                  {variant === 'hustler'
                    ? 'High-trust status unlocks priority matching for future tasks.'
                    : 'High-quality completion improves future matching recommendations.'}
                </Text>
              </View>
            </View>
          </GlassCard>
        )}

        {/* What Did NOT Change */}
        <GlassCard style={styles.unchangedCard}>
          <SectionHeader title="No Penalties" />
          <Text style={styles.unchangedText}>
            Task completed successfully. No trust penalties or restrictions applied.
          </Text>
        </GlassCard>

        {/* Next Steps */}
        <GlassCard style={styles.nextStepsCard}>
          <SectionHeader title="Next Steps" />
          <Text style={styles.nextStepsText}>
            {variant === 'hustler'
              ? 'Your updated trust tier and XP will be reflected in future task matching and eligibility.'
              : 'Your matching preferences and trust signals will be updated for future task postings.'}
          </Text>
        </GlassCard>
      </ScrollView>

      {/* Footer Action */}
      <View style={styles.footer}>
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
    padding: spacing.section,
    paddingBottom: 100,
  },
  header: {
    paddingVertical: 16,
    paddingHorizontal: 8,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleContainer: {
    alignItems: 'center',
    marginBottom: spacing.section,
    paddingTop: 24,
    paddingBottom: 32,
  },
  title: {
    fontSize: 30,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: colors.muted,
    textAlign: 'center',
  },
  taskTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary,
    marginTop: 8,
    marginBottom: 8,
  },
  contractId: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 4,
  },
  completedAt: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 8,
  },
  updatesList: {
    gap: 16,
    marginTop: 16,
  },
  updateItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  updateContent: {
    flex: 1,
  },
  updateLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  updateValue: {
    fontSize: 24,
    fontWeight: '700',
    color: '#34C759',
    marginBottom: 4,
  },
  updateHint: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 4,
  },
  impactItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 12,
  },
  impactContent: {
    flex: 1,
  },
  impactLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: 8,
  },
  impactList: {
    gap: 8,
    marginBottom: 12,
  },
  impactBullet: {
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  impactNote: {
    fontSize: 12,
    fontStyle: 'italic',
    color: colors.muted,
    marginTop: 12,
  },
  unchangedCard: {
    opacity: 0.6,
  },
  unchangedText: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 8,
  },
  nextStepsCard: {
    opacity: 0.6,
  },
  nextStepsText: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 8,
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.section,
    paddingBottom: 32,
    backgroundColor: colors.background,
  },
});
