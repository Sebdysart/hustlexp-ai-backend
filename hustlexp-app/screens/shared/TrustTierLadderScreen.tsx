/**
 * Screen: 06_TRUST_TIER_LADDER
 * Spec: HUSTLEXP-DOCS/ui-specs/stitch-prompts/06-trust-tier-ladder-LOCKED.md
 * Version: v1
 * Status: LOCKED
 * Components (required): GlassCard, SectionHeader
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
import { SectionHeader } from '../../ui/SectionHeader';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';

interface Tier {
  id: string;
  name: string;
  letter: string;
  status: 'current' | 'next' | 'locked' | 'completed';
  description?: string;
  requirements?: string[];
  benefits?: Array<{ icon: string; label: string; description?: string }>;
  progress?: { current: number; target: number };
  progressNote?: string;
}

interface TrustTierLadderScreenProps {
  currentTier: string;
  totalXP: number;
  totalTasks: number;
  rating: number;
  tiers: Tier[];
  onBack?: () => void;
}

const DEFAULT_TIERS: Tier[] = [
  {
    id: 'D',
    name: 'In-Home',
    letter: 'D',
    status: 'locked',
    description: 'Ultimate Status',
    requirements: ['Access to high-value interior tasks', 'Background check required'],
  },
  {
    id: 'C',
    name: 'Trusted',
    letter: 'C',
    status: 'next',
    description: 'Next Goal',
    progress: { current: 2847, target: 3200 },
    progressNote: 'Requirements are evaluated automatically.',
    requirements: ['Need: Maintain 4.8 star rating'],
    benefits: [
      { icon: 'payments', label: 'Weekly Bonus' },
      { icon: 'local-shipping', label: 'Priority Dispatch' },
    ],
  },
  {
    id: 'B',
    name: 'Verified',
    letter: 'B',
    status: 'current',
    benefits: [
      { icon: 'bolt', label: 'Instant Payouts', description: 'Funds available immediately' },
      { icon: 'percent', label: 'Standard Fees', description: 'Flat 5% platform fee' },
    ],
  },
  {
    id: 'A',
    name: 'Unverified',
    letter: 'A',
    status: 'completed',
    description: 'Basic access level. Completed.',
  },
];

export default function TrustTierLadderScreen({
  currentTier = 'B',
  totalXP = 12450,
  totalTasks = 48,
  rating = 4.9,
  tiers = DEFAULT_TIERS,
  onBack,
}: TrustTierLadderScreenProps) {
  const accentBlue = '#007AFF';
  const accentAmber = '#FF9500';

  const getTierColor = (status: string) => {
    switch (status) {
      case 'current':
        return accentBlue;
      case 'next':
        return accentAmber;
      default:
        return colors.muted;
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <MaterialIcons name="arrow-back" size={28} color={colors.textSecondary} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <Text style={styles.headerTitle}>Trust Tiers</Text>
          <Text style={styles.headerSubtitle}>Earned, not requested</Text>
        </View>
        <View style={styles.placeholder} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {tiers.map((tier, index) => {
          const tierColor = getTierColor(tier.status);
          const isLocked = tier.status === 'locked';
          const isCompleted = tier.status === 'completed';
          const isCurrent = tier.status === 'current';
          const isNext = tier.status === 'next';

          return (
            <GlassCard
              key={tier.id}
              style={[
                styles.tierCard,
                isCurrent && styles.tierCardCurrent,
                isNext && styles.tierCardNext,
                (isLocked || isCompleted) && styles.tierCardMuted,
              ]}
            >
              {/* Status Banner (Current Tier) */}
              {isCurrent && (
                <View style={[styles.statusBanner, { backgroundColor: `${accentBlue}10`, borderBottomColor: `${accentBlue}20` }]}>
                  <View style={[styles.statusBadge, { backgroundColor: '#1f7a4d' }]}>
                    <MaterialIcons name="check" size={10} color={colors.textPrimary} />
                  </View>
                  <Text style={[styles.statusText, { color: '#1f7a4d' }]}>You are here</Text>
                </View>
              )}

              {/* Next Goal Badge */}
              {isNext && (
                <View style={styles.nextGoalBadge}>
                  <View style={[styles.nextGoalPill, { backgroundColor: `${accentAmber}20`, borderColor: `${accentAmber}30` }]}>
                    <Text style={[styles.nextGoalText, { color: accentAmber }]}>Next Goal</Text>
                  </View>
                  <MaterialIcons name="emoji-events" size={24} color={accentAmber} />
                </View>
              )}

              {/* Lock Icon (Locked Tier) */}
              {isLocked && (
                <View style={styles.lockIcon}>
                  <MaterialIcons name="lock" size={20} color={colors.muted} />
                </View>
              )}

              {/* Tier Content */}
              <View style={styles.tierContent}>
                <View style={styles.tierHeader}>
                  <View>
                    <Text style={[styles.tierName, isNext && styles.tierNameNext]}>
                      {tier.name}
                    </Text>
                    <Text style={[styles.tierLetter, { color: tierColor }]}>
                      Tier {tier.letter}
                    </Text>
                    {tier.description && (
                      <Text style={styles.tierDescription}>{tier.description}</Text>
                    )}
                  </View>
                  {isCurrent && (
                    <MaterialIcons name="verified" size={24} color={accentBlue} />
                  )}
                </View>

                {/* Progress (Next Tier) */}
                {isNext && tier.progress && (
                  <View style={styles.progressSection}>
                    <View style={styles.progressHeader}>
                      <Text style={styles.progressLabel}>XP Progress</Text>
                      <Text style={styles.progressValue}>
                        <Text style={{ color: accentAmber }}>{tier.progress.current.toLocaleString()}</Text>
                        <Text style={{ color: colors.muted }}> / {tier.progress.target.toLocaleString()}</Text>
                      </Text>
                    </View>
                    <View style={styles.progressBar}>
                      <View
                        style={[
                          styles.progressFill,
                          {
                            width: `${(tier.progress.current / tier.progress.target) * 100}%`,
                            backgroundColor: accentAmber,
                          },
                        ]}
                      />
                    </View>
                    {tier.progressNote && (
                      <View style={styles.progressNote}>
                        <MaterialIcons name="info" size={14} color={colors.muted} />
                        <Text style={styles.progressNoteText}>{tier.progressNote}</Text>
                      </View>
                    )}
                    {tier.requirements && tier.requirements.map((req, idx) => (
                      <View key={idx} style={styles.progressNote}>
                        <MaterialIcons name="info" size={14} color={colors.muted} />
                        <Text style={styles.progressNoteText}>{req}</Text>
                      </View>
                    ))}
                  </View>
                )}

                {/* Benefits (Current/Next Tier) */}
                {(isCurrent || isNext) && tier.benefits && (
                  <View style={styles.benefitsSection}>
                    <Text style={styles.benefitsLabel}>Benefits Unlocked</Text>
                    <View style={styles.benefitsGrid}>
                      {tier.benefits.map((benefit, idx) => (
                        <View key={idx} style={styles.benefitItem}>
                          <MaterialIcons name={benefit.icon as any} size={20} color={colors.textPrimary} />
                          <Text style={styles.benefitLabel}>{benefit.label}</Text>
                          {benefit.description && (
                            <Text style={styles.benefitDescription}>{benefit.description}</Text>
                          )}
                        </View>
                      ))}
                    </View>
                  </View>
                )}

                {/* Requirements (Locked Tier) */}
                {isLocked && tier.requirements && (
                  <View style={styles.requirementsSection}>
                    {tier.requirements.map((req, idx) => (
                      <View key={idx} style={styles.requirementItem}>
                        <MaterialIcons name="diamond" size={18} color={colors.muted} />
                        <Text style={styles.requirementText}>{req}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            </GlassCard>
          );
        })}
      </ScrollView>

      {/* Bottom Summary Panel */}
      <View style={styles.summaryPanel}>
        <GlassCard style={styles.summaryCard}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryLabel}>Total XP</Text>
            <Text style={styles.summaryValue}>{totalXP.toLocaleString()}</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryLabel}>Tasks</Text>
            <Text style={styles.summaryValue}>{totalTasks}</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryLabel}>Rating</Text>
            <View style={styles.ratingRow}>
              <Text style={styles.summaryValue}>{rating}</Text>
              <MaterialIcons name="star" size={16} color={accentAmber} />
            </View>
          </View>
        </GlassCard>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 16,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerContent: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.muted,
  },
  placeholder: {
    width: 40,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: spacing.section,
    paddingBottom: 200,
    gap: 16,
  },
  tierCard: {
    position: 'relative',
    overflow: 'hidden',
  },
  tierCardCurrent: {
    borderWidth: 1.5,
    borderColor: '#007AFF',
  },
  tierCardNext: {
    borderWidth: 1.5,
    borderColor: '#FF9500',
    transform: [{ scale: 1.02 }],
  },
  tierCardMuted: {
    opacity: 0.4,
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderBottomWidth: 1,
    marginBottom: 20,
  },
  statusBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusText: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  nextGoalBadge: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  nextGoalPill: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  nextGoalText: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  lockIcon: {
    position: 'absolute',
    top: 20,
    right: 20,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tierContent: {
    padding: 20,
  },
  tierHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  tierName: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  tierNameNext: {
    fontSize: 30,
  },
  tierLetter: {
    fontSize: 12,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    opacity: 0.8,
  },
  tierDescription: {
    fontSize: 14,
    color: colors.muted,
    marginTop: 4,
  },
  progressSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: 8,
  },
  progressLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  progressValue: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  progressBar: {
    height: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
  },
  progressNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  progressNoteText: {
    fontSize: 12,
    color: colors.muted,
    opacity: 0.7,
  },
  benefitsSection: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.05)',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    padding: 20,
    borderRadius: 8,
  },
  benefitsLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 12,
  },
  benefitsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  benefitItem: {
    flex: 1,
    minWidth: '45%',
    gap: 4,
  },
  benefitLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  benefitDescription: {
    fontSize: 12,
    color: colors.muted,
  },
  requirementsSection: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
    gap: 12,
  },
  requirementItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  requirementText: {
    flex: 1,
    fontSize: 14,
    color: colors.textSecondary,
  },
  summaryPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.section,
    paddingBottom: 32,
    backgroundColor: colors.background,
  },
  summaryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    padding: 16,
  },
  summaryItem: {
    flex: 1,
    alignItems: 'center',
  },
  summaryDivider: {
    width: 1,
    height: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  summaryLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 4,
  },
  summaryValue: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
});
