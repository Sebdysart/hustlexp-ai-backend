/**
 * Role Confirmation Screen (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: ONBOARDING_ROLE_CONFIRMATION
 * Spec Authority: HUSTLEXP-DOCS/ONBOARDING_SPEC.md §3 (Phase 3: Authority Confirmation)
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. CERTAINTY TIER BEHAVIOR (ONBOARDING_SPEC §3):
 *    - STRONG (≥0.75): "We'll set you up as..." with role display
 *    - MODERATE (0.60-0.74): "you seem like a..." with softer copy
 *    - WEAK (<0.60): Force explicit choice, no inferred role
 * 
 * 2. UI-ONLY: NO role inference computation.
 *    - Inferred role and certainty tier come from props
 *    - All computation happens outside this component
 * 
 * 3. DESIGN PRINCIPLES:
 *    - Authority-establishing copy (not friendly)
 *    - Confidence indicators for STRONG/MODERATE only
 *    - Explicit choice required for WEAK tier
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
  ScrollView,
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
 * Role type.
 * 
 * User role: Worker or Poster.
 */
export type UserRole = 'worker' | 'poster';

/**
 * Certainty tier.
 * 
 * Determines UI behavior and copy.
 */
export type CertaintyTier = 'STRONG' | 'MODERATE' | 'WEAK';

/**
 * Role display information.
 * 
 * Display labels for each role.
 */
export interface RoleDisplay {
  /** Role title */
  title: string;
  
  /** Role description */
  description: string;
}

/**
 * Role Confirmation Screen Props
 * 
 * Props for role confirmation with certainty tier behavior.
 */
export interface RoleConfirmationScreenProps {
  /** Inferred role (from calibration responses) */
  inferredRole?: UserRole;
  
  /** Certainty tier (STRONG, MODERATE, or WEAK) */
  certaintyTier: CertaintyTier;
  
  /** Role confidence value (0-1, optional for display) */
  confidence?: number;
  
  /** Whether responses showed inconsistencies */
  hasInconsistencies?: boolean;
  
