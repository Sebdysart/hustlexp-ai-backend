/**
 * E2: Eligibility Mismatch Screen
 * 
 * Edge state: Tasks exist, but user is not eligible.
 * Prevents shadow-ban paranoia, bias assumptions, retry/refresh behavior.
 * 
 * LOCKED: Spec matches E2-eligibility-mismatch-LOCKED.md
 */

import React, { useState } from 'react';
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

interface EligibilityMismatchScreenProps {
  onReturnToDashboard?: () => void;
}

export default function EligibilityMismatchScreen({
  onReturnToDashboard,
}: EligibilityMismatchScreenProps) {
  const [breakdownExpanded, setBreakdownExpanded] = useState(false);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <MaterialIcons name="filter-alt" size={32} color={colors.muted} />
            <MaterialIcons
              name="shield"
              size={24}
              color={colors.muted}
              style={styles.headerIconOverlay}
            />
          </View>
          <Text style={styles.title}>
            Tasks available — eligibility required
          </Text>
          <Text style={styles.subtitle}>
            Some active tasks are currently outside your eligibility parameters.
          </Text>
        </View>

        {/* Core System Card */}
        <GlassCard>
          <SectionHeader title="Eligibility Status" />
          <View style={styles.bulletList}>
            <Text style={styles.bulletItem}>
              Your account is active and in good standing
            </Text>
            <Text style={styles.bulletItem}>
              Matching is functioning normally
            </Text>
            <Text style={styles.bulletItem}>
              Some tasks require additional eligibility
            </Text>
          </View>
        </GlassCard>

        {/* Eligibility Breakdown (Collapsible) */}
        <GlassCard variant="secondary" style={styles.breakdownCard}>
          <TouchableOpacity
            onPress={() => setBreakdownExpanded(!breakdownExpanded)}
            activeOpacity={0.8}
          >
            <View style={styles.breakdownHeader}>
              <View style={styles.breakdownHeaderLeft}>
                <MaterialIcons name="info" size={20} color={colors.muted} />
                <Text style={styles.breakdownTitle}>
                  Why you may not see some tasks
                </Text>
              </View>
              <Text style={styles.expandIndicator}>
                {breakdownExpanded ? '▾ Tap to expand' : '▾ Tap to expand'}
              </Text>
            </View>

            {breakdownExpanded && (
              <View style={styles.breakdownContent}>
                <Text style={styles.breakdownItem}>
                  Some tasks require a higher trust tier than your current level.
                </Text>
                <Text style={styles.breakdownItem}>
                  Certain tasks require In-Home or Restricted clearance.
                </Text>
                <Text style={styles.breakdownItem}>
                  Tasks may be outside your current matching radius.
                </Text>
                <Text style={styles.breakdownItem}>
                  Some tasks are available only during specific time windows.
                </Text>
                <Text style={styles.breakdownItem}>
                  Instant tasks require availability, demand, and clearance
                  simultaneously.
                </Text>
              </View>
            )}
          </TouchableOpacity>
        </GlassCard>

        {/* "What This Is NOT" Section */}
        <GlassCard variant="secondary">
          <SectionHeader title="What this does NOT mean" />
          <View style={styles.bulletList}>
            <Text style={styles.bulletItem}>
              You are not restricted or penalized
            </Text>
            <Text style={styles.bulletItem}>
              Your trust score has not changed
            </Text>
            <Text style={styles.bulletItem}>
              No action is required from you
            </Text>
          </View>
        </GlassCard>

        {/* Current Settings Snapshot */}
        <GlassCard variant="secondary">
          <SectionHeader title="Current Settings" />
          <View style={styles.chipsContainer}>
            <View style={styles.chip}>
              <Text style={styles.chipText}>📍 UW Campus + 2mi</Text>
            </View>
            <View style={styles.chip}>
              <Text style={styles.chipText}>🛡️ Tier B — Trusted</Text>
            </View>
            <View style={[styles.chip, styles.chipActive]}>
              <Text style={[styles.chipText, styles.chipTextActive]}>
                ⚡ Instant Mode: ON
              </Text>
            </View>
          </View>
        </GlassCard>

        {/* Bottom Spacer */}
        <View style={styles.bottomSpacer} />
      </ScrollView>

      {/* Primary Action */}
      <View style={styles.actionContainer}>
        <PrimaryActionButton
          label="Return to Dashboard"
          onPress={onReturnToDashboard || (() => {})}
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
    gap: 12,
  },
  headerIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
    position: 'relative',
  },
  headerIconOverlay: {
    position: 'absolute',
    marginLeft: -16,
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
    maxWidth: 280,
  },
  breakdownCard: {
    marginBottom: spacing.card,
  },
  breakdownGlass: {
    marginBottom: spacing.card,
  },
  bulletList: {
    gap: 16,
  },
  bulletItem: {
    fontSize: 14,
    lineHeight: 22.4, // 1.6 * 14
    color: colors.textSecondary,
  },
  breakdownHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  breakdownHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  breakdownTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  expandIndicator: {
    fontSize: 12,
    fontStyle: 'italic',
    color: colors.muted,
  },
  breakdownContent: {
    marginTop: 16,
    gap: 16,
  },
  breakdownItem: {
    fontSize: 14,
    lineHeight: 22.4,
    color: colors.textSecondary,
  },
  chipsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  chipActive: {
    backgroundColor: 'rgba(66, 188, 240, 0.2)',
    borderColor: 'rgba(66, 188, 240, 0.3)',
  },
  chipText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  chipTextActive: {
    color: '#42bcf0',
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
