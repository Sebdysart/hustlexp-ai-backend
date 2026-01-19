/**
 * Capability Declaration Screen (Capability Onboarding Phase 2) (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: CAPABILITY_PHASE_2
 * Spec Authority: HUSTLEXP-DOCS/architecture/CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 2
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. PURPOSE (CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 2):
 *    - Collect trade claims that unlock verification paths, NOT gig access
 *    - Selection does NOT unlock gigs (only verification paths)
 *    - Capability profile drives feed (not claims)
 * 
 * 2. BEHAVIORAL RULES:
 *    - Must select at least one trade (cannot proceed empty)
 *    - Can select multiple trades (checkboxes)
 *    - Regulated trades unlock PHASE 3 (Credential Claim)
 *    - Low-risk trades skip to PHASE 5 (Insurance Claim)
 * 
 * 3. MESSAGING:
 *    - "Claims not permissions" messaging enforced
 *    - No access-granting language
 *    - Helper text: "Verification is the next step"
 * 
 * ============================================================================
 * COMPONENT DEPENDENCIES
 * ============================================================================
 * 
 * Required Components:
 * - PrimaryActionButton (hustlexp-app/ui/PrimaryActionButton.tsx)
 * - GlassCard (hustlexp-app/ui/GlassCard.tsx)
 * - SectionHeader (hustlexp-app/ui/SectionHeader.tsx)
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
import { SectionHeader } from '../../../ui/SectionHeader';
import { colors } from '../../../ui/colors';
import { spacing } from '../../../ui/spacing';
import { typography } from '../../../ui/typography';

// ============================================================================
// TYPE DEFINITIONS (MAX-TIER: Explicit, Exhaustive, Documented)
// ============================================================================

/**
 * Trade type.
 * 
 * Represents a trade option for selection.
 */
export interface Trade {
  /** Trade ID (matches backend trade list) */
  id: string;
  
  /** Display label */
  label: string;
  
  /** Whether license is required */
  requiresLicense: boolean;
  
  /** Whether this is a regulated trade */
  isRegulated: boolean;
}

/**
 * Capability Declaration Screen Props
 * 
 * Props for capability declaration screen.
 */