  /** Callback when Continue is pressed */
  onContinue?: (selectedRole: UserRole) => void;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Role display information.
 * 
 * Maps role to display text.
 */
const ROLE_DISPLAY: Record<UserRole, RoleDisplay> = {
  worker: {
    title: 'Worker',
    description: 'Earn by completing tasks',
  },
  poster: {
    title: 'Poster',
    description: 'Get things done by others',
  },
} as const;

/**
 * Confirmation copy by certainty tier.
 * 
 * Headlines and subtexts vary by certainty tier per ONBOARDING_SPEC §3.
 */
const CONFIRMATION_COPY = {
  STRONG: {
    headline: "We'll set you up as a",
    subtext: null,
    requiresExplicitChoice: false,
  },
  MODERATE: {
    headline: 'Based on your responses, you seem like a',
    subtext: "You can adjust this if it doesn't feel right.",
    requiresExplicitChoice: false,
  },
  WEAK: {
    headline: "We couldn't determine your primary use case",
    subtext: "Please select how you'll mainly use HustleXP:",
    requiresExplicitChoice: true,
  },
} as const;

/**
 * Minimum touch target height (A4 accessibility requirement).
 */
const MIN_TOUCH_TARGET_HEIGHT = 44;

// ============================================================================
// HELPER FUNCTIONS (MAX-TIER: Pure, Documented, Type-Safe)
// ============================================================================

/**
 * Gets confirmation copy for certainty tier.
 * 
 * @param tier - Certainty tier
 * @returns Confirmation copy object
 */
function getConfirmationCopy(tier: CertaintyTier) {
  return CONFIRMATION_COPY[tier];
}

// ============================================================================
// SUB-COMPONENTS (MAX-TIER: Modular, Reusable, Documented)
// ============================================================================

/**
 * Role Selection Button Component
 * 
 * Button for selecting a role (used in WEAK tier or adjust mode).
 */
function RoleSelectionButton({
  role,
  isSelected,
  onSelect,
}: {
  role: UserRole;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const roleInfo = ROLE_DISPLAY[role];

  return (
    <TouchableOpacity
      style={[
        styles.roleSelectionButton,
        isSelected && styles.roleSelectionButtonSelected,
      ]}
      onPress={onSelect}
      activeOpacity={0.8}
    >
      <Text
        style={[
          styles.roleSelectionTitle,
          isSelected && styles.roleSelectionTitleSelected,
        ]}
      >
        {roleInfo.title}
      </Text>
      <Text
        style={[
          styles.roleSelectionDescription,
          isSelected && styles.roleSelectionDescriptionSelected,
        ]}
      >
        {roleInfo.description}
      </Text>
    </TouchableOpacity>
  );
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Role Confirmation Screen
 * 
 * Phase 3 Authority Confirmation - Confirms or requests explicit role selection
 * based on calibration responses. UI behavior varies by certainty tier.
 * 
 * CERTAINTY TIER BEHAVIOR (ONBOARDING_SPEC §3):
 * - STRONG (≥0.75): "We'll set you up as..." with inferred role
 * - MODERATE (0.60-0.74): "you seem like a..." with softer copy
 * - WEAK (<0.60): Force explicit choice, no inferred role
 * 
 * Follows ONBOARDING_SPEC.md §3 exactly.
 * 
 * @param props - Role confirmation screen props
 * @returns React component
 */
export function RoleConfirmationScreen({
  inferredRole,
  certaintyTier,
  confidence,
  hasInconsistencies = false,
  onContinue,
}: RoleConfirmationScreenProps) {
  // ========================================================================
  // State
  // ========================================================================

  const confirmationCopy = getConfirmationCopy(certaintyTier);
  const requiresExplicitChoice = confirmationCopy.requiresExplicitChoice;

  const [selectedRole, setSelectedRole] = useState<UserRole | null>(
    requiresExplicitChoice ? null : inferredRole || null
  );
  const [showAdjust, setShowAdjust] = useState(false);

  // ========================================================================
  // Handlers
  // ========================================================================

  const handleContinue = () => {
    if (!selectedRole) return; // Cannot continue without selection
    onContinue?.(selectedRole);
  };

  const handleToggleRole = (role: UserRole) => {
    setSelectedRole(role);
  };

  // ========================================================================
  // Render
  // ========================================================================

  const displayRole = selectedRole || inferredRole;
  const shouldShowRoleDisplay =
    displayRole && !requiresExplicitChoice && !showAdjust;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Header - Copy varies by certainty tier */}
        <View style={styles.headerContainer}>
          {certaintyTier !== 'WEAK' && (
            <Text style={styles.subtitle}>Based on your responses</Text>
          )}
          <Text style={styles.title}>{confirmationCopy.headline}</Text>
          {confirmationCopy.subtext && (
            <Text style={styles.subtext}>{confirmationCopy.subtext}</Text>
          )}
        </View>

        {/* Role Display - Only show if not forcing explicit choice */}
        {shouldShowRoleDisplay && displayRole && (
          <View style={styles.roleContainer}>
            <Text style={styles.roleTitle}>
              {ROLE_DISPLAY[displayRole].title}
            </Text>
            <Text style={styles.roleDescription}>
              {ROLE_DISPLAY[displayRole].description}
            </Text>
          </View>
        )}

        {/* Confidence Indicator - Subtle, hide for WEAK */}
        {certaintyTier !== 'WEAK' && confidence !== undefined && confidence > 0.3 && (
          <View style={styles.confidenceContainer}>
            <View style={styles.confidenceBar}>
              <View
                style={[
                  styles.confidenceFill,
                  {
                    width: `${confidence * 100}%`,
                    backgroundColor:
                      certaintyTier === 'STRONG'
                        ? colors.textPrimary
                        : colors.muted,
                  },
                ]}
              />
            </View>
          </View>
        )}

        {/* Inconsistency Notice - Subtle */}
        {hasInconsistencies && (
          <View style={styles.inconsistencyNotice}>
            <Text style={styles.inconsistencyText}>
              Your responses showed mixed signals — that's okay, most people use
              both sides.
            </Text>
          </View>
        )}

        {/* Role Selection - Always show for WEAK, toggle for others */}
        {requiresExplicitChoice || showAdjust ? (
          <View style={styles.roleToggleContainer}>
            <RoleSelectionButton
              role="worker"
              isSelected={selectedRole === 'worker'}
              onSelect={() => handleToggleRole('worker')}
            />
            <RoleSelectionButton
              role="poster"
              isSelected={selectedRole === 'poster'}
              onSelect={() => handleToggleRole('poster')}
            />
          </View>
        ) : (
          <TouchableOpacity
            style={styles.adjustButton}
            onPress={() => setShowAdjust(true)}
          >
            <Text style={styles.adjustButtonText}>Adjust role</Text>
          </TouchableOpacity>
        )}

        {/* Continue Button */}
        <View style={styles.actionContainer}>
          <PrimaryActionButton
            label="Continue"
            onPress={handleContinue}
            disabled={!selectedRole}
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
  // Header
  // ========================================================================

  headerContainer: {
    marginBottom: spacing.section * 2,
    alignItems: 'center',
  },

  subtitle: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    marginBottom: spacing.card,
    textAlign: 'center',
  },

  title: {
    fontSize: typography.header.fontSize,
    fontWeight: typography.header.fontWeight,
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: spacing.card,
    lineHeight: 36,
  },

  subtext: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
    marginTop: spacing.card,
  },

