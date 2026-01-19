/**
 * Capability Summary Screen (Capability Onboarding Phase 7) (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: CAPABILITY_PHASE_7
 * Spec Authority: HUSTLEXP-DOCS/architecture/CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 7
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. PURPOSE (CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 7):
 *    - Confirm onboarding completion
 *    - Show verification paths
 *    - Guide next steps
 * 
 * 2. WHAT YOU MUST NOT SHOW:
 *    - ❌ Rejected tasks (feed is filtered, no rejected tasks visible)
 *    - ❌ Disabled apply buttons (feed only shows eligible tasks)
 *    - ❌ Confusing errors (onboarding is clear, errors are preempted)
 *    - ❌ "Why was I rejected?" messaging (users never rejected, just not shown)
 * 
 * 3. NEXT ACTIONS:
 *    - Primary: "Start Verification" (if verification paths unlocked)
 *    - Secondary: "Explore Feed" (always visible)
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

import React from 'react';
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
 * Verification path.
 * 
 * Represents an unlocked verification path.
 */
export interface VerificationPath {
  /** Trade ID */
  trade: string;
  
  /** Status */
  status: 'pending';
  
  /** Requirements */
  requirements: string[];
  
  /** Estimated duration (optional) */
  estimatedDuration?: string;
}

/**
 * Capability Summary Screen Props
 * 
 * Props for capability summary screen.
 */
export interface CapabilitySummaryScreenProps {
  /** Work state from PHASE 1 */
  workState?: string;
  
  /** Work region from PHASE 1 */
  workRegion?: string;
  
  /** Claimed trades from PHASE 2 */
  claimedTrades: string[];
  
  /** License claims from PHASE 4 (if applicable) */
  licenseClaims?: Array<{ trade: string; licenseNumber: string; state: string }>;
  
  /** Insurance claimed from PHASE 5 */
  insuranceClaimed: boolean;
  
  /** COI uploaded from PHASE 5 */
  coiUploaded?: boolean;
  
  /** Risk preferences from PHASE 6 */
  riskPreferences?: { inHome: boolean; urgent: boolean; highValue: boolean };
  
  /** Verification paths unlocked */
  verificationPaths?: VerificationPath[];
  
  /** Callback when "Start Verification" is pressed */
  onStartVerification?: () => void;
  