export interface CapabilityDeclarationScreenProps {
  /** Callback when trades are selected and Continue is pressed */
  onContinue?: (claimedTrades: string[]) => void;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Question prompt (exact wording from spec).
 */
const QUESTION_PROMPT = "What types of work are you qualified to do?";

/**
 * Subtitle prompt (exact wording from spec).
 */
const SUBTITLE_PROMPT = "(Select all that apply)";

/**
 * Helper text (exact wording from spec).
 */
const HELPER_TEXT = "Select all trades you're qualified for. Verification is the next step.";

/**
 * Low-risk trades (no license typically required).
 * 
 * Per spec: Moving help, Yard work, Cleaning, Assembly, Errands
 */
const LOW_RISK_TRADES: Trade[] = [
  { id: 'moving', label: 'Moving help', requiresLicense: false, isRegulated: false },
  { id: 'yard_work', label: 'Yard work', requiresLicense: false, isRegulated: false },
  { id: 'cleaning', label: 'Cleaning', requiresLicense: false, isRegulated: false },
  { id: 'assembly', label: 'Assembly', requiresLicense: false, isRegulated: false },
  { id: 'errands', label: 'Errands', requiresLicense: false, isRegulated: false },
];

/**
 * Regulated trades (license required).
 * 
 * Per spec: Electrician, Plumber, HVAC, General contractor, Appliance install
 */
const REGULATED_TRADES: Trade[] = [
  { id: 'electrician', label: 'Electrician', requiresLicense: true, isRegulated: true },
  { id: 'plumber', label: 'Plumber', requiresLicense: true, isRegulated: true },
  { id: 'hvac', label: 'HVAC', requiresLicense: true, isRegulated: true },
  { id: 'general_contractor', label: 'General contractor', requiresLicense: true, isRegulated: true },
  { id: 'appliance_install', label: 'Appliance install', requiresLicense: true, isRegulated: true },
];

/**
 * License may be required trades.
 * 
 * Per spec: IT/networking, In-home care
 */
const LICENSE_MAY_BE_REQUIRED_TRADES: Trade[] = [
  { id: 'it_networking', label: 'IT / networking', requiresLicense: true, isRegulated: true },
  { id: 'in_home_care', label: 'In-home care', requiresLicense: true, isRegulated: true },
];

/**
 * License required badge text.
 */
const LICENSE_REQUIRED_BADGE = 'License required';

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
 * Trade Chip Component
 * 
 * Selectable chip/tag for trade selection.
 * Shows license required badge for regulated trades.
 */
function TradeChip({
  trade,
  isSelected,
  onToggle,
}: {
  trade: Trade;
  isSelected: boolean;
  onToggle: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.tradeChip, isSelected && styles.tradeChipSelected]}
      onPress={onToggle}
      activeOpacity={0.8}
    >
      <Text
        style={[styles.tradeChipText, isSelected && styles.tradeChipTextSelected]}
      >
        {trade.label}
      </Text>
      {trade.requiresLicense && (
        <View style={styles.licenseBadge}>
          <Text style={styles.licenseBadgeText}>{LICENSE_REQUIRED_BADGE}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Capability Declaration Screen
 * 
 * Capability Onboarding Phase 2 - Trade selection (claims only, no permissions).
 * Collects trade claims that unlock verification paths, not gig access.
 * 
 * PURPOSE (CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 2):
 * - Collect trade claims that unlock verification paths, NOT gig access
 * - Selection does NOT unlock gigs (capability profile drives feed)
 * 
 * BEHAVIORAL RULES:
 * - Must select at least one trade (cannot proceed empty)
 * - Can select multiple trades (checkboxes)
 * - Regulated trades unlock PHASE 3 (Credential Claim)
 * - Low-risk trades skip to PHASE 5 (Insurance Claim)
 * 
 * @param props - Capability declaration screen props
 * @returns React component
 */
export function CapabilityDeclarationScreen({
  onContinue,
}: CapabilityDeclarationScreenProps) {
  // ========================================================================
  // State
  // ========================================================================

  const [selectedTrades, setSelectedTrades] = useState<string[]>([]);

  // ========================================================================
  // Handlers
  // ========================================================================

  const handleToggleTrade = (tradeId: string) => {
    setSelectedTrades((prev) =>
      prev.includes(tradeId)
        ? prev.filter((id) => id !== tradeId)
        : [...prev, tradeId]
    );
  };

  const handleContinue = () => {
    if (selectedTrades.length === 0) return; // Must select at least one trade
    onContinue?.(selectedTrades);
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

        {/* Helper Text */}
        <Text style={styles.helperText}>{HELPER_TEXT}</Text>

        {/* Low-Risk Trades Section */}
        <GlassCard style={styles.sectionCard}>
          <SectionHeader title="Low-Risk (No License Typically Required)" />
          <View style={styles.tradesGrid}>
            {LOW_RISK_TRADES.map((trade) => (
              <TradeChip
                key={trade.id}
                trade={trade}
                isSelected={selectedTrades.includes(trade.id)}
                onToggle={() => handleToggleTrade(trade.id)}
              />
            ))}
          </View>
        </GlassCard>

        {/* Regulated Trades Section */}
        <GlassCard style={styles.sectionCard}>
          <SectionHeader title="Trade / Regulated" />
          <View style={styles.tradesGrid}>
            {REGULATED_TRADES.map((trade) => (
              <TradeChip
                key={trade.id}
                trade={trade}
                isSelected={selectedTrades.includes(trade.id)}
                onToggle={() => handleToggleTrade(trade.id)}
              />
            ))}
          </View>
        </GlassCard>

        {/* License May Be Required Section */}
        {LICENSE_MAY_BE_REQUIRED_TRADES.length > 0 && (
          <GlassCard style={styles.sectionCard}>
            <SectionHeader title="License May Be Required" />
            <View style={styles.tradesGrid}>
              {LICENSE_MAY_BE_REQUIRED_TRADES.map((trade) => (
                <TradeChip
                  key={trade.id}
                  trade={trade}
                  isSelected={selectedTrades.includes(trade.id)}
                  onToggle={() => handleToggleTrade(trade.id)}
                />
              ))}
            </View>
          </GlassCard>
        )}

        {/* Continue Button */}
        <View style={styles.actionContainer}>
          <PrimaryActionButton
            label={CONTINUE_BUTTON_LABEL}
            onPress={handleContinue}
            disabled={selectedTrades.length === 0}
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
    marginBottom: spacing.card,
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

  helperText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
    marginBottom: spacing.section,
  },

  // ========================================================================
  // Section Cards
  // ========================================================================

  sectionCard: {
    padding: spacing.section,
    marginBottom: spacing.section,
  },

  // ========================================================================
  // Trades Grid
  // ========================================================================

  tradesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.card / 2,
    marginTop: spacing.card,
  },

  tradeChip: {
    backgroundColor: colors.glassSecondary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 8,
    paddingVertical: spacing.card / 2,
    paddingHorizontal: spacing.card,
    minHeight: MIN_TOUCH_TARGET_HEIGHT, // A4: ≥44px
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.card / 2,
  },

  tradeChipSelected: {
    borderColor: colors.textPrimary,
    borderWidth: 2,
    backgroundColor: colors.glassPrimary,
  },

  tradeChipText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
  },

  tradeChipTextSelected: {
    color: colors.textPrimary,
    fontWeight: '600',
  },

  // ========================================================================
  // License Badge
  // ========================================================================

  licenseBadge: {
    backgroundColor: '#F59E0B', // Amber color for "License required"
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
  // Action Container
  // ========================================================================

  actionContainer: {
    marginTop: spacing.section,
  },
});