  // ========================================================================
  // Role Display
  // ========================================================================

  roleContainer: {
    alignItems: 'center',
    marginBottom: spacing.section * 2,
  },

  roleTitle: {
    fontSize: 48,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.card / 2,
  },

  roleDescription: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
  },

  // ========================================================================
  // Confidence Indicator
  // ========================================================================

  confidenceContainer: {
    width: '100%',
    marginBottom: spacing.section,
    alignItems: 'center',
  },

  confidenceBar: {
    width: '60%',
    height: 2,
    backgroundColor: colors.glassBorderSecondary,
    borderRadius: 1,
  },

  confidenceFill: {
    height: 2,
    borderRadius: 1,
  },

  // ========================================================================
  // Inconsistency Notice
  // ========================================================================

  inconsistencyNotice: {
    backgroundColor: colors.glassPrimary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 12,
    padding: spacing.card,
    marginBottom: spacing.section,
  },

  inconsistencyText: {
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center',
  },

  // ========================================================================
  // Role Selection
  // ========================================================================

  roleToggleContainer: {
    gap: spacing.card,
    marginBottom: spacing.section,
  },

  roleSelectionButton: {
    backgroundColor: colors.glassPrimary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 12,
    padding: spacing.section,
    minHeight: MIN_TOUCH_TARGET_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
  },

  roleSelectionButtonSelected: {
    borderColor: colors.textPrimary,
    borderWidth: 2,
  },

  roleSelectionTitle: {
    fontSize: typography.header.fontSize,
    fontWeight: typography.header.fontWeight,
    color: colors.textPrimary,
    marginBottom: spacing.card / 2,
  },

  roleSelectionTitleSelected: {
    color: colors.textPrimary,
  },

  roleSelectionDescription: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
  },

  roleSelectionDescriptionSelected: {
    color: colors.textPrimary,
  },

  // ========================================================================
  // Adjust Button
  // ========================================================================

  adjustButton: {
    alignSelf: 'center',
    paddingVertical: spacing.card,
    paddingHorizontal: spacing.section,
    marginBottom: spacing.section,
  },

  adjustButtonText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
  },

  // ========================================================================
  // Action Container
  // ========================================================================

  actionContainer: {
    marginTop: spacing.section,
  },
});
