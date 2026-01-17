/**
 * Screen: 05_POSTER_HUSTLER_ON_WAY
 * Spec: HUSTLEXP-DOCS/ui-specs/stitch-prompts/05-poster-hustler-on-way-LOCKED.md
 * Version: v1
 * Status: LOCKED
 * Components (required): GlassCard, PrimaryActionButton
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
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';

interface ProgressStep {
  label: string;
  status: 'completed' | 'current' | 'pending';
}

interface HustlerOnWayScreenProps {
  hustlerName: string;
  hustlerInitials: string;
  trustTier: string;
  trustTierBadge: string; // e.g., "Trusted (Tier B)"
  taskCount: number;
  rating: number;
  taskTitle: string;
  payoutAmount: number;
  eta: string;
  etaSubtext?: string;
  progressSteps: ProgressStep[];
  onContact?: () => void;
}

export default function HustlerOnWayScreen({
  hustlerName = 'Alex M.',
  hustlerInitials = 'AM',
  trustTier = 'Trusted (Tier B)',
  trustTierBadge,
  taskCount = 47,
  rating = 4.9,
  taskTitle = 'Move furniture — 2nd floor',
  payoutAmount = 45.0,
  eta = '~12 minutes',
  etaSubtext = 'Based on current location',
  progressSteps = [
    { label: 'Accepted', status: 'completed' },
    { label: 'En route', status: 'current' },
    { label: 'Working', status: 'pending' },
    { label: 'Completed', status: 'pending' },
  ],
  onContact,
}: HustlerOnWayScreenProps) {
  const successColor = '#34C759';
  const amberColor = '#FF9500';
  const tierColor = '#007AFF';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Status Header */}
        <View style={styles.statusHeader}>
          <Text style={styles.statusTitle}>Hustler on the way</Text>
          <Text style={styles.statusSubtitle}>Task accepted</Text>
        </View>

        {/* Hustler Avatar */}
        <View style={styles.avatarSection}>
          <View style={styles.avatarContainer}>
            <View style={styles.avatar}>
              <Text style={styles.avatarInitials}>{hustlerInitials}</Text>
            </View>
            <View style={styles.tierBadge}>
              <MaterialIcons name="verified-user" size={14} color={tierColor} />
              <Text style={styles.tierBadgeText}>
                {trustTierBadge || trustTier}
              </Text>
            </View>
          </View>
        </View>

        {/* Hustler Info */}
        <View style={styles.infoSection}>
          <Text style={styles.hustlerName}>{hustlerName}</Text>
          <Text style={styles.hustlerStats}>
            {taskCount} tasks • {rating}★ rating
          </Text>
        </View>

        {/* Progress Steps */}
        <GlassCard style={styles.progressCard}>
          <View style={styles.progressSteps}>
            {progressSteps.map((step, index) => (
              <View key={index} style={styles.stepContainer}>
                <View style={styles.stepConnector} />
                <View
                  style={[
                    styles.stepIcon,
                    step.status === 'completed' && styles.stepIconCompleted,
                    step.status === 'current' && styles.stepIconCurrent,
                    step.status === 'pending' && styles.stepIconPending,
                  ]}
                >
                  {step.status === 'completed' && (
                    <MaterialIcons name="check" size={16} color={successColor} />
                  )}
                  {step.status === 'current' && (
                    <MaterialIcons name="arrow-forward" size={16} color={amberColor} />
                  )}
                  {step.status === 'pending' && (
                    <View style={styles.pendingDot} />
                  )}
                </View>
                <Text
                  style={[
                    styles.stepLabel,
                    step.status === 'completed' && styles.stepLabelCompleted,
                    step.status === 'current' && styles.stepLabelCurrent,
                    step.status === 'pending' && styles.stepLabelPending,
                  ]}
                >
                  {step.label}
                </Text>
              </View>
            ))}
          </View>
        </GlassCard>

        {/* ETA */}
        <View style={styles.etaSection}>
          <Text style={styles.etaText}>Arriving in {eta}</Text>
          <Text style={styles.etaSubtext}>{etaSubtext}</Text>
        </View>

        {/* Task Details */}
        <GlassCard style={styles.taskDetailsCard}>
          <Text style={styles.taskDetailsLabel}>Task: {taskTitle}</Text>
          <View style={styles.taskDetailsRow}>
            <Text style={styles.payoutAmount}>Pay: ${payoutAmount.toFixed(2)}</Text>
            <View style={styles.escrowBadge}>
              <Text style={styles.escrowBadgeText}>Escrow protected</Text>
            </View>
          </View>
          <Text style={styles.systemAssurance}>
            HustleXP monitors this task end-to-end
          </Text>
        </GlassCard>
      </ScrollView>

      {/* Contact Button */}
      <View style={styles.footer}>
        <PrimaryActionButton
          label="Contact via HustleXP"
          onPress={onContact || (() => {})}
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
    alignItems: 'center',
  },
  statusHeader: {
    alignItems: 'center',
    marginBottom: spacing.section * 1.5,
    paddingTop: 32,
  },
  statusTitle: {
    fontSize: 32,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 8,
    textAlign: 'center',
  },
  statusSubtitle: {
    fontSize: 16,
    color: '#34C759',
    textAlign: 'center',
  },
  avatarSection: {
    alignItems: 'center',
    marginBottom: spacing.section,
  },
  avatarContainer: {
    position: 'relative',
  },
  avatar: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#34C759',
    borderWidth: 2,
    borderColor: 'rgba(52, 199, 89, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#34C759',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
  },
  avatarInitials: {
    fontSize: 36,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  tierBadge: {
    position: 'absolute',
    bottom: -4,
    right: -4,
    backgroundColor: '#13201c',
    borderWidth: 1,
    borderColor: 'rgba(0, 122, 255, 0.2)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  tierBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#007AFF',
  },
  infoSection: {
    alignItems: 'center',
    marginBottom: spacing.section * 1.5,
  },
  hustlerName: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
    opacity: 0.9,
    marginBottom: 4,
    textAlign: 'center',
  },
  hustlerStats: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
  },
  progressCard: {
    width: '100%',
    padding: 20,
    marginBottom: spacing.section,
  },
  progressSteps: {
    gap: 16,
  },
  stepContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    position: 'relative',
  },
  stepConnector: {
    position: 'absolute',
    left: 6,
    top: 20,
    bottom: -8,
    width: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  stepIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  stepIconCompleted: {
    backgroundColor: 'rgba(52, 199, 89, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(52, 199, 89, 0.2)',
  },
  stepIconCurrent: {
    backgroundColor: 'rgba(255, 149, 0, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255, 149, 0, 0.2)',
  },
  stepIconPending: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  pendingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.muted,
  },
  stepLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  stepLabelCompleted: {
    color: colors.muted,
  },
  stepLabelCurrent: {
    color: '#FF9500',
    fontWeight: '600',
  },
  stepLabelPending: {
    color: colors.muted,
  },
  etaSection: {
    alignItems: 'center',
    marginBottom: spacing.section,
  },
  etaText: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 4,
    textAlign: 'center',
  },
  etaSubtext: {
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center',
  },
  taskDetailsCard: {
    width: '100%',
    padding: 20,
  },
  taskDetailsLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 12,
  },
  taskDetailsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  payoutAmount: {
    fontSize: 14,
    color: '#34C759',
  },
  escrowBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  escrowBadgeText: {
    fontSize: 12,
    color: colors.muted,
  },
  systemAssurance: {
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center',
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
