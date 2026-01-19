/**
 * Risk Willingness Screen (Capability Onboarding Phase 6) (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: CAPABILITY_PHASE_6
 * Spec Authority: HUSTLEXP-DOCS/architecture/CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 6
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. PURPOSE (CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 6):
 *    - Collect willingness flags that tailor verification prompts and upsells
 *    - NOT grant access (capability profile drives feed)
 * 
 * 2. BEHAVIORAL RULES:
 *    - All options are optional (can skip)
 *    - Can select multiple options (checkboxes)
 *    - Selection does not unlock gigs (only tailors prompts)
 *    - Warnings shown if requirements not met (informational, not blocking)
 * 
 * ============================================================================
 * COMPONENT DEPENDENCIES
 * ============================================================================
 * 
 * Required Components:
 * - PrimaryActionButton (hustlexp-app/ui/PrimaryActionButton.tsx)
 * - GlassCard (hustlexp-app/ui/GlassCard.tsx)
 * 
 * Required Tokens:
 * - colors (hustlexp-app/ui/colors.ts)
 * - spacing (hustlexp-app/ui/spacing.ts)
 * - typography (hustlexp-app/ui/typography.ts)
 * 
 * ============================================================================
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
} from 'react-native';

// Design System Imports
import { PrimaryActionButton } from '../../../ui/PrimaryActionButton';
import { GlassCard } from '../../../ui/GlassCard';
import { colors } from '../../../ui/colors';
import { spacing } from '../../../ui/spacing';
import { typography } from '../../../ui/typography';

// ============================================================================
// TYPE DEFINITIONS (MAX-TIER: Explicit, Exhaustive, Documented)
// ============================================================================

/**
 * Risk preferences.
 * 
 * Willingness flags that tailor verification prompts.
 */
export interface RiskPreferences {
  /** In-home work willingness */
  inHome: boolean;
  
  /** Urgent/same-day gigs willingness */
  urgent: boolean;
  
  /** High-value installs willingness */
  highValue: boolean;
}

/**
 * Risk preference option.
 * 
 * Represents a single risk preference option.
 */
export interface RiskOption {
  /** Preference key */
  key: keyof RiskPreferences;
  
  /** Display label */
  label: string;
  
  /** Helper text */
  helperText: string;
  
  /** Whether warning should be shown (e.g., if insurance not claimed) */
  showWarning?: boolean;
}

/**
 * Risk Willingness Screen Props
 * 
 * Props for risk willingness screen.
 */
export interface RiskWillingnessScreenProps {
  /** Whether insurance was claimed in PHASE 5 (for warning display) */
  insuranceClaimed?: boolean;
  
