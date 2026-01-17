/**
 * Screen: 10_POSTER_TASK_COMPLETION
 * Spec: HUSTLEXP-DOCS/ui-specs/stitch-prompts/10-poster-task-completion-LOCKED.md
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

interface PosterTaskCompletionScreenProps {
  taskTitle: string;
  contractId: string;
  completedAt: string;
  hustlerName: string;
  hustlerInitials: string;
  taskCount: number;
  rating: number;
  payoutAmount: number;
  proofItemsVerified?: number;
  onLeaveFeedback?: () => void;
  onReportIssue?: () => void;
  onClose?: () => void;
}

export default function PosterTaskCompletionScreen({
  taskTitle = 'Move furniture — 2nd floor walk-up',
  contractId = '#820-A4',
  completedAt = 'Oct 24, 2024 at 2:34 PM',
  hustlerName = 'Alex M.',
  hustlerInitials = 'AM',
  taskCount = 47,
  rating = 4.9,
  payoutAmount = 45.0,
  proofItemsVerified = 3,
  onLeaveFeedback,
  onReportIssue,
  onClose,
}: PosterTaskCompletionScreenProps) {
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
          <TouchableOpacity style={styles.headerButton} onPress={onClose}>
            <MaterialIcons name="close" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
          <Text style={styles.headerLabel}>Confirmation</Text>
          <TouchableOpacity style={styles.headerButton}>
            <MaterialIcons name="share" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Completion Status */}
        <View style={styles.completionStatus}>
          <View style={styles.completionIcon}>
            <MaterialIcons name="check-circle" size={40} color={primaryColor} />
          </View>
          <Text style={styles.completionTitle}>Task Completed</Text>
          <Text style={styles.completionSubtitle}>All requirements were verified</Text>
        </View>

        {/* Hustler Summary Card */}
        <GlassCard style={styles.hustlerCard}>
          <View style={styles.avatarContainer}>
            <View style={styles.avatar}>
              <Text style={styles.avatarInitials}>{hustlerInitials}</Text>
            </View>
            <View style={styles.verifiedBadge}>
              <MaterialIcons name="verified-user" size={18} color={primaryColor} />
            </View>
          </View>
          <Text style={styles.hustlerName}>{hustlerName}</Text>
          <View style={styles.statsGrid}>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{taskCount}</Text>
              <Text style={styles.statLabel}>Tasks</Text>
            </View>
            <View style={styles.statCard}>
              <View style={styles.ratingRow}>
                <Text style={styles.statValue}>{rating}</Text>
                <MaterialIcons name="star" size={14} color={primaryColor} />
              </View>
              <Text style={styles.statLabel}>Rating</Text>
            </View>
          </View>
          <View style={styles.verifiedStatus}>
            <View style={styles.verifiedDot} />
            <Text style={styles.verifiedText}>Verified and in good standing</Text>
          </View>
        </GlassCard>

        {/* Task Completion Verified */}
        <GlassCard>
          <View style={styles.verificationHeader}>
            <View style={styles.verificationIcon}>
              <MaterialIcons name="check-circle" size={20} color={primaryColor} />
            </View>
            <View style={styles.verificationContent}>
              <Text style={styles.verificationTitle}>Task Completion Verified</Text>
              <View style={styles.verificationList}>
                <View style={styles.verificationItem}>
                  <MaterialIcons name="check-small" size={18} color={primaryColor} />
                  <Text style={styles.verificationText}>Work completed as described</Text>
                </View>
                <View style={styles.verificationItem}>
                  <MaterialIcons name="check-small" size={18} color={primaryColor} />
                  <Text style={styles.verificationText}>Required proof verified</Text>
                </View>
                <View style={styles.verificationItem}>
                  <MaterialIcons name="check-small" size={18} color={primaryColor} />
                  <Text style={styles.verificationText}>Location & time confirmed</Text>
                </View>
              </View>
              <Text style={styles.verificationNote}>
                Verified automatically by HustleXP protocol
              </Text>
            </View>
          </View>
        </GlassCard>

        {/* Payment Card */}
        <GlassCard style={styles.paymentCard}>
          <View style={styles.paymentHeader}>
            <View>
              <Text style={styles.paymentLabel}>Payment</Text>
              <Text style={styles.paymentAmount}>${payoutAmount.toFixed(2)}</Text>
            </View>
            <View style={styles.currencyBadge}>
              <Text style={styles.currencyText}>USD</Text>
            </View>
          </View>
          <View style={styles.paymentStatus}>
            <MaterialIcons name="check-circle" size={16} color={primaryColor} />
            <Text style={styles.paymentStatusText}>Funds released from escrow</Text>
          </View>
        </GlassCard>

        {/* Proof Summary */}
        <GlassCard style={styles.proofCard}>
          <View style={styles.proofHeader}>
            <View>
              <Text style={styles.proofLabel}>Proof Verified</Text>
              <Text style={styles.proofValue}>{proofItemsVerified} items verified</Text>
            </View>
            <MaterialIcons name="chevron-right" size={20} color={colors.muted} />
          </View>
        </GlassCard>

        {/* Task Details */}
        <GlassCard>
          <Text style={styles.taskTitle}>{taskTitle}</Text>
          <Text style={styles.completedAt}>Completed on {completedAt}</Text>
          <Text style={styles.contractId}>Contract ID: {contractId}</Text>
        </GlassCard>
      </ScrollView>

      {/* Footer Actions */}
      <View style={styles.footer}>
        <PrimaryActionButton
          label="Leave Feedback"
          onPress={onLeaveFeedback || (() => {})}
        />
        <Text style={styles.footerHint}>Optional, helps maintain trust</Text>
        <View style={styles.supportSection}>
          <TouchableOpacity onPress={onReportIssue}>
            <Text style={styles.supportLink}>Report an issue</Text>
          </TouchableOpacity>
          <Text style={styles.supportHint}>
            Use only if something went wrong
          </Text>
        </View>
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
    paddingBottom: 200,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 8,
  },
  headerButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  headerLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    color: colors.muted,
    textTransform: 'uppercase',
  },
  completionStatus: {
    alignItems: 'center',
    marginBottom: spacing.section * 1.5,
    paddingTop: 24,
    paddingBottom: 32,
  },
  completionIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#13201c',
    borderWidth: 1,
    borderColor: 'rgba(52, 199, 89, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    shadowColor: '#34C759',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 40,
  },
  completionTitle: {
    fontSize: 36,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 8,
    textAlign: 'center',
  },
  completionSubtitle: {
    fontSize: 16,
    color: colors.muted,
    textAlign: 'center',
  },
  hustlerCard: {
    alignItems: 'center',
    padding: 24,
    marginBottom: spacing.section,
  },
  avatarContainer: {
    position: 'relative',
    marginBottom: 20,
  },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#34C759',
    borderWidth: 2,
    borderColor: 'rgba(52, 199, 89, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    fontSize: 32,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  verifiedBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#13201c',
    borderWidth: 1,
    borderColor: 'rgba(52, 199, 89, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hustlerName: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 16,
  },
  statsGrid: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
    maxWidth: 280,
    marginBottom: 20,
  },
  statCard: {
    flex: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  statValue: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statLabel: {
    fontSize: 10,
    fontWeight: '500',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  verifiedStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
  },
  verifiedDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#34C759',
  },
  verifiedText: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(52, 199, 89, 0.8)',
  },
  verificationHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16,
  },
  verificationIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: 'rgba(52, 199, 89, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(52, 199, 89, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  verificationContent: {
    flex: 1,
  },
  verificationTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textPrimary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 12,
  },
  verificationList: {
    gap: 12,
    marginBottom: 16,
  },
  verificationItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  verificationText: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  verificationNote: {
    fontSize: 12,
    fontStyle: 'italic',
    color: colors.muted,
    marginTop: 16,
  },
  paymentCard: {
    marginBottom: spacing.section,
  },
  paymentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  paymentLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  paymentAmount: {
    fontSize: 36,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  currencyBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  currencyText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  paymentStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  paymentStatusText: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(52, 199, 89, 0.9)',
  },
  proofCard: {
    marginBottom: spacing.section,
  },
  proofHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  proofLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  proofValue: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  taskTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 8,
  },
  completedAt: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 8,
    marginBottom: 8,
  },
  contractId: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
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
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
  },
  footerHint: {
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 12,
  },
  supportSection: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.05)',
    alignItems: 'center',
  },
  supportLink: {
    fontSize: 12,
    color: colors.muted,
    textDecorationLine: 'underline',
  },
  supportHint: {
    fontSize: 10,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 8,
    opacity: 0.5,
  },
});
