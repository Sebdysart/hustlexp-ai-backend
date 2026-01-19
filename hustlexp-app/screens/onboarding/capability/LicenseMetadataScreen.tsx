/**
 * License Metadata Screen (Capability Onboarding Phase 4) (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: CAPABILITY_PHASE_4
 * Spec Authority: HUSTLEXP-DOCS/architecture/CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 4
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. CONDITIONAL DISPLAY:
 *    - Only shown if has_license === true (from PHASE 3)
 * 
 * 2. PURPOSE:
 *    - Collect license metadata for verification processing, NOT grant access
 *    - NO payment yet (verification is free or separate)
 *    - NO trust granted at this stage
 *    - NO feed changes at this stage
 * 
 * 3. BEHAVIORAL RULES:
 *    - Can add multiple licenses (one per regulated trade)
 *    - Can skip individual licenses ("Skip for now" button)
 *    - License number and issuing state are required if license added
 *    - Expiration date is optional
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
 * License claim data.
 * 
 * Represents a single license claim entry.
 */
export interface LicenseClaim {
  /** Trade ID */
  trade: string;
  
  /** License number */
  licenseNumber: string;
  
  /** Issuing state (ISO 3166-2 code) */
  state: string;
  
  /** Expiration date (ISO 8601, optional) */
  expirationDate?: string;
}

/**
 * License Metadata Screen Props
 * 
 * Props for license metadata screen.
 */
export interface LicenseMetadataScreenProps {
  /** Regulated trades selected in PHASE 2 */
  regulatedTrades: string[];
  
  /** Work state from PHASE 1 (pre-fill for issuing state) */
  workState?: string;
  
  /** Callback when licenses are added and Continue is pressed */
  onContinue?: (licenseClaims: LicenseClaim[]) => void;
  
