/**
 * Screen: 08_HUSTLER_TASK_IN_PROGRESS
 * Spec: HUSTLEXP-DOCS/ui-specs/stitch-prompts/08-hustler-task-in-progress-LOCKED.md
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

interface TaskStep {
  id: string;
  label: string;
  status: 'completed' | 'active' | 'pending';
  gpsVerified?: boolean;
  gpsTimestamp?: string;
}

interface TaskInProgressScreenProps {
  taskTitle: string;
  taskId: string;
  status: 'EN_ROUTE' | 'WORKING';
  timeRemaining: string; // "00:42:00"
  timeProgress: number; // 0-1
  steps: TaskStep[];
  contractId: string;
  proofRequirements: string[];
  proofRules: string;
  location: string;
  riskLevel: 'Low' | 'Medium' | 'High';
  trustTier: string;
  instantMode?: boolean;
  onCaptureProof?: () => void;
  onReportIssue?: () => void;
}

export default function TaskInProgressScreen({
  taskTitle,
  taskId,
  status,
  timeRemaining,
  timeProgress,
  steps,
  contractId,
  proofRequirements,
  proofRules,
  location,
  riskLevel,
  trustTier,
  instantMode = false,
  onCaptureProof,
  onReportIssue,
}: TaskInProgressScreenProps) {
  const amberColor = '#FF9500';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Status Header */}
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <View style={styles.statusBadge}>
              <Text style={styles.statusBadgeText}>WORKING</Text>
              <View style={styles.statusPulse} />
            </View>
            <TouchableOpacity>
              <MaterialIcons name="more-horiz" size={20} color={colors.muted} />
            </TouchableOpacity>
          </View>
          <Text style={styles.title}>{taskTitle}</Text>
          <View style={styles.headerBadges}>
            <MaterialIcons name="verified-user" size={16} color={colors.muted} />
            <Text style={styles.headerBadgeText}>
              {instantMode ? 'Instant task' : 'Escrow protected'}
            </Text>
          </View>
        </View>

        {/* Time Authority Bar */}
        <View style={styles.timeSection}>
          <View style={styles.timeHeader}>
            <Text style={styles.timeLabel}>TIME REMAINING</Text>
            <View style={styles.timeDisplay}>
              <MaterialIcons name="timer" size={18} color={amberColor} />
              <Text style={styles.timeText}>{timeRemaining}</Text>
            </View>
          </View>
          <View style={styles.progressBar}>
            <View
              style={[
                styles.progressFill,
                { width: `${timeProgress * 100}%` },
              ]}
            />
          </View>
        </View>

        {/* Task Checklist */}
        <View style={styles.stepsSection}>
          <SectionHeader title="Required Steps" />
          <View style={styles.stepsContainer}>
            {steps.map((step, index) => (
              <View key={step.id} style={styles.stepContainer}>
                <View style={styles.stepLine} />
                <View style={styles.stepIconContainer}>
                  {step.status === 'completed' && (
                    <MaterialIcons
                      name="check-circle"
                      size={24}
                      color="#33c758"
                    />
                  )}
                  {step.status === 'active' && (
                    <View style={styles.activeStepIcon}>
                      <MaterialIcons
                        name="radio-button-checked"
                        size={24}
                        color={amberColor}
                      />
                    </View>
                  )}
                  {step.status === 'pending' && (
                    <MaterialIcons
                      name="radio-button-unchecked"
                      size={24}
                      color={colors.muted}
                    />
                  )}
                </View>
                <View style={styles.stepContent}>
                  <Text
                    style={[
                      styles.stepLabel,
                      step.status === 'completed' && styles.stepLabelCompleted,
                      step.status === 'active' && styles.stepLabelActive,
                      step.status === 'pending' && styles.stepLabelPending,
                    ]}
                  >
                    {step.label}
                  </Text>
                  {step.gpsVerified && step.gpsTimestamp && (
                    <View style={styles.gpsVerified}>
                      <MaterialIcons
                        name="location-on"
                        size={12}
                        color={colors.muted}
                      />
                      <Text style={styles.gpsText}>
                        GPS Verified: {step.gpsTimestamp}
                      </Text>
                    </View>
                  )}
                  {step.status === 'active' && (
                    <View style={styles.activeIndicator}>
                      <View style={styles.activeDot} />
                      <Text style={styles.activeText}>Action required</Text>
                    </View>
                  )}
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* Proof Upload Module (Highlighted) */}
        <View style={styles.proofCard}>
          <View style={styles.proofHeader}>
            <View>
              <Text style={styles.proofTitle}>In-Progress Proof Required</Text>
              <Text style={styles.contractId}>Contract ID: {contractId}</Text>
            </View>
            <View style={styles.proofIcon}>
              <MaterialIcons name="fact-check" size={22} color={amberColor} />
            </View>
          </View>

          <View style={styles.proofBadges}>
            <View style={styles.proofBadge}>
              <Text style={styles.proofBadgeText}>📍 On-site only</Text>
            </View>
            <View style={styles.proofBadge}>
              <Text style={styles.proofBadgeText}>⏱ During work window</Text>
            </View>
            <View style={styles.proofBadge}>
              <Text style={styles.proofBadgeText}>📸 Rear camera</Text>
            </View>
            <View style={[styles.proofBadge, styles.proofBadgeVerified]}>
              <Text style={styles.proofBadgeTextVerified}>🔒 Verified</Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.proofRequirements}>
            <SectionHeader title="What must be visible" />
            {proofRequirements.map((req, index) => (
              <View key={index} style={styles.requirementItem}>
                <MaterialIcons name="check-small" size={16} color="#33c758" />
                <Text style={styles.requirementText}>{req}</Text>
              </View>
            ))}
          </View>

          <View style={styles.proofRules}>
            <SectionHeader title="Rules" />
            <Text style={styles.proofRulesText}>{proofRules}</Text>
          </View>

          <View style={styles.proofWarning}>
            <MaterialIcons name="warning" size={18} color={amberColor} />
            <Text style={styles.proofWarningText}>
              Missing or unclear proof may delay completion or affect XP.
            </Text>
          </View>

          <PrimaryActionButton
            label="Capture Required Photo"
            onPress={onCaptureProof || (() => {})}
          />
        </View>

        {/* Task Details Grid */}
        <View style={styles.detailsGrid}>
          <View style={styles.detailCard}>
            <MaterialIcons name="near-me" size={20} color={colors.muted} />
            <Text style={styles.detailLabel}>LOCATION</Text>
            <Text style={styles.detailValue}>On-site</Text>
          </View>
          <View style={styles.detailCard}>
            <MaterialIcons name="shield" size={20} color={colors.muted} />
            <Text style={styles.detailLabel}>RISK</Text>
            <Text
              style={[
                styles.detailValue,
                riskLevel === 'Low' && { color: '#33c758' },
              ]}
            >
              {riskLevel}
            </Text>
          </View>
          <View style={styles.detailCard}>
            <MaterialIcons name="workspace-premium" size={20} color={colors.muted} />
            <Text style={styles.detailLabel}>TIER</Text>
            <Text style={[styles.detailValue, { color: '#FFD700' }]}>
              {trustTier}
            </Text>
          </View>
        </View>
      </ScrollView>

      {/* Support Footer */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={styles.reportButton}
          onPress={onReportIssue}
        >
          <MaterialIcons name="flag" size={14} color={colors.muted} />
          <Text style={styles.reportText}>Report an issue</Text>
        </TouchableOpacity>
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
    paddingBottom: 80,
  },
  header: {
    marginBottom: spacing.section * 1.5,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 149, 0, 0.3)',
    backgroundColor: 'rgba(255, 149, 0, 0.1)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    color: '#FF9500',
    textTransform: 'uppercase',
  },
  statusPulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FF9500',
    opacity: 0.8,
  },
  title: {
    fontSize: 30,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 8,
  },
  headerBadges: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    opacity: 0.8,
  },
  headerBadgeText: {
    fontSize: 14,
    color: colors.muted,
  },
  timeSection: {
    marginBottom: spacing.section * 1.5,
  },
  timeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: 12,
  },
  timeLabel: {
    fontSize: 10,
    fontWeight: '500',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
  },
  timeDisplay: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  timeText: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  progressBar: {
    height: 6,
    backgroundColor: '#1c1c1e',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#FF9500',
    borderRadius: 3,
  },
  stepsSection: {
    marginBottom: spacing.section * 1.5,
  },
  stepsContainer: {
    position: 'relative',
    paddingLeft: 40,
  },
  stepContainer: {
    flexDirection: 'row',
    gap: 16,
    marginBottom: 32,
    position: 'relative',
  },
  stepLine: {
    position: 'absolute',
    left: 11,
    top: 34,
    bottom: -16,
    width: 2,
    backgroundColor: '#27272a',
  },
  stepIconContainer: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  activeStepIcon: {
    shadowColor: '#FF9500',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 15,
  },
  stepContent: {
    flex: 1,
    paddingTop: 2,
  },
  stepLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  stepLabelCompleted: {
    textDecorationLine: 'line-through',
    color: colors.muted,
  },
  stepLabelActive: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  stepLabelPending: {
    color: colors.muted,
  },
  gpsVerified: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  gpsText: {
    fontSize: 11,
    color: colors.muted,
    fontFamily: 'monospace',
  },
  activeIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FF9500',
  },
  activeText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#FF9500',
  },
  proofCard: {
    backgroundColor: colors.glassPrimary,
    borderRadius: 12,
    padding: 20,
    borderWidth: 2,
    borderColor: '#FF9500',
    marginBottom: spacing.section * 1.5,
  },
  proofHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  proofTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  contractId: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  proofIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 149, 0, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255, 149, 0, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  proofBadges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  proofBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  proofBadgeVerified: {
    backgroundColor: 'rgba(255, 149, 0, 0.1)',
    borderColor: 'rgba(255, 149, 0, 0.2)',
  },
  proofBadgeText: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: colors.textSecondary,
  },
  proofBadgeTextVerified: {
    color: '#FF9500',
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    marginVertical: 16,
  },
  proofRequirements: {
    marginBottom: 16,
  },
  requirementItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 8,
  },
  requirementText: {
    fontSize: 14,
    fontWeight: '300',
    color: colors.textSecondary,
    flex: 1,
  },
  proofRules: {
    marginBottom: 12,
  },
  proofRulesText: {
    fontSize: 14,
    fontWeight: '300',
    color: colors.textSecondary,
    lineHeight: 20,
  },
  proofWarning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: '#1c1c1e',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  proofWarningText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.muted,
    flex: 1,
  },
  detailsGrid: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: spacing.section,
  },
  detailCard: {
    flex: 1,
    backgroundColor: colors.glassPrimary,
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 96,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  detailLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginTop: 6,
    marginBottom: 4,
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingBottom: 24,
    backgroundColor: colors.background,
  },
  reportButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  reportText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
});
