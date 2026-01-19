/**
 * Role Declaration Screen (Capability Onboarding Phase 0) (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: CAPABILITY_PHASE_0
 * Spec Authority: HUSTLEXP-DOCS/architecture/CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 0
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. PURPOSE (CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 0):
 *    - Branching gate: Determine user intent (hustler/poster/both)
 *    - Unlocks appropriate onboarding flow
 * 
 * 2. BEHAVIORAL RULES:
 *    - Single selection required (cannot proceed without selection)
 *    - Cannot skip or go back (first step)
 *    - Selection determines which flows are available
 * 
 * 3. FLOW BRANCHING:
 *    - If role === "hustler" or "both" → Continue to PHASE 1 (Location)
 *    - If role === "poster" only → Skip to poster-specific flow
 * 
 * ============================================================================
 * COMPONENT DEPENDENCIES
 * ============================================================================
 * 
 * Required Components:
 * - PrimaryActionButton (hustlexp-app/ui/PrimaryActionButton.tsx)
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
  TouchableOpacity,
} from 'react-native';

// Design System Imports
import { PrimaryActionButton } from '../../../ui/PrimaryActionButton';
import { colors } from '../../../ui/colors';
import { spacing } from '../../../ui/spacing';
import { typography } from '../../../ui/typography';

// ============================================================================
// TYPE DEFINITIONS (MAX-TIER: Explicit, Exhaustive, Documented)
// ============================================================================

/**
 * User role for capability onboarding.
 * 
 * Determines which onboarding flow is unlocked.
 */
export type CapabilityRole = 'hustler' | 'poster' | 'both';

/**
 * Role option.
 * 
 * Represents a single role selection option.
 */
export interface RoleOption {
  /** Role value */
  value: CapabilityRole;
  
  /** Display label */
  label: string;
}

/**
 * Role Declaration Screen Props
 * 
 * Props for role declaration screen.
 */
export interface RoleDeclarationScreenProps {
  /** Callback when role is selected and Continue is pressed */
  onContinue?: (role: CapabilityRole) => void;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Question prompt (exact wording from spec).
 */
const QUESTION_PROMPT = 'How do you want to use HustleXP?';

/**
 * Role options (exact wording from spec).
 */
const ROLE_OPTIONS: RoleOption[] = [
  { value: 'hustler', label: 'I want to earn money completing gigs' },
  { value: 'poster', label: 'I want to post gigs' },
  { value: 'both', label: 'Both' },
] as const;

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
 * Role Selection Button Component
 * 
 * Button for selecting a role option.
 */
function RoleSelectionButton({
  option,
  isSelected,
  onSelect,
}: {
  option: RoleOption;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.roleButton, isSelected && styles.roleButtonSelected]}
      onPress={onSelect}
      activeOpacity={0.8}
    >
      <Text
        style={[
          styles.roleButtonText,
          isSelected && styles.roleButtonTextSelected,
        ]}
      >
        {option.label}
      </Text>
    </TouchableOpacity>
  );
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Role Declaration Screen
 * 
 * Capability Onboarding Phase 0 - Branching gate for user intent.
 * Determines which onboarding flow is unlocked.
 * 
 * PURPOSE (CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 0):
 * - Determine user intent and unlock appropriate onboarding flow
 * 
 * BEHAVIORAL RULES:
 * - Single selection required (cannot proceed without selection)
 * - Cannot skip or go back (first step)
 * - Selection determines which flows are available
 * 
 * FLOW BRANCHING:
 * - If role === "hustler" or "both" → Continue to PHASE 1 (Location)
 * - If role === "poster" only → Skip to poster-specific flow
 * 
 * @param props - Role declaration screen props
 * @returns React component
 */
export function RoleDeclarationScreen({
  onContinue,
}: RoleDeclarationScreenProps) {
  // ========================================================================
  // State
  // ========================================================================

  const [selectedRole, setSelectedRole] = useState<CapabilityRole | null>(
    null
  );

  // ========================================================================
  // Handlers
  // ========================================================================

  const handleContinue = () => {
    if (!selectedRole) return; // Cannot proceed without selection
    onContinue?.(selectedRole);
  };

  const handleSelectRole = (role: CapabilityRole) => {
    setSelectedRole(role);
  };

  // ========================================================================
  // Render
  // ========================================================================

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.content}>
        {/* Question */}
        <View style={styles.questionContainer}>
          <Text style={styles.questionPrompt}>{QUESTION_PROMPT}</Text>
        </View>

        {/* Role Options */}
        <View style={styles.optionsContainer}>
          {ROLE_OPTIONS.map((option) => (
            <RoleSelectionButton
              key={option.value}
              option={option}
              isSelected={selectedRole === option.value}
              onSelect={() => handleSelectRole(option.value)}
            />
          ))}
        </View>

        {/* Continue Button */}
        <View style={styles.actionContainer}>
          <PrimaryActionButton
            label={CONTINUE_BUTTON_LABEL}
            onPress={handleContinue}
            disabled={!selectedRole}
          />
        </View>
      </View>
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

  content: {
    flex: 1,
    paddingHorizontal: spacing.card,
    justifyContent: 'center',
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
  // Role Options
  // ========================================================================

  optionsContainer: {
    gap: spacing.card,
    marginBottom: spacing.section * 2,
  },

  roleButton: {
    backgroundColor: colors.glassPrimary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 12,
    padding: spacing.section,
    minHeight: MIN_TOUCH_TARGET_HEIGHT, // A4: ≥44px
    justifyContent: 'center',
    alignItems: 'center',
  },

  roleButtonSelected: {
    borderColor: colors.textPrimary,
    borderWidth: 2,
    backgroundColor: colors.glassSecondary,
  },

  roleButtonText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
  },

  roleButtonTextSelected: {
    color: colors.textPrimary,
    fontWeight: '600',
  },

  // ========================================================================
  // Action Container
  // ========================================================================

  actionContainer: {
    marginTop: spacing.section,
  },
});