  /** Callback when Skip is pressed */
  onSkip?: () => void;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Question prompt (exact wording from spec).
 */
const QUESTION_PROMPT = 'Enter your license details';

/**
 * Helper text (exact wording from spec).
 */
const HELPER_TEXT = 'Verification is processed after onboarding. You can add licenses later in Settings.';

/**
 * Form labels.
 */
const LABELS = {
  tradeType: 'Trade type',
  licenseNumber: 'License number',
  issuingState: 'Issuing state',
  expirationDate: 'Expiration date (optional)',
} as const;

/**
 * Placeholders.
 */
const PLACEHOLDERS = {
  licenseNumber: 'Enter license number',
  expirationDate: 'If your license has an expiration date',
} as const;

/**
 * Button labels.
 */
const BUTTON_LABELS = {
  continue: 'Continue',
  skip: 'Skip for now',
  addAnother: 'Add another license',
} as const;

/**
 * Minimum touch target height (A4 accessibility requirement).
 */
const MIN_TOUCH_TARGET_HEIGHT = 44;

/**
 * Format trade name for display.
 */
function formatTradeName(tradeId: string): string {
  return tradeId
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ============================================================================
// SUB-COMPONENTS (MAX-TIER: Modular, Reusable, Documented)
// ============================================================================

/**
 * License Form Component
 * 
 * Form for entering license details for a single trade.
 */
function LicenseForm({
  trade,
  workState,
  onUpdate,
  onRemove,
  canRemove,
}: {
  trade: string;
  workState?: string;
  onUpdate: (claim: Partial<LicenseClaim>) => void;
  onRemove?: () => void;
  canRemove: boolean;
}) {
  const [licenseNumber, setLicenseNumber] = useState('');
  const [issuingState, setIssuingState] = useState(workState || '');
  const [expirationDate, setExpirationDate] = useState('');

  React.useEffect(() => {
    onUpdate({
      trade,
      licenseNumber: licenseNumber.trim(),
      state: issuingState.trim(),
      expirationDate: expirationDate.trim() || undefined,
    });
  }, [licenseNumber, issuingState, expirationDate, trade, onUpdate]);

  return (
    <GlassCard style={styles.licenseFormCard}>
      <View style={styles.formHeader}>
        <Text style={styles.tradeLabel}>
          {formatTradeName(trade)}
          <Text style={styles.requiredStar}> *</Text>
        </Text>
        {canRemove && onRemove && (
          <TouchableOpacity onPress={onRemove} style={styles.removeButton}>
            <Text style={styles.removeButtonText}>Remove</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.formFields}>
        <View style={styles.inputContainer}>
          <Text style={styles.inputLabel}>{LABELS.licenseNumber}</Text>
          <TextInput
            style={styles.input}
            value={licenseNumber}
            onChangeText={setLicenseNumber}
            placeholder={PLACEHOLDERS.licenseNumber}
            placeholderTextColor={colors.muted}
          />
        </View>

        <View style={styles.inputContainer}>
          <Text style={styles.inputLabel}>{LABELS.issuingState}</Text>
          <TextInput
            style={styles.input}
            value={issuingState}
            onChangeText={setIssuingState}
            placeholder="State code (e.g., WA)"
            placeholderTextColor={colors.muted}
            autoCapitalize="characters"
            maxLength={2}
          />
        </View>

        <View style={styles.inputContainer}>
          <Text style={styles.inputLabel}>{LABELS.expirationDate}</Text>
          <TextInput
            style={styles.input}
            value={expirationDate}
            onChangeText={setExpirationDate}
            placeholder={PLACEHOLDERS.expirationDate}
            placeholderTextColor={colors.muted}
          />
        </View>
      </View>
    </GlassCard>
  );
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * License Metadata Screen
 * 
 * Capability Onboarding Phase 4 - License metadata capture (no payment yet).
 * Conditional: Only shown if has_license === true (from PHASE 3).
 * 
 * PURPOSE (CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 4):
 * - Collect license metadata for verification processing, NOT grant access
 * - NO payment yet (verification is free or separate)
 * - NO trust granted at this stage
 * - NO feed changes at this stage
 * 
 * BEHAVIORAL RULES:
 * - Can add multiple licenses (one per regulated trade)
 * - Can skip individual licenses ("Skip for now" button)
 * - License number and issuing state are required if license added
 * - Expiration date is optional
 * 
 * @param props - License metadata screen props
 * @returns React component
 */
export function LicenseMetadataScreen({
  regulatedTrades,
  workState,
  onContinue,
  onSkip,
}: LicenseMetadataScreenProps) {
  // ========================================================================
  // State
  // ========================================================================

  const [licenseForms, setLicenseForms] = useState<string[]>(
    regulatedTrades.slice(0, 1) // Start with first trade
  );
  const [licenseClaims, setLicenseClaims] = useState<
    Partial<Record<string, LicenseClaim>>
  >({});

  // ========================================================================
  // Handlers
  // ========================================================================

  const handleAddAnother = () => {
    const remainingTrades = regulatedTrades.filter(
      (t) => !licenseForms.includes(t)
    );
    if (remainingTrades.length > 0) {
      setLicenseForms([...licenseForms, remainingTrades[0]]);
    }
  };

  const handleRemoveForm = (trade: string) => {
    setLicenseForms(licenseForms.filter((t) => t !== trade));
    const updatedClaims = { ...licenseClaims };
    delete updatedClaims[trade];
    setLicenseClaims(updatedClaims);
  };

  const handleUpdateClaim = (trade: string, claim: Partial<LicenseClaim>) => {
    setLicenseClaims((prev) => ({
      ...prev,
      [trade]: { ...prev[trade], ...claim } as LicenseClaim,
    }));
  };

  const handleContinue = () => {
    const claims = Object.values(licenseClaims).filter(
      (claim): claim is LicenseClaim =>
        claim.trade !== undefined &&
        claim.licenseNumber !== undefined &&
        claim.licenseNumber.trim() !== '' &&
        claim.state !== undefined &&
        claim.state.trim() !== ''
    );
    onContinue?.(claims);
  };

  const handleSkip = () => {
    onSkip?.();
  };

  // ========================================================================
  // Derived Values
  // ========================================================================

  const canAddAnother =
    licenseForms.length < regulatedTrades.length;
  const hasValidClaims =
    Object.values(licenseClaims).some(
      (claim) =>
        claim.licenseNumber?.trim() && claim.state?.trim()
    );

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

        {/* Helper Text */}
        <Text style={styles.helperText}>{HELPER_TEXT}</Text>

        {/* License Forms */}
        {licenseForms.map((trade, index) => (
          <LicenseForm
            key={trade}
            trade={trade}
            workState={workState}
            onUpdate={(claim) => handleUpdateClaim(trade, claim)}
            onRemove={
              licenseForms.length > 1 ? () => handleRemoveForm(trade) : undefined
            }
            canRemove={licenseForms.length > 1}
          />
        ))}

        {/* Add Another Button */}
        {canAddAnother && (
          <View style={styles.addButtonContainer}>
            <TouchableOpacity
              style={styles.addButton}
              onPress={handleAddAnother}
              activeOpacity={0.8}
            >
              <Text style={styles.addButtonText}>
                {BUTTON_LABELS.addAnother}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Continue / Skip Buttons */}
        <View style={styles.actionContainer}>
          <PrimaryActionButton
            label={BUTTON_LABELS.continue}
            onPress={handleContinue}
          />
          <TouchableOpacity
            style={styles.skipButton}
            onPress={handleSkip}
            activeOpacity={0.8}
          >
            <Text style={styles.skipButtonText}>{BUTTON_LABELS.skip}</Text>
          </TouchableOpacity>
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
    marginBottom: spacing.card,
    alignItems: 'center',
  },

  questionPrompt: {
    fontSize: typography.header.fontSize,
    fontWeight: typography.header.fontWeight,
    color: colors.textPrimary,
    textAlign: 'center',
    lineHeight: 36,
  },

  helperText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
    marginBottom: spacing.section,
  },

  // ========================================================================
  // License Form
  // ========================================================================

  licenseFormCard: {
    padding: spacing.section,
    marginBottom: spacing.section,
  },

  formHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.card,
  },

  tradeLabel: {
    fontSize: typography.body.fontSize,
    fontWeight: '600',
    color: colors.textPrimary,
  },

  requiredStar: {
    color: '#EF4444', // Red for required indicator
  },

  removeButton: {
    paddingVertical: spacing.card / 2,
    paddingHorizontal: spacing.card / 2,
  },

  removeButtonText: {
    fontSize: typography.body.fontSize,
    color: '#EF4444',
  },

  formFields: {
    gap: spacing.card,
  },

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

  // ========================================================================
  // Add Button
  // ========================================================================

  addButtonContainer: {
    marginBottom: spacing.section,
  },

  addButton: {
    backgroundColor: colors.glassPrimary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 12,
    padding: spacing.section,
    minHeight: MIN_TOUCH_TARGET_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
  },

  addButtonText: {
    fontSize: typography.body.fontSize,
    color: colors.textPrimary,
    fontWeight: '600',
  },

  // ========================================================================
  // Action Container
  // ========================================================================

  actionContainer: {
    marginTop: spacing.section,
  },

  skipButton: {
    alignSelf: 'center',
    paddingVertical: spacing.card,
    paddingHorizontal: spacing.section,
    marginTop: spacing.card,
  },

  skipButtonText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
  },
});