  /** Callback when "Explore Feed" is pressed */
  onExploreFeed?: () => void;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Header text (exact wording from spec).
 */
const HEADER_TITLE = "You're set up to earn on HustleXP";

/**
 * Status labels.
 */
const STATUS_LABELS = {
  set: 'Set',
  active: 'Active',
  verificationPending: 'Verification pending',
  notVerified: 'Not verified',
  preferencesSaved: 'Preferences saved',
  notRequired: 'Not required for low-risk work',
} as const;

/**
 * Button labels.
 */
const BUTTON_LABELS = {
  startVerification: 'Start Verification',
  exploreFeed: 'Explore Feed',
  uploadCOI: 'Upload COI',
  addInsurance: 'Add insurance',
} as const;

/**
 * Format trade name for display.
 */
function formatTradeName(tradeId: string): string {
  return tradeId
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Check if trade is regulated.
 */
function isRegulatedTrade(tradeId: string): boolean {
  const regulatedTrades = [
    'electrician',
    'plumber',
    'hvac',
    'general_contractor',
    'appliance_install',
    'it_networking',
    'in_home_care',
  ];
  return regulatedTrades.includes(tradeId);
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Capability Summary Screen
 * 
 * Capability Onboarding Phase 7 - Summary & Next Actions (Critical UX Moment).
 * Confirms onboarding completion, shows verification paths, and guides next steps.
 * 
 * PURPOSE (CAPABILITY_DRIVEN_ONBOARDING_LOCKED.md §PHASE 7):
 * - Confirm onboarding completion
 * - Show verification paths
 * - Guide next steps
 * 
 * WHAT YOU MUST NOT SHOW:
 * - ❌ Rejected tasks (feed is filtered, no rejected tasks visible)
 * - ❌ Disabled apply buttons (feed only shows eligible tasks)
 * - ❌ Confusing errors
 * - ❌ "Why was I rejected?" messaging
 * 
 * @param props - Capability summary screen props
 * @returns React component
 */
export function CapabilitySummaryScreen({
  workState,
  workRegion,
  claimedTrades,
  licenseClaims = [],
  insuranceClaimed,
  coiUploaded = false,
  riskPreferences,
  verificationPaths = [],
  onStartVerification,
  onExploreFeed,
}: CapabilitySummaryScreenProps) {
  // ========================================================================
  // Derived Values
  // ========================================================================

  const regulatedTrades = claimedTrades.filter(isRegulatedTrade);
  const lowRiskTrades = claimedTrades.filter((t) => !isRegulatedTrade(t));
  const hasVerificationPaths = verificationPaths.length > 0;

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
        {/* Header */}
        <View style={styles.headerContainer}>
          <Text style={styles.headerTitle}>{HEADER_TITLE}</Text>
        </View>

        {/* Location Section */}
        <GlassCard style={styles.sectionCard}>
          <SectionHeader title="Location" />
          <View style={styles.sectionContent}>
            <Text style={styles.locationText}>
              {workState}
              {workRegion && `, ${workRegion}`}
            </Text>
            <View style={styles.statusBadge}>
              <Text style={styles.statusBadgeText}>{STATUS_LABELS.set} ✓</Text>
            </View>
          </View>
        </GlassCard>

        {/* Trades Section */}
        <GlassCard style={styles.sectionCard}>
          <SectionHeader title="Trades" />
          <View style={styles.sectionContent}>
            {/* Low-Risk Trades */}
            {lowRiskTrades.map((trade) => (
              <View key={trade} style={styles.tradeRow}>
                <Text style={styles.tradeName}>{formatTradeName(trade)}</Text>
                <View style={[styles.statusBadge, styles.statusBadgeActive]}>
                  <Text style={styles.statusBadgeText}>{STATUS_LABELS.active}</Text>
                </View>
              </View>
            ))}

            {/* Regulated Trades */}
            {regulatedTrades.map((trade) => {
              const hasLicenseClaim = licenseClaims.some(
                (lc) => lc.trade === trade
              );
              const isPending = hasLicenseClaim;
              const isNotVerified = !hasLicenseClaim;

              return (
                <View key={trade} style={styles.tradeRow}>
                  <Text style={styles.tradeName}>{formatTradeName(trade)}</Text>
                  <View
                    style={[
                      styles.statusBadge,
                      isPending && styles.statusBadgePending,
                      isNotVerified && styles.statusBadgeNotVerified,
                    ]}
                  >
                    <Text style={styles.statusBadgeText}>
                      {isPending
                        ? STATUS_LABELS.verificationPending
                        : STATUS_LABELS.notVerified}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        </GlassCard>

        {/* Insurance Section */}
        <GlassCard style={styles.sectionCard}>
          <SectionHeader title="Insurance" />
          <View style={styles.sectionContent}>
            {insuranceClaimed ? (
              <>
                <Text style={styles.insuranceText}>Insurance claimed</Text>
                {!coiUploaded && (
                  <TouchableOpacity style={styles.actionButton}>
                    <Text style={styles.actionButtonText}>
                      {BUTTON_LABELS.uploadCOI}
                    </Text>
                  </TouchableOpacity>
                )}
              </>
            ) : (
              <>
                <Text style={styles.insuranceText}>
                  {STATUS_LABELS.notRequired}
                </Text>
                <TouchableOpacity style={styles.actionButton}>
                  <Text style={styles.actionButtonText}>
                    {BUTTON_LABELS.addInsurance}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </GlassCard>

        {/* Risk Preferences Section */}
        {riskPreferences && (
          <GlassCard style={styles.sectionCard}>
            <SectionHeader title="Risk Preferences" />
            <View style={styles.sectionContent}>
              {Object.entries(riskPreferences)
                .filter(([_, value]) => value)
                .map(([key]) => (
                  <Text key={key} style={styles.preferenceText}>
                    {formatTradeName(key)}
                  </Text>
                ))}
              <View style={styles.statusBadge}>
                <Text style={styles.statusBadgeText}>
                  {STATUS_LABELS.preferencesSaved} ✓
                </Text>
              </View>
            </View>
          </GlassCard>
        )}

        {/* Next Actions */}
        <View style={styles.actionsContainer}>
          {hasVerificationPaths && (
            <PrimaryActionButton
              label={BUTTON_LABELS.startVerification}
              onPress={onStartVerification}
            />
          )}
          <PrimaryActionButton
            label={BUTTON_LABELS.exploreFeed}
            onPress={onExploreFeed}
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

  headerTitle: {
    fontSize: typography.header.fontSize,
    fontWeight: typography.header.fontWeight,
    color: colors.textPrimary,
    textAlign: 'center',
    lineHeight: 36,
  },

  // ========================================================================
  // Section Card
  // ========================================================================

  sectionCard: {
    padding: spacing.section,
    marginBottom: spacing.section,
  },

  sectionContent: {
    gap: spacing.card,
    marginTop: spacing.card,
  },

  // ========================================================================
  // Location
  // ========================================================================

  locationText: {
    fontSize: typography.body.fontSize,
    color: colors.textPrimary,
  },

  // ========================================================================
  // Trades
  // ========================================================================

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

  // ========================================================================
  // Status Badge
  // ========================================================================

  statusBadge: {
    backgroundColor: colors.glassSecondary,
    borderRadius: 4,
    paddingVertical: 4,
    paddingHorizontal: spacing.card / 2,
  },

  statusBadgeActive: {
    backgroundColor: '#10B981', // Green
  },

  statusBadgePending: {
    backgroundColor: '#F59E0B', // Amber
  },

  statusBadgeNotVerified: {
    backgroundColor: colors.glassSecondary,
  },

  statusBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#FFFFFF',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // ========================================================================
  // Insurance
  // ========================================================================

  insuranceText: {
    fontSize: typography.body.fontSize,
    color: colors.textPrimary,
  },

  // ========================================================================
  // Preferences
  // ========================================================================

  preferenceText: {
    fontSize: typography.body.fontSize,
    color: colors.textPrimary,
  },

  // ========================================================================
  // Action Button
  // ========================================================================

  actionButton: {
    backgroundColor: colors.glassPrimary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 8,
    paddingVertical: spacing.card / 2,
    paddingHorizontal: spacing.card,
    alignSelf: 'flex-start',
  },

  actionButtonText: {
    fontSize: typography.body.fontSize,
    color: colors.textPrimary,
    fontWeight: '600',
  },

  // ========================================================================
  // Actions Container
  // ========================================================================

  actionsContainer: {
    marginTop: spacing.section,
    gap: spacing.card,
  },
});
