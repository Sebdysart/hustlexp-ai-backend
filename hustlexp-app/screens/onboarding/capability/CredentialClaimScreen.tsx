/**
 * Credential Claim Screen (Capability Onboarding Phase 3) (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: CAPABILITY_PHASE_3
 * Spec Authority: HUSTLEXP-DOCS/architecture/CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 3
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. CONDITIONAL DISPLAY:
 *    - Only shown if regulated_trades.length > 0 (from PHASE 2)
 * 
 * 2. PURPOSE:
 *    - Assess whether user has licenses for regulated trades
 *    - Pre-checks eligibility without blocking onboarding
 *    - "No" or "I'm not sure" does NOT block onboarding
 * 
 * 3. BRANCHING LOGIC:
 *    - "Yes" → Proceed to PHASE 4 (License Metadata Capture)
 *    - "No" or "I'm not sure" → Skip to PHASE 5 (Insurance Claim)
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
 * License intent option.
 */
export type LicenseIntent = 'yes' | 'no' | 'unsure';

/**
 * Credential Claim Screen Props
 * 
 * Props for credential claim screen.
 */
export interface CredentialClaimScreenProps {
  /** Regulated trades selected in PHASE 2 */
  regulatedTrades: string[];
  
  /** Callback when intent is selected and Continue is pressed */
  onContinue?: (intent: LicenseIntent) => void;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Question prompt (exact wording from spec).
 */
const QUESTION_PROMPT = "Do you currently hold a valid license for any of these trades?";

/**
 * License intent options.
 */
const LICENSE_INTENT_OPTIONS: Array<{ value: LicenseIntent; label: string }> = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'unsure', label: "I'm not sure" },
];

/**
 * Messages for "No" intent (exact wording from spec).
 */
const NO_INTENT_MESSAGE = "You won't see licensed gigs until verification is complete. You'll still see eligible low-risk work.";

/**
 * Messages for "Unsure" intent (exact wording from spec).
 */
const UNSURE_INTENT_MESSAGE = "You can verify your license later in Settings. You'll still see eligible low-risk work.";

/**
 * Continue button label.
 */
const CONTINUE_BUTTON_LABEL = 'Continue';

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
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Credential Claim Screen
 * 
 * Capability Onboarding Phase 3 - License holding status (pre-check).
 * Conditional: Only shown if regulated_trades.length > 0.
 * 
 * PURPOSE:
 * - Assess whether user has licenses for regulated trades
 * - Pre-checks eligibility without blocking onboarding
 * 
 * BRANCHING LOGIC:
 * - "Yes" → Proceed to PHASE 4 (License Metadata Capture)
 * - "No" or "I'm not sure" → Skip to PHASE 5 (Insurance Claim)
 * 
 * @param props - Credential claim screen props
 * @returns React component
 */
export function CredentialClaimScreen({
  regulatedTrades,
  onContinue,
}: CredentialClaimScreenProps) {
  // ========================================================================
  // State
  // ========================================================================

  const [selectedIntent, setSelectedIntent] = useState<LicenseIntent | null>(
    null
  );

  // ========================================================================
  // Handlers
  // ========================================================================

  const handleContinue = () => {
    if (!selectedIntent) return; // Cannot proceed without selection
    onContinue?.(selectedIntent);
  };

  const handleSelectIntent = (intent: LicenseIntent) => {
    setSelectedIntent(intent);
  };

  // ========================================================================
  // Derived Values
  // ========================================================================

  const showNoMessage = selectedIntent === 'no';
  const showUnsureMessage = selectedIntent === 'unsure';

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

        {/* Regulated Trades List */}
        <GlassCard style={styles.tradesCard}>
          <Text style={styles.tradesLabel}>Selected trades:</Text>
          {regulatedTrades.map((trade) => (
            <View key={trade} style={styles.tradeRow}>
              <Text style={styles.tradeName}>{formatTradeName(trade)}</Text>
              <View style={styles.licenseBadge}>
                <Text style={styles.licenseBadgeText}>License required</Text>
              </View>
            </View>
          ))}
        </GlassCard>

        {/* Intent Options */}
        <View style={styles.optionsContainer}>
          {LICENSE_INTENT_OPTIONS.map((option) => (
            <TouchableOpacity
              key={option.value}
              style={[
                styles.optionButton,
                selectedIntent === option.value && styles.optionButtonSelected,
              ]}
              onPress={() => handleSelectIntent(option.value)}
              activeOpacity={0.8}
            >
              <Text
                style={[
                  styles.optionText,
                  selectedIntent === option.value && styles.optionTextSelected,
                ]}
              >
                {option.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Conditional Messages */}
        {showNoMessage && (
          <GlassCard style={styles.messageCard}>
            <Text style={styles.messageText}>{NO_INTENT_MESSAGE}</Text>
          </GlassCard>
        )}

        {showUnsureMessage && (
          <GlassCard style={styles.messageCard}>
            <Text style={styles.messageText}>{UNSURE_INTENT_MESSAGE}</Text>
          </GlassCard>
        )}

        {/* Continue Button */}
        <View style={styles.actionContainer}>
          <PrimaryActionButton
            label={CONTINUE_BUTTON_LABEL}
            onPress={handleContinue}
            disabled={!selectedIntent}
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
  // Trades Card
  // ========================================================================

  tradesCard: {
    padding: spacing.section,
    marginBottom: spacing.section,
  },

  tradesLabel: {
    fontSize: typography.body.fontSize,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.card,
  },

  tradeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.card / 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorderPrimary,
  },

  tradeName: {
    fontSize: typography.body.fontSize,
    color: colors.textPrimary,
  },

  licenseBadge: {
    backgroundColor: '#F59E0B', // Amber
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: spacing.card / 2,
  },

  licenseBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#FFFFFF',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
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
