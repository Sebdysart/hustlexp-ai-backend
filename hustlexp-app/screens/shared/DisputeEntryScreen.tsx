/**
 * Screen: 13_DISPUTE_ENTRY
 * Spec: HUSTLEXP-DOCS/ui-specs/stitch-prompts/13-dispute-entry-LOCKED.md
 * Version: v1
 * Status: LOCKED
 * Variants: Poster, Hustler (different reason options, same structure)
 * Components (required): GlassCard, PrimaryActionButton, SectionHeader
 * Tokens (required): colors.json, spacing.json, typography.json
 */

import React, { useState } from 'react';
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

type DisputeVariant = 'poster' | 'hustler';

const POSTER_REASONS = [
  'Required deliverables missing',
  'Proof does not meet stated criteria',
  'Work deviates from task description',
  'Location or time verification mismatch',
  'System error (proof upload / verification failure)',
];

const HUSTLER_REASONS = [
  'Access not provided as described',
  'Task requirements changed after acceptance',
  'System verification error',
  'Safety issue prevented completion',
];

interface DisputeEntryScreenProps {
  variant: DisputeVariant;
  taskTitle: string;
  contractId: string;
  completedAt?: string;
  systemVerdict?: string;
  payoutAmount?: number;
  onBack?: () => void;
  onSubmit?: (dispute: {
    reason: string;
    evidence?: string[];
    certificationAccepted: boolean;
  }) => void;
  onCancel?: () => void;
}

