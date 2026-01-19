/**
 * Framing Screen (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: ONBOARDING_FRAMING
 * Spec Authority: HUSTLEXP-DOCS/ONBOARDING_SPEC.md §14 (Phase 0 Framing Screen)
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. DESIGN PRINCIPLES (ONBOARDING_SPEC §14):
 *    - White or neutral surface background (NOT black like other screens)
 *    - No brand gradients
 *    - No motion
 *    - No progress indicator
 *    - Single CTA button
 * 
 * 2. PURPOSE: Establish system authority without asking permission
 * 
 * 3. UI-ONLY: NO role inference. NO data processing.
 *    - Simple framing screen before calibration questions
 *    - All data comes from props. Placeholder navigation handlers.
 * 
 * ============================================================================
 * COMPONENT DEPENDENCIES
 * ============================================================================
 * 
 * Required Components:
 * - PrimaryActionButton (hustlexp-app/ui/PrimaryActionButton.tsx)
 * 
 * Required Tokens:
 * - colors (hustlexp-app/ui/colors.ts) - NOTE: Uses neutral background per spec
 * - spacing (hustlexp-app/ui/spacing.ts)
 * - typography (hustlexp-app/ui/typography.ts)
 * 
 * ============================================================================
 */

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
} from 'react-native';

// Design System Imports
import { PrimaryActionButton } from '../../ui/PrimaryActionButton';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';
import { typography } from '../../ui/typography';

// ============================================================================
// TYPE DEFINITIONS (MAX-TIER: Explicit, Exhaustive, Documented)
// ============================================================================

/**
 * Framing Screen Props
 * 
 * Simple props for navigation only.
 */
export interface FramingScreenProps {
  /** Callback when Continue button is pressed */
  onContinue?: () => void;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Neutral background color for framing screen.
 * 
 * Per ONBOARDING_SPEC §14: White or neutral surface background.
 * This is the ONLY screen that uses neutral background (not black).
 */
const FRAMING_BACKGROUND = '#FFFFFF';

/**
 * Headline text.
 * 
 * Per ONBOARDING_SPEC §14: Establishes system authority without asking permission.
 */
const HEADLINE_TEXT = 'HustleXP supports two ways to use the platform.';

/**
 * Subheadline text.
 */
const SUBHEADLINE_TEXT = "We'll configure your experience based on how you respond.";

/**
 * Continue button label.
 */
const CONTINUE_BUTTON_LABEL = 'Continue';

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Framing Screen
 * 
 * Phase 0 Framing Screen - First screen users see in onboarding.
 * Establishes system authority without asking permission.
 * 
 * DESIGN PRINCIPLES (ONBOARDING_SPEC §14):
 * - White/neutral background (unique among app screens)
 * - No brand gradients
 * - No motion
 * - No progress indicator
 * - Single CTA button
 * 
 * Follows ONBOARDING_SPEC.md §14 exactly.
 * 
 * @param props - Framing screen props
 * @returns React component
 */
export function FramingScreen({
  onContinue,
}: FramingScreenProps) {
  // ========================================================================
  // Handlers
  // ========================================================================

  const handleContinue = () => {
    onContinue?.();
  };

  // ========================================================================
  // Render
  // ========================================================================

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.content}>
        {/* Text Container */}
        <View style={styles.textContainer}>
          <Text style={styles.headline}>{HEADLINE_TEXT}</Text>
          <Text style={styles.subheadline}>{SUBHEADLINE_TEXT}</Text>
        </View>

        {/* Action Container */}
        <View style={styles.actionContainer}>
          <PrimaryActionButton
            label={CONTINUE_BUTTON_LABEL}
            onPress={handleContinue}
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
    backgroundColor: FRAMING_BACKGROUND, // White/neutral per ONBOARDING_SPEC §14
  },

  content: {
    flex: 1,
    paddingHorizontal: spacing.card,
    justifyContent: 'center',
  },

  // ========================================================================
  // Text Container
  // ========================================================================

  textContainer: {
    marginBottom: spacing.section * 3, // 72px spacing
  },

  headline: {
    fontSize: typography.header.fontSize,
    fontWeight: typography.header.fontWeight,
    color: colors.background, // Black text on white background
    textAlign: 'center',
    marginBottom: spacing.card,
    lineHeight: 36,
  },

  subheadline: {
    fontSize: typography.body.fontSize,
    color: colors.muted, // Gray text for secondary content
    textAlign: 'center',
    lineHeight: 24,
  },

  // ========================================================================
  // Action Container
  // ========================================================================

  actionContainer: {
    marginTop: spacing.section * 2, // 48px spacing
  },
});