  /** Callback when preferences are selected and Continue is pressed */
  onContinue?: (preferences: RiskPreferences) => void;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Question prompt (exact wording from spec).
 */
const QUESTION_PROMPT = 'Are you willing to do the following?';

/**
 * Subtitle prompt (exact wording from spec).
 */
const SUBTITLE_PROMPT = "(These preferences tailor your verification options)";

/**
 * Risk preference options (exact wording from spec).
 */
const RISK_OPTIONS: RiskOption[] = [
  {
    key: 'inHome',
    label: 'In-home work',
    helperText: 'Work inside customer residences (requires insurance)',
  },
  {
    key: 'urgent',
    label: 'Urgent / same-day gigs',
    helperText: 'Accept instant tasks with tight deadlines',
  },
  {
    key: 'highValue',
    label: 'High-value installs ($$$)',
    helperText: 'Installation tasks with higher pay (requires higher trust tier)',
  },
];

/**
 * Continue button label.
 */
const CONTINUE_BUTTON_LABEL = 'Continue';

/**
 * Minimum touch target height (A4 accessibility requirement).
 */
const MIN_TOUCH_TARGET_HEIGHT = 44;

// ============================================================================
// SUB-COMPONENTS (MAX-TIER: Modular, Reusable, Documented)
// ============================================================================

/**
 * Risk Option Card Component
 * 
 * Checkbox card for a single risk preference option.
 */
function RiskOptionCard({
  option,
  isSelected,
  showWarning,
  onToggle,
}: {
  option: RiskOption;
  isSelected: boolean;
  showWarning?: boolean;
  onToggle: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.optionCard, isSelected && styles.optionCardSelected]}
      onPress={onToggle}
      activeOpacity={0.8}
    >
      <View style={styles.optionContent}>
        <View style={styles.optionHeader}>
          <Text
            style={[
              styles.optionLabel,
              isSelected && styles.optionLabelSelected,
            ]}
          >
            {option.label}
          </Text>
          <View
            style={[
              styles.checkbox,
              isSelected && styles.checkboxSelected,
            ]}
          >
            {isSelected && <View style={styles.checkboxDot} />}
          </View>
        </View>
        <Text style={styles.optionHelper}>{option.helperText}</Text>
        {showWarning && (
          <Text style={styles.warningText}>
            ⚠️ This option may require insurance
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Risk Willingness Screen
 * 
 * Capability Onboarding Phase 6 - Risk preferences (not access).
 * Collects willingness flags that tailor verification prompts and upsells.
 * 
 * PURPOSE (CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 6):
 * - Collect willingness flags that tailor verification prompts, NOT unlock gigs
 * - Preferences do not grant access (capability profile drives feed)
 * 
 * BEHAVIORAL RULES:
 * - All options are optional (can skip)
 * - Can select multiple options (checkboxes)
 * - Selection does not unlock gigs (only tailors prompts)
 * 
 * @param props - Risk willingness screen props
 * @returns React component
 */
export function RiskWillingnessScreen({
  insuranceClaimed = false,
  onContinue,
}: RiskWillingnessScreenProps) {
  // ========================================================================
  // State
  // ========================================================================

  const [preferences, setPreferences] = useState<RiskPreferences>({
    inHome: false,
    urgent: false,
    highValue: false,
  });

  // ========================================================================
  // Handlers
  // ========================================================================

  const handleTogglePreference = (key: keyof RiskPreferences) => {
    setPreferences((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleContinue = () => {
    onContinue?.(preferences);
  };

  // ========================================================================
  // Render
  // ========================================================================

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Question */}
        <View style={styles.questionContainer}>
          <Text style={styles.questionPrompt}>{QUESTION_PROMPT}</Text>
          <Text style={styles.subtitlePrompt}>{SUBTITLE_PROMPT}</Text>
        </View>

        {/* Risk Options */}
        <View style={styles.optionsContainer}>
          {RISK_OPTIONS.map((option) => (
            <RiskOptionCard
              key={option.key}
              option={option}
              isSelected={preferences[option.key]}
              showWarning={
                option.key === 'inHome' && !insuranceClaimed
              }
              onToggle={() => handleTogglePreference(option.key)}
            />
          ))}
        </View>

        {/* Continue Button */}
        <View style={styles.actionContainer}>
          <PrimaryActionButton
            label={CONTINUE_BUTTON_LABEL}
            onPress={handleContinue}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ============================================================================
// STYLES (MAX-TIER: Organized, Documented, Token-Based)
// ============================================================================

const styles = StyleSheet.create({
  // ========================================================================
  // Layout
  // ========================================================================

  container: {
    flex: 1,
    backgroundColor: colors.background,
  },

  scrollView: {
    flex: 1,
  },

  scrollContent: {
    paddingTop: spacing.section,
    paddingHorizontal: spacing.card,
    paddingBottom: spacing.section * 2,
  },

  // ========================================================================
  // Question
  // ========================================================================

  questionContainer: {
    marginBottom: spacing.section * 2,
    alignItems: 'center',
  },

  questionPrompt: {
    fontSize: typography.header.fontSize,
    fontWeight: typography.header.fontWeight,
    color: colors.textPrimary,
    textAlign: 'center',
    lineHeight: 36,
    marginBottom: spacing.card / 2,
  },

  subtitlePrompt: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
  },

  // ========================================================================
  // Options
  // ========================================================================

  optionsContainer: {
    gap: spacing.card,
    marginBottom: spacing.section,
  },

  optionCard: {
    backgroundColor: colors.glassPrimary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 12,
    padding: spacing.section,
    minHeight: MIN_TOUCH_TARGET_HEIGHT, // A4: ≥44px
  },

  optionCardSelected: {
    borderColor: colors.textPrimary,
    borderWidth: 2,
    backgroundColor: colors.glassSecondary,
  },

  optionContent: {
    gap: spacing.card / 2,
  },

  optionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  optionLabel: {
    fontSize: typography.body.fontSize,
    fontWeight: '600',
    color: colors.textPrimary,
    flex: 1,
  },

  optionLabelSelected: {
    color: colors.textPrimary,
  },

  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.glassBorderPrimary,
    justifyContent: 'center',
    alignItems: 'center',
  },

  checkboxSelected: {
    borderColor: colors.textPrimary,
    backgroundColor: colors.textPrimary,
  },

  checkboxDot: {
    width: 8,
    height: 8,
    borderRadius: 2,
    backgroundColor: colors.background,
  },

  optionHelper: {
    fontSize: 12,
    color: colors.muted,
  },

  warningText: {
    fontSize: 12,
    color: '#F59E0B', // Amber for warning
    fontStyle: 'italic',
  },

  // ========================================================================
  // Action Container
  // ========================================================================

  actionContainer: {
    marginTop: spacing.section,
  },
});
