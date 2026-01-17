/**
 * Screen: 11_POSTER_FEEDBACK
 * Spec: HUSTLEXP-DOCS/ui-specs/stitch-prompts/11-poster-feedback-LOCKED.md
 * Version: v1
 * Status: LOCKED
 * Components (required): GlassCard, PrimaryActionButton, SectionHeader
 * Tokens (required): colors.json, spacing.json, typography.json
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { GlassCard } from '../../ui/GlassCard';
import { PrimaryActionButton } from '../../ui/PrimaryActionButton';
import { SectionHeader } from '../../ui/SectionHeader';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';

interface Criterion {
  id: string;
  label: string;
}

interface FeedbackScreenProps {
  taskTitle: string;
  contractId: string;
  criteria?: Criterion[];
  onConfirm?: (feedback: {
    criteria: Record<string, 'yes' | 'no'>;
    satisfaction?: number;
    comment?: string;
  }) => void;
  onSkip?: () => void;
}

export default function FeedbackScreen({
  taskTitle = 'Site Survey: Sector 4',
  contractId = '#820-A4',
  criteria = [
    { id: 'work_completed', label: 'Work completed as described' },
    { id: 'areas_covered', label: 'Required areas were covered' },
    { id: 'no_issues', label: 'No issues encountered' },
  ],
  onConfirm,
  onSkip,
}: FeedbackScreenProps) {
  const [showGate, setShowGate] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [criterionAnswers, setCriterionAnswers] = useState<Record<string, 'yes' | 'no'>>({});
  const [satisfaction, setSatisfaction] = useState<number | null>(null);
  const [comment, setComment] = useState('');

  const handleInitialConfirm = () => {
    setShowGate(true);
  };

  const handleGateContinue = () => {
    setShowGate(false);
    setShowForm(true);
  };

  const handleGateSkip = () => {
    setShowGate(false);
    onSkip?.();
  };

  const handleCriterionChange = (id: string, value: 'yes' | 'no') => {
    setCriterionAnswers({ ...criterionAnswers, [id]: value });
  };

  const handleSubmit = () => {
    onConfirm?.({
      criteria: criterionAnswers,
      satisfaction: satisfaction || undefined,
      comment: comment.trim() || undefined,
    });
  };

  const canSubmit = criteria.every(c => criterionAnswers[c.id] !== undefined);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {!showForm && !showGate && (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Confirm Task Outcome</Text>
            <Text style={styles.subtitle}>
              Your feedback helps keep the system accurate
            </Text>
          </View>
        </ScrollView>
      )}

      {/* Feedback Gate Modal */}
      <Modal
        visible={showGate}
        transparent
        animationType="fade"
        onRequestClose={handleGateSkip}
      >
        <View style={styles.modalOverlay}>
          <GlassCard style={styles.modalCard}>
            <Text style={styles.modalTitle}>Confirm Outcome</Text>
            <Text style={styles.modalText}>
              Your feedback is about the task — not the person. Payment is already complete.
            </Text>
            <View style={styles.modalActions}>
              <PrimaryActionButton
                label="Continue"
                onPress={handleGateContinue}
              />
              <TouchableOpacity onPress={handleGateSkip} style={styles.skipButton}>
                <Text style={styles.skipButtonText}>Skip feedback</Text>
              </TouchableOpacity>
            </View>
          </GlassCard>
        </View>
      </Modal>

      {/* Feedback Form */}
      {showForm && (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Confirm Task Outcome</Text>
            <Text style={styles.subtitle}>
              Your feedback helps keep the system accurate
            </Text>
          </View>

          {/* Task Summary (Identity Suppressed) */}
          <GlassCard>
            <Text style={styles.taskTitle}>{taskTitle}</Text>
            <Text style={styles.contractId}>{contractId}</Text>
          </GlassCard>

          {/* Criteria Confirmation */}
          <GlassCard>
            <Text style={styles.criteriaTitle}>
              Did the task meet the agreed criteria?
            </Text>
            <View style={styles.criteriaList}>
              {criteria.map((criterion, index) => (
                <View key={criterion.id} style={styles.criterionItem}>
                  {index > 0 && <View style={styles.criterionDivider} />}
                  <Text style={styles.criterionLabel}>{criterion.label}</Text>
                  <View style={styles.criterionControls}>
                    <TouchableOpacity
                      style={[
                        styles.criterionButton,
                        criterionAnswers[criterion.id] === 'yes' && styles.criterionButtonActive,
                      ]}
                      onPress={() => handleCriterionChange(criterion.id, 'yes')}
                    >
                      <Text
                        style={[
                          styles.criterionButtonText,
                          criterionAnswers[criterion.id] === 'yes' && styles.criterionButtonTextActive,
                        ]}
                      >
                        Yes
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.criterionButton,
                        styles.criterionButtonNo,
                        criterionAnswers[criterion.id] === 'no' && styles.criterionButtonNoActive,
                      ]}
                      onPress={() => handleCriterionChange(criterion.id, 'no')}
                    >
                      <Text
                        style={[
                          styles.criterionButtonText,
                          criterionAnswers[criterion.id] === 'no' && styles.criterionButtonTextActive,
                        ]}
                      >
                        No
                      </Text>
                    </TouchableOpacity>
                  </View>
                  {criterionAnswers[criterion.id] === 'no' && (
                    <Text style={styles.criterionWarning}>
                      Selecting 'No' may trigger a system review.
                    </Text>
                  )}
                </View>
              ))}
            </View>
          </GlassCard>

          {/* Overall Satisfaction (Optional) */}
          <GlassCard>
            <SectionHeader title="Overall experience" />
            <View style={styles.satisfactionScale}>
              {[1, 2, 3, 4, 5].map((value) => (
                <TouchableOpacity
                  key={value}
                  style={styles.satisfactionIcon}
                  onPress={() => setSatisfaction(value)}
                >
                  <MaterialIcons
                    name={satisfaction && value <= satisfaction ? 'circle' : 'radio-button-unchecked'}
                    size={32}
                    color={satisfaction && value <= satisfaction ? '#34C759' : colors.muted}
                  />
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.satisfactionHint}>
              This does not affect payment. Outlier feedback may be reviewed automatically.
            </Text>
          </GlassCard>

          {/* Optional Comment */}
          <GlassCard variant="secondary">
            <SectionHeader title="Optional note" />
            <TextInput
              style={styles.commentInput}
              placeholder="Visible to system moderators only"
              placeholderTextColor={colors.muted}
              multiline
              numberOfLines={4}
              value={comment}
              onChangeText={setComment}
              maxLength={240}
            />
            <Text style={styles.commentCounter}>
              {comment.length} / 240
            </Text>
          </GlassCard>

          {/* Trust Impact Disclosure */}
          <GlassCard>
            <View style={styles.trustDisclosure}>
              <MaterialIcons name="shield" size={20} color={colors.muted} />
              <Text style={styles.trustDisclosureText}>
                Ratings are weighted by task type, risk level, and verification status. Outlier feedback may be reviewed automatically.
              </Text>
            </View>
          </GlassCard>
        </ScrollView>
      )}

      {/* Footer Actions */}
      <View style={styles.footer}>
        {!showForm && !showGate && (
          <>
            <PrimaryActionButton
              label="Confirm Task Outcome"
              onPress={handleInitialConfirm}
            />
            <Text style={styles.footerHint}>
              Optional — helps improve matching accuracy
            </Text>
          </>
        )}

        {showForm && (
          <>
            <PrimaryActionButton
              label="Submit Confirmation"
              onPress={handleSubmit}
              disabled={!canSubmit}
            />
            <Text style={styles.footerHint}>
              This will finalize feedback for this task.
            </Text>
            <TouchableOpacity onPress={onSkip} style={styles.skipButton}>
              <Text style={styles.skipButtonText}>Skip feedback</Text>
            </TouchableOpacity>
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
    marginBottom: spacing.section,
    paddingTop: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: colors.muted,
    marginTop: 8,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.95)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.section,
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    padding: 24,
  },
  modalTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 12,
  },
  modalText: {
    fontSize: 16,
    color: colors.textSecondary,
    lineHeight: 24,
    marginBottom: 24,
  },
  modalActions: {
    gap: 12,
  },
  taskTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  contractId: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 4,
  },
  criteriaTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 16,
  },
  criteriaList: {
    gap: 16,
  },
  criterionItem: {
    gap: 12,
  },
  criterionDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    marginBottom: 16,
  },
  criterionLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 12,
  },
  criterionControls: {
    flexDirection: 'row',
    gap: 12,
  },
  criterionButton: {
    flex: 1,
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  criterionButtonActive: {
    backgroundColor: 'rgba(52, 199, 89, 0.2)',
    borderColor: '#34C759',
  },
  criterionButtonNo: {
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  criterionButtonNoActive: {
    backgroundColor: 'rgba(255, 149, 0, 0.2)',
    borderColor: '#FF9500',
  },
  criterionButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  criterionButtonTextActive: {
    color: colors.textPrimary,
  },
  criterionWarning: {
    fontSize: 12,
    color: '#FF9500',
    marginTop: 8,
  },
  satisfactionScale: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 12,
    marginBottom: 12,
  },
  satisfactionIcon: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  satisfactionHint: {
    fontSize: 12,
    fontStyle: 'italic',
    color: colors.muted,
    marginTop: 12,
  },
  commentInput: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 8,
    padding: 12,
    color: colors.textPrimary,
    minHeight: 80,
    textAlignVertical: 'top',
    marginTop: 12,
  },
  commentCounter: {
    fontSize: 11,
    color: colors.muted,
    textAlign: 'right',
    marginTop: 4,
  },
  trustDisclosure: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  trustDisclosureText: {
    flex: 1,
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
  },
  footerHint: {
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 12,
  },
  skipButton: {
    marginTop: 16,
    alignItems: 'center',
  },
  skipButtonText: {
    fontSize: 14,
    color: colors.muted,
    opacity: 0.7,
    textDecorationLine: 'underline',
  },
});
