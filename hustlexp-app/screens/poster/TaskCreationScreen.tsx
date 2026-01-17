/**
 * Screen: 04_POSTER_TASK_CREATION
 * Spec: HUSTLEXP-DOCS/ui-specs/stitch-prompts/04-poster-task-creation.md
 * Version: v1
 * Status: NOT LOCKED (but implemented)
 * Components (required): GlassCard, PrimaryActionButton, SectionHeader
 * Tokens (required): colors.json, spacing.json, typography.json
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Switch,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { GlassCard } from '../../ui/GlassCard';
import { PrimaryActionButton } from '../../ui/PrimaryActionButton';
import { SectionHeader } from '../../ui/SectionHeader';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';

interface TaskCreationScreenProps {
  onBack?: () => void;
  onSubmit?: (task: {
    title: string;
    description: string;
    location: string;
    amount: number;
    instantMode: boolean;
  }) => void;
}

export default function TaskCreationScreen({
  onBack,
  onSubmit,
}: TaskCreationScreenProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [amount, setAmount] = useState('');
  const [instantMode, setInstantMode] = useState(false);

  const isComplete = title.trim() && description.trim() && location.trim() && amount;
  const canSubmit = isComplete && (!instantMode || isComplete);

  const handleSubmit = () => {
    if (canSubmit) {
      onSubmit?.({
        title: title.trim(),
        description: description.trim(),
        location: location.trim(),
        amount: parseFloat(amount) || 0,
        instantMode,
      });
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onBack} style={styles.backButton}>
            <MaterialIcons name="arrow-back" size={24} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Create Task</Text>
          <View style={styles.placeholder} />
        </View>

        {/* Task Details Form */}
        <View style={styles.formSection}>
          <Text style={styles.fieldLabel}>What needs to be done?</Text>
          <TextInput
            style={styles.textInput}
            placeholder="Enter task title"
            placeholderTextColor={colors.muted}
            value={title}
            onChangeText={setTitle}
          />
          {!title.trim() && (
            <Text style={styles.aiHint}>
              💡 Add specific dimensions or quantities
            </Text>
          )}

          <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Provide details...</Text>
          <TextInput
            style={[styles.textInput, styles.textArea]}
            placeholder="Describe the task requirements"
            placeholderTextColor={colors.muted}
            multiline
            numberOfLines={4}
            value={description}
            onChangeText={setDescription}
          />
          {!description.trim() && (
            <Text style={styles.aiHint}>
              💡 Clarify location access instructions
            </Text>
          )}

          <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Where?</Text>
          <View style={styles.locationInput}>
            <MaterialIcons name="location-on" size={20} color={colors.muted} />
            <TextInput
              style={styles.locationTextInput}
              placeholder="Enter location"
              placeholderTextColor={colors.muted}
              value={location}
              onChangeText={setLocation}
            />
          </View>
          {!location.trim() && (
            <Text style={styles.aiHint}>
              💡 Location required for Instant Mode
            </Text>
          )}
        </View>

        {/* AI Completeness Indicator */}
        <GlassCard style={styles.aiCard}>
          <View style={styles.aiStatusRow}>
            {isComplete ? (
              <>
                <MaterialIcons name="check-circle" size={20} color="#34C759" />
                <Text style={styles.aiStatusText}>Task is Instant-ready</Text>
              </>
            ) : (
              <>
                <MaterialIcons name="warning" size={20} color="#FF9500" />
                <Text style={[styles.aiStatusText, { color: '#FF9500' }]}>
                  Needs clarification
                </Text>
              </>
            )}
          </View>
          {!isComplete && (
            <View style={styles.missingFields}>
              {!title.trim() && (
                <Text style={styles.missingField}>• Add task title</Text>
              )}
              {!description.trim() && (
                <Text style={styles.missingField}>• Add description</Text>
              )}
              {!location.trim() && (
                <Text style={styles.missingField}>• Add access instructions</Text>
              )}
            </View>
          )}
          <Text style={styles.aiBadge}>AI checked</Text>
        </GlassCard>

        {/* Risk Classification Preview */}
        <GlassCard>
          <SectionHeader title="Risk Level" />
          <View style={styles.riskRow}>
            <MaterialIcons name="shield" size={20} color={colors.muted} />
            <View style={styles.riskContent}>
              <Text style={styles.riskLevel}>IN-HOME</Text>
              <Text style={styles.riskDescription}>
                Requires trusted hustler (Tier 3+)
              </Text>
            </View>
            <View style={styles.tierBadge}>
              <Text style={styles.tierBadgeText}>Tier 3+</Text>
            </View>
          </View>
        </GlassCard>

        {/* Instant Mode Toggle */}
        <GlassCard>
          <View style={styles.instantToggleRow}>
            <View style={styles.instantToggleContent}>
              <View style={styles.instantToggleHeader}>
                <MaterialIcons name="bolt" size={20} color={instantMode ? '#34C759' : colors.muted} />
                <Text style={styles.instantToggleLabel}>Instant Execution</Text>
              </View>
              <Text style={styles.instantToggleDescription}>
                Get a hustler on the way in under 60 seconds
              </Text>
              {!isComplete && instantMode && (
                <Text style={styles.instantToggleWarning}>
                  Complete task details above to enable
                </Text>
              )}
            </View>
            <Switch
              value={instantMode && isComplete}
              onValueChange={setInstantMode}
              disabled={!isComplete}
              trackColor={{ false: colors.muted, true: '#34C759' }}
              thumbColor={colors.textPrimary}
            />
          </View>
        </GlassCard>

        {/* Pricing */}
        <GlassCard>
          <SectionHeader title="Pricing" />
          <TextInput
            style={styles.amountInput}
            placeholder="$45.00"
            placeholderTextColor={colors.muted}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
          />
          <Text style={styles.suggestedPrice}>Suggested: $40-50</Text>
        </GlassCard>
      </ScrollView>

      {/* Submit Button */}
      <View style={styles.footer}>
        <PrimaryActionButton
          label="Post Task"
          onPress={handleSubmit}
          disabled={!canSubmit}
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
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.section,
    paddingTop: 16,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  placeholder: {
    width: 40,
  },
  formSection: {
    marginBottom: spacing.section,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 8,
    padding: 12,
    color: colors.textPrimary,
    fontSize: 16,
  },
  textArea: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  aiHint: {
    fontSize: 12,
    fontWeight: '500',
    fontStyle: 'italic',
    color: '#FF9500',
    marginTop: 4,
  },
  locationInput: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  locationTextInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 16,
  },
  aiCard: {
    marginBottom: spacing.section,
  },
  aiStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  aiStatusText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#34C759',
  },
  missingFields: {
    marginTop: 8,
    gap: 4,
  },
  missingField: {
    fontSize: 12,
    color: '#FF9500',
  },
  aiBadge: {
    fontSize: 10,
    color: colors.muted,
    marginTop: 8,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  riskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
  },
  riskContent: {
    flex: 1,
  },
  riskLevel: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  riskDescription: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  tierBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  tierBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  instantToggleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  instantToggleContent: {
    flex: 1,
  },
  instantToggleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  instantToggleLabel: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  instantToggleDescription: {
    fontSize: 14,
    color: colors.muted,
    marginTop: 4,
  },
  instantToggleWarning: {
    fontSize: 12,
    color: '#FF9500',
    marginTop: 8,
  },
  amountInput: {
    fontSize: 36,
    fontWeight: '700',
    color: colors.textPrimary,
    marginTop: 12,
    marginBottom: 8,
  },
  suggestedPrice: {
    fontSize: 12,
    color: colors.muted,
    fontStyle: 'italic',
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
