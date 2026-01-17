/**
 * Screen: 09_HUSTLER_TASK_COMPLETION
 * Spec: HUSTLEXP-DOCS/ui-specs/stitch-prompts/09-hustler-task-completion-LOCKED.md
 * Version: v1
 * Status: LOCKED
 * States: APPROVED, ACTION_REQUIRED, BLOCKED
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
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { GlassCard } from '../../ui/GlassCard';
import { PrimaryActionButton } from '../../ui/PrimaryActionButton';
import { SectionHeader } from '../../ui/SectionHeader';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';

type CompletionState = 'APPROVED' | 'ACTION_REQUIRED' | 'BLOCKED';

interface RejectionReason {
  icon: string;
  title: string;
  description?: string;
}

interface TaskCompletionScreenProps {
  taskTitle: string;
  taskId: string;
  contractId: string;
  state: CompletionState;
  rejectionReasons?: RejectionReason[];
  xpAmount?: number;
  xpBreakdown?: Array<{ label: string; amount: number }>;
  xpWithheldReason?: string;
  payoutAmount: number;
  payoutStatus: 'PENDING' | 'BLOCKED' | 'APPROVED';
  proofImageUrl?: string;
  onFixProof?: () => void;
  onFinishTask?: () => void;
  onViewIssueDetails?: () => void;
  onContactSupport?: () => void;
}

export default function TaskCompletionScreen({
  taskTitle,
  taskId,
  contractId,
  state,
  rejectionReasons = [],
  xpAmount = 0,
  xpBreakdown = [],
  xpWithheldReason,
  payoutAmount,
  payoutStatus,
  proofImageUrl,
  onFixProof,
  onFinishTask,
  onViewIssueDetails,
  onContactSupport,
}: TaskCompletionScreenProps) {
  const isApproved = state === 'APPROVED';
  const isActionRequired = state === 'ACTION_REQUIRED';
  const isBlocked = state === 'BLOCKED';

  const primaryColor = isApproved
    ? '#33c758'
    : isActionRequired
    ? '#FF9500'
    : '#ff3c2e';

  const statusBadgeText = isApproved
    ? 'COMPLETION APPROVED'
    : isActionRequired
    ? 'ACTION REQUIRED'
    : 'COMPLETION BLOCKED';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          {isBlocked && (
            <View style={styles.headerTop}>
              <TouchableOpacity>
                <MaterialIcons name="arrow-back" size={24} color={colors.textPrimary} />
              </TouchableOpacity>
              <Text style={styles.headerTitle}>Task #{taskId} Review</Text>
              <TouchableOpacity>
                <MaterialIcons name="help-outline" size={24} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>
          )}

          <View
            style={[
              styles.statusBadge,
              { backgroundColor: `${primaryColor}20`, borderColor: `${primaryColor}50` },
            ]}
          >
            <MaterialIcons
              name={isApproved ? 'check-circle' : isActionRequired ? 'warning' : 'block'}
              size={18}
              color={primaryColor}
            />
            <Text style={[styles.statusBadgeText, { color: primaryColor }]}>
              {statusBadgeText}
            </Text>
          </View>

          <Text style={styles.title}>
            {isApproved && 'Task requirements met 100%'}
            {isActionRequired && (
              <>
                Proof needs{'\n'}
                <Text style={{ color: colors.muted }}>correction</Text>
              </>
            )}
            {isBlocked && (
              <>
                Completion criteria{'\n'}
                not satisfied
              </>
            )}
          </Text>

          {!isApproved && (
            <Text style={styles.subtitle}>
              {isActionRequired
                ? 'Please review the feedback below and update your submission to unlock your rewards.'
                : 'This task cannot be finalized due to missing requirements.'}
            </Text>
          )}
        </View>

        {/* Proof Review Section (ACTION_REQUIRED only) */}
        {isActionRequired && rejectionReasons.length > 0 && (
          <View style={styles.proofReviewSection}>
            <View style={styles.proofImageContainer}>
              {proofImageUrl && (
                <Image
                  source={{ uri: proofImageUrl }}
                  style={styles.proofImage}
                  resizeMode="cover"
                />
              )}
              <View style={styles.proofImageOverlay} />
              <View style={styles.rejectionReasons}>
                <View style={styles.rejectionHeader}>
                  <View style={[styles.rejectionIcon, { backgroundColor: `${primaryColor}20` }]}>
                    <MaterialIcons name="gpp-bad" size={32} color={primaryColor} />
                  </View>
                  <View>
                    <Text style={styles.rejectionTitle}>Rejection Reasons</Text>
                    <Text style={styles.rejectionSubtitle}>Review carefully</Text>
                  </View>
                </View>
                <View style={styles.reasonsList}>
                  {rejectionReasons.map((reason, index) => (
                    <View key={index}>
                      {index > 0 && <View style={styles.reasonDivider} />}
                      <View style={styles.reasonItem}>
                        <MaterialIcons
                          name={reason.icon as any}
                          size={18}
                          color={primaryColor}
                        />
                        <View style={styles.reasonContent}>
                          <Text style={styles.reasonTitle}>{reason.title}</Text>
                          {reason.description && (
                            <Text style={styles.reasonDescription}>
                              {reason.description}
                            </Text>
                          )}
                        </View>
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            </View>
          </View>
        )}

        {/* Blocked State - Verification Failed */}
        {isBlocked && (
          <GlassCard style={styles.verificationCard}>
            <View style={styles.verificationHeader}>
              <View style={[styles.verificationIcon, { backgroundColor: `${primaryColor}10` }]}>
                <MaterialIcons name="gpp-bad" size={28} color={primaryColor} />
              </View>
              <View style={styles.verificationContent}>
                <View style={styles.verificationTitleRow}>
                  <Text style={styles.verificationTitle}>Verification Failed</Text>
                  <View style={[styles.actionBadge, { backgroundColor: `${primaryColor}10` }]}>
                    <Text style={[styles.actionBadgeText, { color: primaryColor }]}>
                      Action Required
                    </Text>
                  </View>
                </View>
                <Text style={styles.verificationDescription}>
                  The submitted evidence does not meet the specified standards for this campaign.
                </Text>
                <View style={styles.blockedReasons}>
                  {rejectionReasons.map((reason, index) => (
                    <View key={index} style={styles.blockedReasonItem}>
                      <MaterialIcons name="cancel" size={18} color={primaryColor} />
                      <Text style={styles.blockedReasonText}>{reason.title}</Text>
                    </View>
                  ))}
                </View>
              </View>
            </View>
          </GlassCard>
        )}

        {/* XP & Payout Cards */}
        <View style={styles.outcomesGrid}>
          {/* XP Card */}
          <GlassCard style={styles.outcomeCard}>
            <Text style={styles.outcomeLabel}>XP Status</Text>
            {isApproved ? (
              <>
                <View style={styles.outcomeHeader}>
                  <Text style={[styles.outcomeValue, { color: primaryColor }]}>
                    +{xpAmount} XP
                  </Text>
                  <View style={styles.trophyIcon}>
                    <MaterialIcons name="emoji-events" size={24} color={colors.muted} />
                  </View>
                </View>
                {xpBreakdown.length > 0 && (
                  <>
                    <View style={styles.outcomeDivider} />
                    <View style={styles.breakdownList}>
                      {xpBreakdown.map((item, index) => (
                        <View key={index} style={styles.breakdownItem}>
                          <View style={styles.breakdownDot} />
                          <Text style={styles.breakdownLabel}>{item.label}</Text>
                          <Text style={styles.breakdownAmount}>+{item.amount} XP</Text>
                        </View>
                      ))}
                    </View>
                  </>
                )}
              </>
            ) : (
              <>
                <View style={styles.outcomeHeader}>
                  <Text style={[styles.outcomeValue, { color: colors.muted }]}>
                    {isBlocked ? 'Withheld' : `${xpAmount} XP`}
                  </Text>
                  {isActionRequired && (
                    <View style={[styles.statusChip, { backgroundColor: 'rgba(255,255,255,0.1)' }]}>
                      <Text style={styles.statusChipText}>PAUSED</Text>
                    </View>
                  )}
                </View>
                <View style={styles.outcomeHint}>
                  <MaterialIcons
                    name={isActionRequired ? 'info' : 'block'}
                    size={14}
                    color={primaryColor}
                  />
                  <Text style={[styles.outcomeHintText, { color: primaryColor }]}>
                    {isActionRequired
                      ? 'Resubmit to unlock'
                      : xpWithheldReason || 'Criteria not met'}
                  </Text>
                </View>
              </>
            )}
          </GlassCard>

          {/* Payout Card */}
          <GlassCard style={styles.outcomeCard}>
            <Text style={styles.outcomeLabel}>Payout</Text>
            <View style={styles.outcomeHeader}>
              <Text style={[styles.outcomeValue, { color: isApproved ? colors.textPrimary : colors.muted }]}>
                ${payoutAmount.toFixed(2)}
              </Text>
              {!isApproved && (
                <View
                  style={[
                    styles.statusChip,
                    { backgroundColor: `${primaryColor}20` },
                  ]}
                >
                  <Text style={[styles.statusChipText, { color: primaryColor }]}>
                    {payoutStatus}
                  </Text>
                </View>
              )}
            </View>
            {isApproved ? (
              <View style={styles.escrowStatus}>
                <MaterialIcons name="hourglass-top" size={14} color={colors.muted} />
                <Text style={styles.escrowStatusText}>Escrow release pending</Text>
              </View>
            ) : (
              <View style={styles.outcomeHint}>
                <MaterialIcons name="block" size={14} color={primaryColor} />
                <Text style={[styles.outcomeHintText, { color: primaryColor }]}>
                  Pending resolution
                </Text>
              </View>
            )}
          </GlassCard>
        </View>

        {/* Approved State - Proof Verification */}
        {isApproved && (
          <GlassCard>
            <View style={styles.verificationSuccess}>
              <View style={[styles.verificationIcon, { backgroundColor: `${primaryColor}10` }]}>
                <MaterialIcons name="verified-user" size={24} color={primaryColor} />
              </View>
              <View>
                <Text style={styles.verificationTitle}>All required criteria verified</Text>
                <Text style={styles.verificationSubtitle}>
                  Auto-verified by HustleXP Protocol
                </Text>
              </View>
            </View>
          </GlassCard>
        )}

        {/* Blocked State - Proof Preview */}
        {isBlocked && proofImageUrl && (
          <View style={styles.proofPreview}>
            <Image
              source={{ uri: proofImageUrl }}
              style={styles.proofPreviewImage}
              resizeMode="cover"
            />
            <View style={styles.proofPreviewInfo}>
              <Text style={styles.proofPreviewName}>Submission_v3_Final.jpg</Text>
              <Text style={styles.proofPreviewDate}>Uploaded 2 hours ago</Text>
            </View>
            <MaterialIcons name="visibility" size={20} color={colors.muted} />
          </View>
        )}
      </ScrollView>

      {/* Footer Actions */}
      <View style={styles.footer}>
        {isApproved && (
          <>
            <PrimaryActionButton
              label="Finish Task"
              onPress={onFinishTask || (() => {})}
            />
            <Text style={styles.footerHint}>
              This will finalize the task and release escrow.
            </Text>
            <Text style={styles.footerSubHint}>
              Escrow will be released after poster confirmation
            </Text>
          </>
        )}

        {isActionRequired && (
          <>
            <PrimaryActionButton
              label="Fix Proof Issues"
              onPress={onFixProof || (() => {})}
            />
            <Text style={styles.footerHint}>
              Resubmit proof to complete task
            </Text>
            <Text style={styles.footerSubHint}>
              You may resubmit proof <Text style={{ fontWeight: '700' }}>once</Text> for this requirement.
            </Text>
            <View style={styles.supportSection}>
              <TouchableOpacity onPress={onContactSupport}>
                <Text style={styles.supportLink}>Contact Support</Text>
              </TouchableOpacity>
              <Text style={styles.supportHint}>
                Use only if you believe this decision is incorrect
              </Text>
            </View>
          </>
        )}

        {isBlocked && (
          <>
            <TouchableOpacity
              style={[styles.secondaryButton, { borderColor: primaryColor }]}
              onPress={onViewIssueDetails}
            >
              <MaterialIcons name="report-problem" size={20} color={primaryColor} />
              <Text style={[styles.secondaryButtonText, { color: primaryColor }]}>
                View Issue Details
              </Text>
            </TouchableOpacity>
            <View style={styles.supportSection}>
              <Text style={styles.supportHint}>
                If you believe this is a system error,
              </Text>
              <TouchableOpacity onPress={onContactSupport}>
                <Text style={styles.supportLink}>contact support</Text>
              </TouchableOpacity>
              <Text style={styles.supportSubHint}>
                Use only if you believe this decision is incorrect
              </Text>
            </View>
          </>
        )}
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
    alignItems: 'center',
    marginBottom: spacing.section,
    paddingTop: 32,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    marginBottom: 24,
    paddingHorizontal: 16,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
    textTransform: 'uppercase',
    opacity: 0.8,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    marginBottom: 20,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  title: {
    fontSize: 36,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center',
    lineHeight: 40,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
    maxWidth: 300,
    marginTop: 8,
  },
  proofReviewSection: {
    marginBottom: spacing.section,
    borderRadius: 16,
    overflow: 'hidden',
  },
  proofImageContainer: {
    height: 400,
    position: 'relative',
  },
  proofImage: {
    width: '100%',
    height: '100%',
  },
  proofImageOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.85)',
  },
  rejectionReasons: {
    ...StyleSheet.absoluteFillObject,
    padding: 24,
    justifyContent: 'flex-end',
  },
  rejectionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16,
    marginBottom: 16,
  },
  rejectionIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  rejectionSubtitle: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  reasonsList: {
    backgroundColor: 'rgba(50, 38, 23, 0.8)',
    backdropFilter: 'blur(12px)',
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  reasonItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  reasonContent: {
    flex: 1,
  },
  reasonTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  reasonDescription: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 4,
  },
  reasonDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    marginVertical: 12,
  },
  verificationCard: {
    marginBottom: spacing.section,
  },
  verificationHeader: {
    flexDirection: 'row',
    gap: 16,
  },
  verificationIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verificationContent: {
    flex: 1,
  },
  verificationTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  verificationTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  actionBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  actionBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  verificationDescription: {
    fontSize: 14,
    color: colors.muted,
    marginBottom: 16,
  },
  blockedReasons: {
    backgroundColor: '#1c1f24',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#27272a',
    gap: 8,
  },
  blockedReasonItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  blockedReasonText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  outcomesGrid: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: spacing.section,
  },
  outcomeCard: {
    flex: 1,
    minHeight: 140,
  },
  outcomeLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 12,
  },
  outcomeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  outcomeValue: {
    fontSize: 36,
    fontWeight: '700',
    lineHeight: 40,
  },
  trophyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  outcomeDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    marginVertical: 12,
  },
  breakdownList: {
    gap: 12,
  },
  breakdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  breakdownDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.muted,
  },
  breakdownLabel: {
    flex: 1,
    fontSize: 14,
    color: colors.textSecondary,
  },
  breakdownAmount: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  statusChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  statusChipText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  outcomeHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  outcomeHintText: {
    fontSize: 12,
    fontWeight: '500',
  },
  escrowStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.05)',
  },
  escrowStatusText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  verificationSuccess: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16,
  },
  verificationSubtitle: {
    fontSize: 14,
    color: '#33c758',
    marginTop: 4,
  },
  proofPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#1c1f24',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#27272a',
    marginBottom: spacing.section,
    opacity: 0.6,
  },
  proofPreviewImage: {
    width: 48,
    height: 48,
    borderRadius: 8,
  },
  proofPreviewInfo: {
    flex: 1,
  },
  proofPreviewName: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  proofPreviewDate: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 2,
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
    fontWeight: '500',
    color: colors.muted,
    textAlign: 'center',
    marginTop: 12,
  },
  footerSubHint: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.muted,
    textAlign: 'center',
    marginTop: 4,
    fontStyle: 'italic',
    opacity: 0.8,
  },
  secondaryButton: {
    width: '100%',
    height: 56,
    borderWidth: 1,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: '700',
  },
  supportSection: {
    marginTop: 24,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.05)',
    alignItems: 'center',
  },
  supportLink: {
    fontSize: 12,
    color: colors.muted,
    textDecorationLine: 'underline',
    marginTop: 4,
  },
  supportHint: {
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center',
    marginBottom: 4,
  },
  supportSubHint: {
    fontSize: 10,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 8,
    opacity: 0.5,
  },
});