export default function DisputeEntryScreen({
  variant,
  taskTitle,
  contractId,
  completedAt,
  systemVerdict,
  payoutAmount,
  onBack,
  onSubmit,
  onCancel,
}: DisputeEntryScreenProps) {
  const [selectedReason, setSelectedReason] = useState<string | null>(null);
  const [certificationAccepted, setCertificationAccepted] = useState(false);
  const [evidence, setEvidence] = useState<string[]>([]);

  const reasons = variant === 'poster' ? POSTER_REASONS : HUSTLER_REASONS;
  const primaryColor = variant === 'poster' ? '#1f6b7a' : '#42bcf0';
  const amberColor = '#FF9500';

  const canSubmit = selectedReason && certificationAccepted;

  const handleSubmit = () => {
    if (canSubmit && selectedReason) {
      onSubmit?.({
        reason: selectedReason,
        evidence,
        certificationAccepted,
      });
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Dispute Task Outcome</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Subtitle Context */}
        <Text style={styles.contextText}>
          Use this only if the task outcome is incorrect based on the agreed criteria.
        </Text>

        {/* Task Context (Read-Only) */}
        <GlassCard style={styles.taskContextCard}>
          <Text style={styles.taskTitle}>{taskTitle}</Text>
          <Text style={styles.taskMeta}>Contract ID: {contractId}</Text>
          {completedAt && (
            <Text style={styles.taskMeta}>Completion attempted on {completedAt}</Text>
          )}
          {systemVerdict && (
            <View style={styles.verdictRow}>
              <Text style={styles.verdictText}>System verdict: {systemVerdict}</Text>
            </View>
          )}
        </GlassCard>

        {/* Dispute Qualification (High Friction) */}
        <GlassCard style={styles.qualificationCard}>
          <View style={styles.warningRow}>
            <MaterialIcons name="warning" size={20} color={amberColor} />
            <Text style={styles.warningText}>
              Disputing triggers a manual review by HustleXP staff. This freezes funds and may delay payment release by up to 7 days.
            </Text>
          </View>
          <View style={styles.divider} />
          <TouchableOpacity
            style={styles.certificationRow}
            onPress={() => setCertificationAccepted(!certificationAccepted)}
          >
            <View style={styles.checkbox}>
              {certificationAccepted && (
                <MaterialIcons name="check" size={16} color={colors.textPrimary} />
              )}
            </View>
            <Text style={styles.certificationText}>
              I confirm that the selected issue is accurate and understand that false or unsupported disputes may reduce my future task eligibility.
            </Text>
          </TouchableOpacity>
          <Text style={styles.cooldownText}>
            You may submit one dispute per task. This action cannot be undone.
          </Text>
        </GlassCard>

        {/* Dispute Reason (Invariant-Mapped) */}
        <GlassCard>
          <SectionHeader title="Reason for Dispute" />
          <Text style={styles.reasonPrompt}>Which requirement was not met?</Text>
          <View style={styles.reasonsList}>
            {reasons.map((reason, index) => (
              <TouchableOpacity
                key={index}
                style={[
                  styles.reasonOption,
                  selectedReason === reason && styles.reasonOptionSelected,
                ]}
                onPress={() => setSelectedReason(reason)}
              >
                <View style={styles.radioButton}>
                  {selectedReason === reason && (
                    <View style={styles.radioButtonInner} />
                  )}
                </View>
                <Text
                  style={[
                    styles.reasonText,
                    selectedReason === reason && styles.reasonTextSelected,
                  ]}
                >
                  {reason}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </GlassCard>

        {/* Evidence Upload (Optional, Max 2) */}
        <GlassCard>
          <View style={styles.evidenceHeader}>
            <SectionHeader title="Supporting Evidence" />
            <Text style={styles.evidenceLimit}>Max 2 images</Text>
          </View>
          <View style={styles.evidenceGrid}>
            {[0, 1].map((index) => (
              <TouchableOpacity
                key={index}
                style={styles.evidenceSlot}
                onPress={() => {
                  // TODO: Open image picker
                }}
              >
                {evidence[index] ? (
                  <Image source={{ uri: evidence[index] }} style={styles.evidenceImage} />
                ) : (
                  <View style={styles.evidencePlaceholder}>
                    <MaterialIcons name="add-a-photo" size={20} color={colors.muted} />
                    <Text style={styles.evidencePlaceholderText}>
                      {index === 0 ? 'Add Photo' : 'Slot 2'}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </GlassCard>

        {/* Consequences Disclosure */}
        <View style={styles.consequencesCard}>
          <MaterialIcons name="shield" size={24} color={colors.muted} />
          <View style={styles.consequencesContent}>
            <Text style={styles.consequencesTitle}>Important:</Text>
            <View style={styles.consequencesList}>
              <Text style={styles.consequencesItem}>• Disputes pause XP and trust updates</Text>
              <Text style={styles.consequencesItem}>
                • Abuse may reduce future dispute eligibility
              </Text>
              <Text style={styles.consequencesItem}>
                • Most disputes resolve within 48 hours
              </Text>
              {variant === 'hustler' && (
                <Text style={styles.consequencesItem}>
                  • Successful disputes restore XP and trust
                </Text>
              )}
            </View>
          </View>
        </View>
      </ScrollView>

      {/* Footer Actions */}
      <View style={styles.footer}>
        <PrimaryActionButton
          label="Submit Dispute"
          onPress={handleSubmit}
          disabled={!canSubmit}
        />
        {onCancel && (
          <TouchableOpacity onPress={onCancel} style={styles.cancelButton}>
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  placeholder: {
    width: 40,
  },
  contextText: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
    marginBottom: spacing.section,
    paddingHorizontal: 16,
    lineHeight: 20,
  },
  taskContextCard: {
    marginBottom: spacing.section,
  },
  taskTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  taskMeta: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 4,
  },
  verdictRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  verdictText: {
    fontSize: 12,
    color: colors.muted,
  },
  qualificationCard: {
    marginBottom: spacing.section,
  },
  warningRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 16,
  },
  warningText: {
    flex: 1,
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    marginVertical: 16,
  },
  certificationRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.muted,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  certificationText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: colors.textPrimary,
    lineHeight: 20,
  },
  cooldownText: {
    fontSize: 11,
    fontStyle: 'italic',
    color: colors.muted,
    marginTop: 12,
    marginLeft: 32,
  },
  reasonPrompt: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 16,
    marginTop: 8,
  },
  reasonsList: {
    gap: 4,
  },
  reasonOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    marginBottom: 4,
  },
  reasonOptionSelected: {
    backgroundColor: 'rgba(31, 107, 122, 0.1)',
    borderColor: 'rgba(31, 107, 122, 0.3)',
  },
  radioButton: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioButtonInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#1f6b7a',
  },
  reasonText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  reasonTextSelected: {
    color: '#1f6b7a',
  },
  evidenceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: 16,
  },
  evidenceLimit: {
    fontSize: 12,
    color: colors.muted,
  },
  evidenceGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  evidenceSlot: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.muted,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  evidenceImage: {
    width: '100%',
    height: '100%',
  },
  evidencePlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  evidencePlaceholderText: {
    fontSize: 12,
    color: colors.muted,
  },
  consequencesCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16,
    backgroundColor: '#1c1f24',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#27272a',
    marginTop: spacing.section,
  },
  consequencesContent: {
    flex: 1,
  },
  consequencesTitle: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: 8,
  },
  consequencesList: {
    gap: 4,
  },
  consequencesItem: {
    fontSize: 12,
    color: colors.muted,
    lineHeight: 18,
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
  cancelButton: {
    marginTop: 12,
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 14,
    color: colors.muted,
    textDecorationLine: 'underline',
  },
});
