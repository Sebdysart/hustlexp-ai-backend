/**
 * Screen: E1_NO_TASKS_AVAILABLE
 * Spec: HUSTLEXP-DOCS/ui-specs/stitch-prompts/E1-no-tasks-available.md
 * Version: v1
 * Status: LOCKED
 * Components (required): GlassCard, PrimaryActionButton, SectionHeader
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
import { PrimaryActionButton } from '../../ui/PrimaryActionButton';
import { SectionHeader } from '../../ui/SectionHeader';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';

interface NoTasksAvailableScreenProps {
  location?: string;
  trustTier?: string;
  instantMode?: boolean;
  onReturnToDashboard?: () => void;
}

export default function NoTasksAvailableScreen({
  location = 'UW Campus + 2mi',
  trustTier = 'Tier B — Trusted',
  instantMode = false,
  onReturnToDashboard,
}: NoTasksAvailableScreenProps) {
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>No tasks available</Text>
          <Text style={styles.subtitle}>
            There are currently no tasks matching your eligibility and location.
          </Text>
        </View>

        {/* System Context Card */}
        <GlassCard>
          <View style={styles.systemHeader}>
            <MaterialIcons name="shield" size={24} color={colors.muted} />
            <SectionHeader title="System Status" />
          </View>
          <View style={styles.bulletList}>
            <Text style={styles.bulletItem}>
              Your account is active and eligible
            </Text>
            <Text style={styles.bulletItem}>
              Matching is automatic — no action required
            </Text>
            <Text style={styles.bulletItem}>
              Tasks appear when demand exists nearby
            </Text>
          </View>

          {/* Time-Based Expectation */}
          <View style={styles.timeExpectation}>
            <Text style={styles.timeText}>
              New tasks typically appear within 24 hours. No action required from you.
            </Text>
          </View>
        </GlassCard>

        {/* Status Chips (Read-Only) */}
        <GlassCard variant="secondary">
          <SectionHeader title="Current Settings" />
          <View style={styles.chipsContainer}>
            <View style={styles.chip}>
              <Text style={styles.chipText}>{location}</Text>
            </View>
            <View style={styles.chip}>
              <Text style={styles.chipText}>{trustTier}</Text>
            </View>
            <View style={[styles.chip, instantMode && styles.chipActive]}>
              <Text style={[styles.chipText, instantMode && styles.chipTextActive]}>
                Instant Mode: {instantMode ? 'ON' : 'OFF'}
              </Text>
            </View>
          </View>
        </GlassCard>
      </ScrollView>

      {/* Primary Action Button (Fixed Bottom) */}
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
    padding: spacing.section,
    paddingBottom: 100, // Space for fixed button
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing.section,
    paddingTop: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 21,
    maxWidth: 280,
  },
  systemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  bulletList: {
    gap: 16,
  },
  bulletItem: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textSecondary,
    lineHeight: 21,
  },
  timeExpectation: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.05)',
  },
  timeText: {
    fontSize: 12,
    fontStyle: 'italic',
    color: colors.muted,
    lineHeight: 18,
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
  actionContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.section,
    paddingBottom: 32,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
  },
});
