/**
 * Insurance Claim Screen (Capability Onboarding Phase 5) (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: CAPABILITY_PHASE_5
 * Spec Authority: HUSTLEXP-DOCS/architecture/CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 5
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. CONDITIONAL DISPLAY:
 *    - Shown if regulated_trades.length > 0 OR risk_preferences.in_home === true
 * 
 * 2. PURPOSE:
 *    - Collect insurance claims for risk-class gating, NOT grant access
 *    - "No" does NOT block onboarding (low-risk work still available)
 * 
 * 3. BEHAVIORAL RULES:
 *    - Must select "Yes" or "No" (cannot skip, but "No" does not block)
 *    - COI upload is optional at onboarding (can add later in Settings)
 *    - "No" does not prevent continuing (low-risk work still available)
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
 * Insurance Claim Screen Props
 * 
 * Props for insurance claim screen.
 */
export interface InsuranceClaimScreenProps {
  /** Callback when insurance status is selected and Continue is pressed */
  onContinue?: (data: { insuranceClaimed: boolean; coiUploaded?: boolean }) => void;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Question prompt (exact wording from spec).
 */
const QUESTION_PROMPT = 'Do you currently carry active professional insurance?';

/**
 * Insurance options.
 */
const INSURANCE_OPTIONS: Array<{ value: boolean; label: string }> = [
  { value: true, label: 'Yes' },
  { value: false, label: 'No' },
];

/**
 * Message for "No" intent (exact wording from spec).
 */
const NO_INTENT_MESSAGE = "Insurance is required for certain higher-risk gigs. You'll still see eligible lower-risk work.";

/**
 * Upload helper text (exact wording from spec).
 */
const UPLOAD_HELPER_TEXT = 'Upload now or add later in Settings';

/**
 * Button labels.
 */
const BUTTON_LABELS = {
  continue: 'Continue',
  uploadCOI: 'Upload Certificate of Insurance (COI)',
} as const;

/**
 * Minimum touch target height (A4 accessibility requirement).
 */
const MIN_TOUCH_TARGET_HEIGHT = 44;

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Insurance Claim Screen
 * 
 * Capability Onboarding Phase 5 - Insurance status (risk-class gating).
 * Conditional: Shown if regulated trades OR risk preferences require it.
 * 
 * PURPOSE (CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 5):
 * - Collect insurance claims for risk-class gating, NOT grant access
 * - "No" does NOT block onboarding (low-risk work still available)
 * 
 * BEHAVIORAL RULES:
 * - Must select "Yes" or "No" (cannot skip, but "No" does not block)
 * - COI upload is optional at onboarding (can add later in Settings)
 * 
 * @param props - Insurance claim screen props
 * @returns React component
 */
export function InsuranceClaimScreen({
  onContinue,
}: InsuranceClaimScreenProps) {
  // ========================================================================
  // State
  // ========================================================================

  const [insuranceClaimed, setInsuranceClaimed] = useState<boolean | null>(
    null
  );
  const [coiUploaded, setCoiUploaded] = useState(false);

  // ========================================================================
  // Handlers
  // ========================================================================

  const handleContinue = () => {
    if (insuranceClaimed === null) return; // Cannot proceed without selection
    onContinue?.({
      insuranceClaimed,
      coiUploaded: insuranceClaimed ? coiUploaded : undefined,
    });
  };

  const handleSelectInsurance = (value: boolean) => {
    setInsuranceClaimed(value);
    if (!value) {
      setCoiUploaded(false); // Reset upload if "No" selected
    }
  };

  const handleUploadCOI = () => {
    // TODO: Implement file upload
    setCoiUploaded(true);
  };

  // ========================================================================
  // Derived Values
  // ========================================================================

  const showNoMessage = insuranceClaimed === false;
  const showUploadSection = insuranceClaimed === true;

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

        {/* Insurance Options */}
        <View style={styles.optionsContainer}>
          {INSURANCE_OPTIONS.map((option) => (
            <TouchableOpacity
              key={option.value.toString()}
              style={[
                styles.optionButton,
                insuranceClaimed === option.value &&
                  styles.optionButtonSelected,
              ]}
              onPress={() => handleSelectInsurance(option.value)}
              activeOpacity={0.8}
            >
              <Text
                style={[
                  styles.optionText,
                  insuranceClaimed === option.value &&
                    styles.optionTextSelected,
                ]}
              >
                {option.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Upload Section (if "Yes" selected) */}
        {showUploadSection && (
          <GlassCard style={styles.uploadCard}>
            <PrimaryActionButton
              label={BUTTON_LABELS.uploadCOI}
              onPress={handleUploadCOI}
              disabled={coiUploaded}
            />
            {coiUploaded && (
              <Text style={styles.uploadStatusText}>COI uploaded</Text>
            )}
            <Text style={styles.uploadHelperText}>{UPLOAD_HELPER_TEXT}</Text>
          </GlassCard>
        )}

        {/* Message for "No" */}
        {showNoMessage && (
          <GlassCard style={styles.messageCard}>
            <Text style={styles.messageText}>{NO_INTENT_MESSAGE}</Text>
          </GlassCard>
        )}

        {/* Continue Button */}
        <View style={styles.actionContainer}>
          <PrimaryActionButton
            label={BUTTON_LABELS.continue}
            onPress={handleContinue}
            disabled={insuranceClaimed === null}
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
  // Options
  // ========================================================================

  optionsContainer: {
    gap: spacing.card,
    marginBottom: spacing.section,
  },

  optionButton: {
    backgroundColor: colors.glassPrimary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 12,
    padding: spacing.section,
    minHeight: MIN_TOUCH_TARGET_HEIGHT, // A4: ≥44px
    justifyContent: 'center',
    alignItems: 'center',
  },

  optionButtonSelected: {
    borderColor: colors.textPrimary,
    borderWidth: 2,
    backgroundColor: colors.glassSecondary,
  },

  optionText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
  },

  optionTextSelected: {
    color: colors.textPrimary,
    fontWeight: '600',
  },

  // ========================================================================
  // Upload Card
  // ========================================================================

  uploadCard: {
    padding: spacing.section,
    marginBottom: spacing.section,
  },

  uploadStatusText: {
    fontSize: typography.body.fontSize,
    color: colors.textPrimary,
    textAlign: 'center',
    marginTop: spacing.card,
    fontWeight: '600',
  },

  uploadHelperText: {
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center',
    marginTop: spacing.card / 2,
  },

  // ========================================================================
  // Message Card
  // ========================================================================

  messageCard: {
    padding: spacing.section,
    marginBottom: spacing.section,
  },

  messageText: {
    fontSize: typography.body.fontSize,
    color: colors.textPrimary,
    textAlign: 'center',
    lineHeight: 20,
  },

  // ========================================================================
  // Action Container
  // ========================================================================

  actionContainer: {
    marginTop: spacing.section,
  },
});
