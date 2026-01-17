/**
 * Screen: 07_XP_BREAKDOWN
 * Spec: HUSTLEXP-DOCS/ui-specs/stitch-prompts/07-xp-breakdown-LOCKED.md
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
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { GlassCard } from '../../ui/GlassCard';
import { SectionHeader } from '../../ui/SectionHeader';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';

interface Bonus {
  type: 'instant' | 'speed' | 'surge' | 'streak';
  label: string;
  multiplier: string;
  description: string;
  amount: number;
}

interface BaseXPEvent {
  taskName: string;
  completedAt: string;
  amount: number;
}

interface XPBreakdownScreenProps {
  totalXP: number;
  dailyGoal?: number;
  date?: string;
  realTimeBonuses?: Bonus[];
  consistencyBonus?: { days: number; multiplier: string; amount: number };
  baseEvents?: BaseXPEvent[];
  calculationNote?: string;
}

export default function XPBreakdownScreen({
  totalXP = 342,
  dailyGoal = 500,
  date = 'Today, Oct 24',
  realTimeBonuses = [],
  consistencyBonus,
  baseEvents = [],
  calculationNote,
}: XPBreakdownScreenProps) {
  const primaryColor = '#f1a727';
  const accentGreen = '#26EB6F';
  const accentRed = '#EB2626';

  const progress = dailyGoal > 0 ? Math.min(totalXP / dailyGoal, 1) : 0;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>XP Breakdown</Text>
          <Text style={styles.headerDate}>{date}</Text>
        </View>

        {/* Hero Summary Card */}
        <GlassCard style={styles.heroCard}>
          <Text style={styles.heroLabel}>Total Earned</Text>
          <View style={styles.heroValueContainer}>
            <Text style={styles.heroValue}>{totalXP}</Text>
            <Text style={styles.heroUnit}>XP</Text>
          </View>
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
          </View>
          <View style={styles.progressLabels}>
            <Text style={styles.progressLabel}>Daily Goal: {dailyGoal} XP</Text>
            <Text style={styles.progressLabel}>{Math.round(progress * 100)}%</Text>
          </View>
        </GlassCard>

        {/* Real-Time Bonuses */}
        {realTimeBonuses.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <MaterialIcons name="bolt" size={20} color={primaryColor} />
              <Text style={styles.sectionTitle}>REAL-TIME BONUSES</Text>
            </View>
            {realTimeBonuses.map((bonus, index) => (
              <GlassCard key={index} style={styles.bonusCard}>
                <View style={styles.bonusContent}>
                  <View style={[styles.bonusIcon, { backgroundColor: `${getBonusColor(bonus.type)}10`, borderColor: `${getBonusColor(bonus.type)}20` }]}>
                    <MaterialIcons
                      name={getBonusIcon(bonus.type)}
                      size={20}
                      color={getBonusColor(bonus.type)}
                    />
                  </View>
                  <View style={styles.bonusInfo}>
                    <View style={styles.bonusTitleRow}>
                      <Text style={styles.bonusTitle}>{bonus.label}</Text>
                      <View style={[styles.multiplierBadge, { backgroundColor: `${getBonusColor(bonus.type)}20`, borderColor: `${getBonusColor(bonus.type)}20` }]}>
                        <Text style={[styles.multiplierText, { color: getBonusColor(bonus.type) }]}>
                          {bonus.multiplier}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.bonusDescription}>{bonus.description}</Text>
                  </View>
                </View>
                <Text style={[styles.bonusAmount, { color: accentGreen }]}>
                  +{bonus.amount} XP
                </Text>
              </GlassCard>
            ))}
          </View>
        )}

        {/* Consistency Bonus */}
        {consistencyBonus && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <MaterialIcons name="local-fire-department" size={20} color={accentRed} />
              <Text style={styles.sectionTitle}>CONSISTENCY</Text>
            </View>
            <GlassCard style={[styles.bonusCard, styles.consistencyCard]}>
              <View style={styles.bonusContent}>
                <View style={[styles.bonusIcon, { backgroundColor: `${accentRed}10`, borderColor: `${accentRed}20` }]}>
                  <Text style={[styles.streakDays, { color: accentRed }]}>
                    {consistencyBonus.days}D
                  </Text>
                </View>
                <View style={styles.bonusInfo}>
                  <View style={styles.bonusTitleRow}>
                    <Text style={styles.bonusTitle}>
                      {consistencyBonus.days}-Day Streak
                    </Text>
                    <View style={[styles.multiplierBadge, { backgroundColor: `${accentRed}20`, borderColor: `${accentRed}20` }]}>
                      <Text style={[styles.multiplierText, { color: accentRed }]}>
                        {consistencyBonus.multiplier}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.bonusDescription}>Keep it up tomorrow!</Text>
                </View>
              </View>
              <Text style={[styles.bonusAmount, { color: accentGreen }]}>
                +{consistencyBonus.amount} XP
              </Text>
            </GlassCard>
          </View>
        )}

        {/* Base XP Breakdown */}
        {baseEvents.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Base XP Breakdown</Text>
            <GlassCard style={styles.baseEventsCard}>
              {baseEvents.map((event, index) => (
                <View key={index}>
                  {index > 0 && <View style={styles.eventDivider} />}
                  <View style={styles.eventItem}>
                    <View style={styles.eventInfo}>
                      <Text style={styles.eventName}>{event.taskName}</Text>
                      <Text style={styles.eventTime}>Completed at {event.completedAt}</Text>
                    </View>
                    <Text style={styles.eventAmount}>{event.amount} XP</Text>
                  </View>
                </View>
              ))}
            </GlassCard>
          </View>
        )}

        {/* XP Resolution Logic */}
        {calculationNote && (
          <GlassCard style={styles.calculationCard}>
            <View style={styles.calculationHeader}>
              <MaterialIcons name="calculate" size={14} color={colors.muted} />
              <Text style={styles.calculationTitle}>XP Resolution</Text>
            </View>
            <Text style={styles.calculationNote}>{calculationNote}</Text>
          </GlassCard>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function getBonusIcon(type: string): string {
  switch (type) {
    case 'instant':
      return 'flash-on';
    case 'speed':
      return 'timer';
    case 'surge':
      return 'trending-up';
    default:
      return 'bolt';
  }
}

function getBonusColor(type: string): string {
  switch (type) {
    case 'instant':
      return '#f1a727';
    case 'speed':
      return '#26EB6F';
    case 'surge':
      return '#f1a727';
    default:
      return '#f1a727';
  }
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
    marginBottom: spacing.section,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  headerDate: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.muted,
  },
  heroCard: {
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 32,
    marginBottom: spacing.section,
  },
  heroLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginBottom: 8,
  },
  heroValueContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
  },
  heroValue: {
    fontSize: 56,
    fontWeight: '700',
    color: '#f1a727',
    lineHeight: 56,
  },
  heroUnit: {
    fontSize: 20,
    fontWeight: '500',
    color: 'rgba(241, 167, 39, 0.8)',
  },
  progressBar: {
    width: '100%',
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 2,
    marginTop: 24,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#f1a727',
    borderRadius: 2,
  },
  progressLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginTop: 8,
  },
  progressLabel: {
    fontSize: 12,
    color: colors.muted,
  },
  section: {
    marginBottom: spacing.section,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
    paddingLeft: 4,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  bonusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    marginBottom: 12,
  },
  consistencyCard: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(235, 38, 38, 0.5)',
  },
  bonusContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    flex: 1,
  },
  bonusIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  streakDays: {
    fontSize: 14,
    fontWeight: '700',
  },
  bonusInfo: {
    flex: 1,
  },
  bonusTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  bonusTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  multiplierBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  multiplierText: {
    fontSize: 10,
    fontWeight: '700',
  },
  bonusDescription: {
    fontSize: 12,
    color: colors.muted,
  },
  bonusAmount: {
    fontSize: 18,
    fontWeight: '700',
  },
  baseEventsCard: {
    padding: 4,
  },
  eventItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  eventDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  eventInfo: {
    flex: 1,
  },
  eventName: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textPrimary,
    marginBottom: 2,
  },
  eventTime: {
    fontSize: 12,
    color: colors.muted,
  },
  eventAmount: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textSecondary,
    fontFamily: 'monospace',
  },
  calculationCard: {
    padding: 20,
    borderStyle: 'dashed',
  },
  calculationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  calculationTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
  },
  calculationNote: {
    fontSize: 11,
    color: colors.muted,
    lineHeight: 18,
  },
});
