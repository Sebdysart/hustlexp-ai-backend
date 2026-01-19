/**
 * Location Selection Screen (Capability Onboarding Phase 1) (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: CAPABILITY_PHASE_1
 * Spec Authority: HUSTLEXP-DOCS/architecture/CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 1
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. PURPOSE (CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 1):
 *    - Establish legal jurisdiction for licenses, insurance, and task legality
 *    - Location cannot be changed after onboarding (must go to Settings)
 * 
 * 2. BEHAVIORAL RULES:
 *    - State is required (cannot proceed without selection)
 *    - City/ZIP is optional (can skip)
 *    - Selection updates work_state and work_region immediately
 * 
 * 3. WHY THIS MATTERS:
 *    - Licenses are state-scoped (WA electrician license ≠ CA license)
 *    - Insurance is state-scoped (coverage territory)
 *    - Task legality is state-scoped (workplace safety laws)
 *    - No location = no trade verification paths
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
  TextInput,
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
 * Location Selection Screen Props
 * 
 * Props for location selection screen.
 */
export interface LocationSelectionScreenProps {
  /** Callback when location is selected and Continue is pressed */
  onContinue?: (data: { workState: string; workRegion?: string }) => void;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Question prompt (exact wording from spec).
 */
const QUESTION_PROMPT = 'Where will you be working?';

/**
 * US States (ISO 3166-2 codes).
 * 
 * All 50 US states + DC for state dropdown.
 */
const US_STATES = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
] as const;

/**
 * Form labels.
 */
const LABELS = {
  state: 'State',
  cityZip: 'City / ZIP',
} as const;

/**
 * Placeholders.
 */
const PLACEHOLDERS = {
  state: 'Select state',
  cityZip: 'City or ZIP code (optional)',
} as const;

/**
 * Helper text.
 */
const HELPER_TEXT = 'Licenses and insurance are state-scoped';

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
 * Text Input Component
 * 
 * Styled text input with label and proper focus states.
 */
function StyledTextInput({
  label,
  value,
  onChangeText,
  placeholder,
  autoCapitalize = 'sentences',
  style,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  autoCapitalize?: 'sentences' | 'words' | 'none';
  style?: any;
}) {
  const [isFocused, setIsFocused] = useState(false);

  return (
    <View style={[styles.inputContainer, style]}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        style={[
          styles.input,
          isFocused && styles.inputFocused, // A2: Focus states visible
        ]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        autoCapitalize={autoCapitalize}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
      />
    </View>
  );
}

/**
 * State Selection Button
 * 
 * Button for selecting a state (simplified - dropdown would be better in production).
 */
function StateSelectionButton({
  state,
  isSelected,
  onSelect,
}: {
  state: { code: string; name: string };
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.stateButton, isSelected && styles.stateButtonSelected]}
      onPress={onSelect}
      activeOpacity={0.8}
    >
      <Text
        style={[
          styles.stateButtonText,
          isSelected && styles.stateButtonTextSelected,
        ]}
      >
        {state.name}
      </Text>
    </TouchableOpacity>
  );
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Location Selection Screen
 * 
 * Capability Onboarding Phase 1 - Legal jurisdiction selection.
 * Establishes legal scope for licenses, insurance, and task legality.
 * 
 * PURPOSE (CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 1):
 * - Establish legal jurisdiction for licenses, insurance, and task legality
 * - Location cannot be changed after onboarding (must go to Settings)
 * 
 * BEHAVIORAL RULES:
 * - State is required (cannot proceed without selection)
 * - City/ZIP is optional (can skip)
 * 
 * @param props - Location selection screen props
 * @returns React component
 */
export function LocationSelectionScreen({
  onContinue,
}: LocationSelectionScreenProps) {
  // ========================================================================
  // State
  // ========================================================================

  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [cityZip, setCityZip] = useState('');

  // ========================================================================
  // Handlers
  // ========================================================================

  const handleContinue = () => {
    if (!selectedState) return; // State is required
    onContinue?.({
      workState: selectedState,
      workRegion: cityZip.trim() || undefined,
    });
  };

  const handleSelectState = (stateCode: string) => {
    setSelectedState(stateCode);
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
        </View>

        {/* State Selection */}
        <GlassCard style={styles.formCard}>
          <Text style={styles.inputLabel}>{LABELS.state} (required)</Text>
          <View style={styles.stateGrid}>
            {US_STATES.map((state) => (
              <StateSelectionButton
                key={state.code}
                state={state}
                isSelected={selectedState === state.code}
                onSelect={() => handleSelectState(state.code)}
              />
            ))}
          </View>
        </GlassCard>

        {/* City/ZIP Input */}
        <GlassCard style={styles.formCard}>
          <StyledTextInput
            label={LABELS.cityZip}
            value={cityZip}
            onChangeText={setCityZip}
            placeholder={PLACEHOLDERS.cityZip}
            autoCapitalize="words"
          />
          <Text style={styles.helperText}>{HELPER_TEXT}</Text>
        </GlassCard>

        {/* Continue Button */}
        <View style={styles.actionContainer}>
          <PrimaryActionButton
            label={CONTINUE_BUTTON_LABEL}
            onPress={handleContinue}
            disabled={!selectedState}
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
  },

  // ========================================================================
  // Form Card
  // ========================================================================

  formCard: {
    padding: spacing.section,
    marginBottom: spacing.section,
  },

  // ========================================================================
  // State Selection
  // ========================================================================

  stateGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.card / 2,
    marginTop: spacing.card,
  },

  stateButton: {
    backgroundColor: colors.glassSecondary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 8,
    paddingVertical: spacing.card / 2,
    paddingHorizontal: spacing.card,
    minHeight: MIN_TOUCH_TARGET_HEIGHT, // A4: ≥44px
    justifyContent: 'center',
    alignItems: 'center',
  },

  stateButtonSelected: {
    borderColor: colors.textPrimary,
    borderWidth: 2,
    backgroundColor: colors.glassPrimary,
  },

  stateButtonText: {
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center',
  },

  stateButtonTextSelected: {
    color: colors.textPrimary,
    fontWeight: '600',
  },

  // ========================================================================
  // Text Input
  // ========================================================================

  inputContainer: {
    marginBottom: spacing.card,
  },

  inputLabel: {
    fontSize: typography.body.fontSize,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.card / 2,
  },

  input: {
    backgroundColor: colors.glassSecondary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 12,
    paddingVertical: spacing.card,
    paddingHorizontal: spacing.card,
    fontSize: typography.body.fontSize,
    color: colors.textPrimary,
    minHeight: MIN_TOUCH_TARGET_HEIGHT, // A4: ≥44px
  },

  inputFocused: {
    borderColor: colors.textPrimary, // A2: Focus states visible
    borderWidth: 2,
  },

  helperText: {
    fontSize: 12,
    color: colors.muted,
    marginTop: spacing.card / 2,
  },

  // ========================================================================
  // Action Container
  // ========================================================================

  actionContainer: {
    marginTop: spacing.section,
  },
});
