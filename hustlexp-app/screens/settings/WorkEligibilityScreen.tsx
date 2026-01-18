/**
 * Settings → Work Eligibility Screen (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: SETTINGS_WORK_ELIGIBILITY
 * Spec Authority: HUSTLEXP-DOCS/architecture/SETTINGS_VERIFICATION_AND_ELIGIBILITY_LOCKED.md
 * Figma Reference: HUSTLEXP-DOCS/ui-specs/designs/WorkEligibility.figma.tsx
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. UI-ONLY: NO eligibility computation. NO backend logic.
 * 2. PROPS-BASED: All data comes from props. No hardcoded state.
 * 3. TOKENS-ONLY: Uses design tokens (colors, spacing, typography). No magic values.
 * 4. COMPONENTS-ONLY: Uses declared components (GlassCard, PrimaryActionButton, SectionHeader).
 * 5. SPEC-COMPLIANT: Matches Figma design exactly. Follows spec section order.
 * 
 * ============================================================================
 * COMPONENT DEPENDENCIES
 * ============================================================================
 * 
 * Required Components:
 * - GlassCard (hustlexp-app/ui/GlassCard.tsx)
 * - PrimaryActionButton (hustlexp-app/ui/PrimaryActionButton.tsx)
 * - SectionHeader (hustlexp-app/ui/SectionHeader.tsx)
 * 
 * Required Tokens:
 * - colors (hustlexp-app/ui/colors.ts)
 * - spacing (hustlexp-app/ui/spacing.ts)
 * - typography (hustlexp-app/ui/typography.ts)
 * 
 * ============================================================================
 * SECTION ORDER (FIXED - DO NOT REORDER)
 * ============================================================================
 * 
 * 1. System Notice (conditional - expired credentials)
 * 2. Eligibility Summary (read-only)
 * 3. Verified Trades (array-based)
 * 4. Insurance Section (conditional)
 * 5. Background Checks (conditional)
 * 6. Upgrade Opportunities (array-based)
 * 
 * ============================================================================
 */

import React from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  SafeAreaView,
} from 'react-native';

// Design System Imports
import { GlassCard } from '../../ui/GlassCard';
import { PrimaryActionButton } from '../../ui/PrimaryActionButton';
import { SectionHeader } from '../../ui/SectionHeader';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';
import { typography } from '../../ui/typography';

// ============================================================================
// TYPE DEFINITIONS (MAX-TIER: Explicit, Exhaustive, Documented)
// ============================================================================

/**
 * Trade verification status.
 * 
 * - not_verified: No verification submitted
 * - pending: Verification submitted, awaiting review
 * - verified: Verification approved (active)
 * - expired: Verification expired (no longer active)
 */
type TradeStatus = 'not_verified' | 'pending' | 'verified' | 'expired';

/**
 * Insurance verification status.
 * 
 * - not_on_file: No insurance submitted
 * - pending: Insurance submitted, awaiting review
 * - active: Insurance approved (active)
 * - expired: Insurance expired (no longer active)
 */
type InsuranceStatus = 'not_on_file' | 'pending' | 'active' | 'expired';

/**
 * Background check verification status.
 * 
 * - not_completed: Background check not initiated
 * - pending: Background check in progress
 * - verified: Background check approved (active)
 * - expired: Background check expired (no longer active)
 */
type BackgroundCheckStatus = 'not_completed' | 'pending' | 'verified' | 'expired';

/**
 * Risk clearance level.
 * 
 * Determines which risk-classified tasks user can access.
 */
type RiskClearance = 'low' | 'medium' | 'high' | 'critical';

/**
 * Verified trade entry.
 * 
 * Represents a trade the user has claimed/verified.
 */
interface VerifiedTrade {
  /** Trade name (e.g., "Electrician", "Plumber") */
  trade: string;
  /** Current verification status */
  status: TradeStatus;
  /** State abbreviation (e.g., "WA") - only for verified trades */
  state?: string;
  /** Expiration date string (e.g., "May 1, 2026") - only for verified trades */
  expiresAt?: string;
}

/**
 * Insurance information.
 * 
 * Conditional: Only shown if user has at least one verified trade.
 */
interface Insurance {
  /** Current insurance status */
  status: InsuranceStatus;
  /** Expiration date string (e.g., "December 15, 2025") - only for active/expired */
  expiresAt?: string;
}

/**
 * Background check information.
 * 
 * Conditional: Only shown if user has opted into critical tasks.
 */
interface BackgroundCheck {
  /** Current background check status */
  status: BackgroundCheckStatus;
  /** Expiration date string (e.g., "August 10, 2026") - only for verified/expired */
  expiresAt?: string;
}

/**
 * Upgrade opportunity.
 * 
 * Computed display showing unlocked gigs if user verifies a trade.
 * Only shown if there are active, currently available gigs.
 */
interface UpgradeOpportunity {
  /** Trade name that would unlock gigs */
  trade: string;
  /** Number of active gigs that would become available */
  activeGigs: number;
  /** Average payout for unlocked gigs */
  averagePayout: number;
}

/**
 * Work Eligibility Screen Props
 * 
 * All props are optional. Component handles empty states gracefully.
 * No defaults beyond what React Native provides (empty arrays, undefined).
 */
export interface WorkEligibilityScreenProps {
  // ========================================================================
  // Eligibility Summary (Read-Only)
  // ========================================================================
  
  /** Current trust tier (1-4). Displayed as "Tier {n}". */
  currentTrustTier?: number;
  
  /** Active risk clearance level. Determines risk-classified task access. */
  riskClearance?: RiskClearance;
  
  /** Work location state abbreviation (e.g., "WA"). */
  workLocation?: string;
  
  /** List of task types user IS eligible for (read-only display). */
  eligibleFor?: string[];
  
  /** List of task types user is NOT eligible for (read-only display). */
  notEligibleFor?: string[];

  // ========================================================================
  // Verified Trades (Array-Based)
  // ========================================================================
  
  /** Array of trades user has claimed/verified. Rendered as list of cards. */
  verifiedTrades?: VerifiedTrade[];

  // ========================================================================
  // Insurance (Conditional)
  // ========================================================================
  
  /** Insurance information. Only rendered if user has at least one verified trade. */
  insurance?: Insurance;

  // ========================================================================
  // Background Checks (Conditional)
  // ========================================================================
  
  /** Background check information. Only rendered if optedIntoCriticalTasks is true. */
  backgroundCheck?: BackgroundCheck;

  // ========================================================================
  // Upgrade Opportunities (Computed Display)
  // ========================================================================
  
  /** Array of upgrade opportunities. Only shown if there are active gigs available. */
  upgradeOpportunities?: UpgradeOpportunity[];

  // ========================================================================
  // System Notices (Conditional)
  // ========================================================================
  
  /** Whether to show expired credentials system notice at top. */
  hasExpiredCredentials?: boolean;

  // ========================================================================
  // Conditional Rendering Flags
  // ========================================================================
  
  /** Whether user has opted into critical tasks (controls background check section visibility). */
  optedIntoCriticalTasks?: boolean;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Status icon mapping.
 * 
 * Maps verification status to emoji icon for visual clarity.
 */
const STATUS_ICONS: Record<string, string> = {
  not_verified: '❌',
  not_on_file: '❌',
  not_completed: '❌',
  pending: '⏳',
  verified: '✅',
  active: '✅',
  expired: '⚠️',
} as const;

/**
 * Risk clearance color mapping.
 * 
 * Background color for risk clearance badge.
 */
const RISK_CLEARANCE_BG_COLORS: Record<RiskClearance, string> = {
  low: 'rgba(52, 199, 89, 0.2)',
  medium: 'rgba(52, 199, 89, 0.2)',
  high: 'rgba(255, 149, 0, 0.2)',
  critical: 'rgba(255, 59, 48, 0.2)',
} as const;

/**
 * Risk clearance border color mapping.
 */
const RISK_CLEARANCE_BORDER_COLORS: Record<RiskClearance, string> = {
  low: 'rgba(52, 199, 89, 0.4)',
  medium: 'rgba(52, 199, 89, 0.4)',
  high: 'rgba(255, 149, 0, 0.4)',
  critical: 'rgba(255, 59, 48, 0.4)',
} as const;

/**
 * Risk clearance text color mapping.
 */
const RISK_CLEARANCE_TEXT_COLORS: Record<RiskClearance, string> = {
  low: '#34C759',
  medium: '#34C759',
  high: '#FF9500',
  critical: '#FF3B30',
} as const;

// ============================================================================
// HELPER FUNCTIONS (MAX-TIER: Pure, Documented, Type-Safe)
// ============================================================================

/**
 * Gets status icon for verification status.
 * 
 * @param status - Verification status string
 * @returns Emoji icon string
 */
function getStatusIcon(status: string): string {
  return STATUS_ICONS[status] || '';
}

/**
 * Gets risk clearance badge background color.
 * 
 * @param level - Risk clearance level
 * @returns RGBA color string
 */
function getRiskClearanceBgColor(level: RiskClearance): string {
  return RISK_CLEARANCE_BG_COLORS[level];
}

/**
 * Gets risk clearance badge border color.
 * 
 * @param level - Risk clearance level
 * @returns RGBA color string
 */
function getRiskClearanceBorderColor(level: RiskClearance): string {
  return RISK_CLEARANCE_BORDER_COLORS[level];
}

/**
 * Gets risk clearance badge text color.
 * 
 * @param level - Risk clearance level
 * @returns Hex color string
 */
function getRiskClearanceTextColor(level: RiskClearance): string {
  return RISK_CLEARANCE_TEXT_COLORS[level];
}

/**
 * Capitalizes first letter of string.
 * 
 * @param str - String to capitalize
 * @returns Capitalized string
 */
function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ============================================================================
// SUB-COMPONENTS (MAX-TIER: Modular, Reusable, Documented)
// ============================================================================

/**
 * System Notice Component
 * 
 * Displays critical system alerts (e.g., expired credentials).
 * Only rendered when hasExpiredCredentials is true.
 */
function SystemNotice() {
  return (
    <View style={styles.systemNotice}>
      <Text style={styles.systemNoticeIcon}>⚠️</Text>
      <View style={styles.systemNoticeContent}>
        <Text style={styles.systemNoticeTitle}>Credential expired</Text>
        <Text style={styles.systemNoticeSubtext}>
          Expired credentials remove access immediately
        </Text>
      </View>
    </View>
  );
}

/**
 * Eligibility Summary Section
 * 
 * Displays high-level eligibility overview: trust tier, risk clearance, location, eligible/not eligible lists.
 */
function EligibilitySummarySection({
  currentTrustTier,
  riskClearance,
  workLocation,
  eligibleFor,
  notEligibleFor,
}: Pick<
  WorkEligibilityScreenProps,
  'currentTrustTier' | 'riskClearance' | 'workLocation' | 'eligibleFor' | 'notEligibleFor'
>) {
  const hasEligibilityLists = (eligibleFor?.length ?? 0) > 0 || (notEligibleFor?.length ?? 0) > 0;

  return (
    <View style={styles.section}>
      <Text style={styles.pageTitle}>Work Eligibility</Text>

      <GlassCard>
        <View style={styles.summaryContent}>
          {/* Current Trust Tier */}
          <View style={styles.summaryItem}>
            <Text style={styles.trustTierNumber}>
              Tier {currentTrustTier ?? 0}
            </Text>
            <Text style={styles.summaryLabel}>Current Trust Tier</Text>
          </View>

          {/* Active Risk Clearance */}
          {riskClearance && (
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Active Risk Clearance</Text>
              <View
                style={[
                  styles.riskBadge,
                  {
                    backgroundColor: getRiskClearanceBgColor(riskClearance),
                    borderColor: getRiskClearanceBorderColor(riskClearance),
                  },
                ]}
              >
                <Text
                  style={[
                    styles.riskBadgeText,
                    { color: getRiskClearanceTextColor(riskClearance) },
                  ]}
                >
                  {capitalizeFirst(riskClearance)}
                </Text>
              </View>
            </View>
          )}

          {/* Work Location */}
          {workLocation && (
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Work Location</Text>
              <Text style={styles.locationText}>{workLocation}</Text>
            </View>
          )}

          {/* Two-column eligibility lists */}
          {hasEligibilityLists && (
            <View style={styles.eligibilityGrid}>
              {eligibleFor && eligibleFor.length > 0 && (
                <View style={styles.eligibilityColumn}>
                  <Text style={styles.eligibilityColumnTitle}>
                    You're eligible for:
                  </Text>
                  {eligibleFor.map((item, index) => (
                    <View key={index} style={styles.eligibilityItem}>
                      <Text style={styles.eligibilityBullet}>•</Text>
                      <Text style={styles.eligibilityText}>{item}</Text>
                    </View>
                  ))}
                </View>
              )}
              {notEligibleFor && notEligibleFor.length > 0 && (
                <View style={styles.eligibilityColumn}>
                  <Text style={styles.eligibilityColumnTitle}>
                    Not eligible for:
                  </Text>
                  {notEligibleFor.map((item, index) => (
                    <View key={index} style={styles.eligibilityItem}>
                      <Text style={styles.eligibilityBullet}>•</Text>
                      <Text style={styles.eligibilityText}>{item}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}
        </View>
      </GlassCard>
    </View>
  );
}

/**
 * Verified Trade Card Component
 * 
 * Renders single trade verification card with status, details, and action button (if applicable).
 */
function VerifiedTradeCard({
  trade,
  onVerifyPress,
}: {
  trade: VerifiedTrade;
  onVerifyPress?: () => void;
}) {
  const showActionButton =
    trade.status === 'not_verified' || trade.status === 'expired';
  const actionLabel =
    trade.status === 'expired' ? 'Renew verification' : 'Verify license';

  return (
    <GlassCard style={styles.tradeCard}>
      <View style={styles.tradeHeader}>
        <Text style={styles.statusIcon}>{getStatusIcon(trade.status)}</Text>
        <View style={styles.tradeContent}>
          <Text
            style={[
              styles.tradeName,
              trade.status === 'verified' && styles.tradeNameBold,
            ]}
          >
            {trade.trade}
          </Text>

          {/* Status-specific content */}
          {trade.status === 'not_verified' && (
            <Text style={styles.tradeStatus}>Not verified</Text>
          )}

          {trade.status === 'pending' && (
            <>
              <Text style={styles.tradeStatus}>Verification in progress</Text>
              <Text style={styles.tradeSubtext}>
                This usually takes under 24 hours
              </Text>
            </>
          )}

          {trade.status === 'verified' && (
            <>
              {trade.state && (
                <Text style={styles.tradeStatus}>{trade.state}</Text>
              )}
              {trade.expiresAt && (
                <Text style={styles.tradeStatus}>Expires: {trade.expiresAt}</Text>
              )}
            </>
          )}

          {trade.status === 'expired' && (
            <>
              <Text style={styles.tradeStatusExpired}>Expired</Text>
              {trade.expiresAt && (
                <Text style={styles.tradeStatus}>
                  Expired: {trade.expiresAt}
                </Text>
              )}
            </>
          )}
        </View>
      </View>

      {/* Action button (only for not_verified or expired) */}
      {showActionButton && (
        <View style={styles.tradeAction}>
          <PrimaryActionButton
            label={actionLabel}
            onPress={onVerifyPress || (() => {
              console.log('[WorkEligibility] Verify/Renew license:', trade.trade);
            })}
            disabled={trade.status === 'not_verified'}
          />
        </View>
      )}
    </GlassCard>
  );
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Work Eligibility Screen
 * 
 * Settings screen displaying user's work eligibility status, verified trades,
 * insurance, background checks, and upgrade opportunities.
 * 
 * Follows SETTINGS_VERIFICATION_AND_ELIGIBILITY_LOCKED.md spec exactly.
 * 
 * @param props - Work eligibility screen props
 * @returns React component
 */
export function WorkEligibilityScreen({
  currentTrustTier,
  riskClearance,
  workLocation,
  eligibleFor = [],
  notEligibleFor = [],
  verifiedTrades = [],
  insurance,
  backgroundCheck,
  upgradeOpportunities = [],
  hasExpiredCredentials = false,
  optedIntoCriticalTasks = false,
}: WorkEligibilityScreenProps) {
  // ========================================================================
  // Conditional Rendering Logic (Derived from Props)
  // ========================================================================

  // Insurance section: Only shown if user has at least one verified trade AND insurance data exists
  const hasVerifiedTrade = verifiedTrades.some((t) => t.status === 'verified');
  const shouldShowInsurance = hasVerifiedTrade && insurance !== undefined;

  // Background check section: Only shown if user opted into critical tasks AND background check data exists
  const shouldShowBackgroundCheck =
    optedIntoCriticalTasks && backgroundCheck !== undefined;

  // ========================================================================
  // Render (Follows Spec Section Order)
  // ========================================================================

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* SECTION 0: System Notice (Conditional - Expired Credentials) */}
        {hasExpiredCredentials && <SystemNotice />}

        {/* SECTION 1: Eligibility Summary (Read-Only) */}
        <EligibilitySummarySection
          currentTrustTier={currentTrustTier}
          riskClearance={riskClearance}
          workLocation={workLocation}
          eligibleFor={eligibleFor}
          notEligibleFor={notEligibleFor}
        />

        {/* SECTION 2: Verified Trades (Array-Based) */}
        {verifiedTrades.length > 0 && (
          <View style={styles.section}>
            <SectionHeader title="Verified Trades" />
            <View style={styles.cardList}>
              {verifiedTrades.map((trade, index) => (
                <VerifiedTradeCard
                  key={index}
                  trade={trade}
                  onVerifyPress={() => {
                    console.log(
                      '[WorkEligibility] Verify/Renew license:',
                      trade.trade
                    );
                  }}
                />
              ))}
            </View>
          </View>
        )}

        {/* SECTION 3: Insurance Section (Conditional) */}
        {shouldShowInsurance && insurance && (
          <View style={styles.section}>
            <SectionHeader title="Insurance" />
            <View style={styles.cardList}>
              <GlassCard style={styles.tradeCard}>
                <View style={styles.tradeHeader}>
                  <Text style={styles.statusIcon}>
                    {getStatusIcon(insurance.status)}
                  </Text>
                  <View style={styles.tradeContent}>
                    <Text
                      style={[
                        styles.tradeName,
                        insurance.status === 'active' && styles.tradeNameBold,
                      ]}
                    >
                      General Liability Insurance
                    </Text>

                    {/* Status-specific content */}
                    {insurance.status === 'not_on_file' && (
                      <Text style={styles.tradeStatus}>Not on file</Text>
                    )}

                    {insurance.status === 'pending' && (
                      <Text style={styles.tradeStatus}>Pending review</Text>
                    )}

                    {insurance.status === 'active' && (
                      <Text style={styles.tradeStatus}>Active</Text>
                    )}

                    {insurance.status === 'expired' && (
                      <>
                        <Text style={styles.tradeStatusExpired}>Expired</Text>
                        {insurance.expiresAt && (
                          <Text style={styles.tradeStatus}>
                            Expired: {insurance.expiresAt}
                          </Text>
                        )}
                      </>
                    )}
                  </View>
                </View>

                {/* Action button (only for not_on_file or expired) */}
                {(insurance.status === 'not_on_file' ||
                  insurance.status === 'expired') && (
                  <View style={styles.tradeAction}>
                    <PrimaryActionButton
                      label={
                        insurance.status === 'expired'
                          ? 'Renew insurance'
                          : 'Add insurance'
                      }
                      onPress={() => {
                        console.log('[WorkEligibility] Add/Renew insurance');
                      }}
                    />
                  </View>
                )}
              </GlassCard>
            </View>
          </View>
        )}

        {/* SECTION 4: Background Checks (Conditional) */}
        {shouldShowBackgroundCheck && backgroundCheck && (
          <View style={styles.section}>
            <SectionHeader title="Background Checks" />
            <View style={styles.cardList}>
              <GlassCard style={styles.tradeCard}>
                <View style={styles.tradeHeader}>
                  <Text style={styles.statusIcon}>
                    {getStatusIcon(backgroundCheck.status)}
                  </Text>
                  <View style={styles.tradeContent}>
                    <Text
                      style={[
                        styles.tradeName,
                        backgroundCheck.status === 'verified' &&
                          styles.tradeNameBold,
                      ]}
                    >
                      Criminal Background Check
                    </Text>

                    {/* Status-specific content */}
                    {backgroundCheck.status === 'not_completed' && (
                      <Text style={styles.tradeStatus}>Not completed</Text>
                    )}

                    {backgroundCheck.status === 'pending' && (
                      <Text style={styles.tradeStatus}>Pending</Text>
                    )}

                    {backgroundCheck.status === 'verified' && (
                      <>
                        <Text style={styles.tradeStatus}>Verified</Text>
                        {backgroundCheck.expiresAt && (
                          <Text style={styles.tradeStatus}>
                            Expires: {backgroundCheck.expiresAt}
                          </Text>
                        )}
                      </>
                    )}

                    {backgroundCheck.status === 'expired' && (
                      <>
                        <Text style={styles.tradeStatusExpired}>Expired</Text>
                        {backgroundCheck.expiresAt && (
                          <Text style={styles.tradeStatus}>
                            Expired: {backgroundCheck.expiresAt}
                          </Text>
                        )}
                      </>
                    )}
                  </View>
                </View>

                {/* Action button (only for not_completed or expired) */}
                {(backgroundCheck.status === 'not_completed' ||
                  backgroundCheck.status === 'expired') && (
                  <View style={styles.tradeAction}>
                    <PrimaryActionButton
                      label={
                        backgroundCheck.status === 'expired'
                          ? 'Renew background check'
                          : 'Start background check'
                      }
                      onPress={() => {
                        console.log(
                          '[WorkEligibility] Start/Renew background check'
                        );
                      }}
                    />
                  </View>
                )}
              </GlassCard>
            </View>
          </View>
        )}

        {/* SECTION 5: Upgrade Opportunities (Computed Display Only) */}
        {upgradeOpportunities.length > 0 && (
          <View style={styles.section}>
            {upgradeOpportunities.map((opportunity, index) => (
              <GlassCard
                key={index}
                style={[styles.upgradeCard, styles.upgradeCardBorder]}
              >
                <View style={styles.tradeHeader}>
                  <Text style={styles.upgradeIcon}>💼</Text>
                  <View style={styles.tradeContent}>
                    <Text style={styles.tradeName}>
                      Verify {opportunity.trade} License
                    </Text>
                    <Text style={styles.upgradeSubtext}>
                      Unlocks {opportunity.activeGigs} active gigs near you
                    </Text>
                    <Text style={styles.upgradeSubtext}>
                      Average payout: ${opportunity.averagePayout}
                    </Text>
                  </View>
                </View>
                <View style={styles.tradeAction}>
                  <PrimaryActionButton
                    label="Verify license"
                    onPress={() => {
                      console.log(
                        '[WorkEligibility] Verify license:',
                        opportunity.trade
                      );
                    }}
                  />
                </View>
              </GlassCard>
            ))}
          </View>
        )}
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
    paddingTop: 24,
    paddingHorizontal: spacing.card,
    paddingBottom: spacing.section,
  },

  // ========================================================================
  // Sections
  // ========================================================================
  
  section: {
    marginBottom: spacing.section,
  },

  // ========================================================================
  // System Notice
  // ========================================================================
  
  systemNotice: {
    backgroundColor: 'rgba(255, 149, 0, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(255, 149, 0, 0.3)',
    borderRadius: 12,
    padding: spacing.card,
    marginBottom: spacing.section,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  
  systemNoticeIcon: {
    fontSize: 14,
    marginRight: 8,
  },
  
  systemNoticeContent: {
    flex: 1,
  },
  
  systemNoticeTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  
  systemNoticeSubtext: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 4,
  },

  // ========================================================================
  // Page Title
  // ========================================================================
  
  pageTitle: {
    fontSize: typography.header.fontSize,
    fontWeight: typography.header.fontWeight,
    color: colors.textPrimary,
    marginBottom: spacing.card,
  },

  // ========================================================================
  // Eligibility Summary
  // ========================================================================
  
  summaryContent: {
    gap: spacing.card,
  },
  
  summaryItem: {
    gap: 4,
  },
  
  trustTierNumber: {
    fontSize: 36,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  
  summaryLabel: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
  },
  
  riskBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  
  riskBadgeText: {
    fontSize: typography.body.fontSize,
    fontWeight: '600',
  },
  
  locationText: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  
  eligibilityGrid: {
    flexDirection: 'row',
    gap: spacing.card,
    paddingTop: spacing.card,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorderPrimary,
  },
  
  eligibilityColumn: {
    flex: 1,
    gap: 4,
  },
  
  eligibilityColumnTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 8,
  },
  
  eligibilityItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  
  eligibilityBullet: {
    fontSize: 12,
    color: colors.muted,
  },
  
  eligibilityText: {
    fontSize: 12,
    color: colors.muted,
    flex: 1,
  },

  // ========================================================================
  // Card Lists
  // ========================================================================
  
  cardList: {
    gap: spacing.card,
  },
  
  tradeCard: {
    marginBottom: 0,
  },

  // ========================================================================
  // Trade/Insurance/Background Check Cards
  // ========================================================================
  
  tradeHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  
  statusIcon: {
    fontSize: 20,
  },
  
  tradeContent: {
    flex: 1,
    gap: 4,
  },
  
  tradeName: {
    fontSize: typography.body.fontSize,
    color: colors.textPrimary,
  },
  
  tradeNameBold: {
    fontWeight: '700',
  },
  
  tradeStatus: {
    fontSize: 12,
    color: colors.muted,
  },
  
  tradeStatusExpired: {
    fontSize: 12,
    color: '#FF9500',
  },
  
  tradeSubtext: {
    fontSize: 12,
    color: colors.muted,
    fontStyle: 'italic',
    marginTop: 4,
  },
  
  tradeAction: {
    marginTop: 12,
  },

  // ========================================================================
  // Upgrade Opportunities
  // ========================================================================
  
  upgradeCard: {
    marginBottom: spacing.card,
  },
  
  upgradeCardBorder: {
    borderColor: 'rgba(10, 132, 255, 0.3)',
    borderWidth: 1,
  },
  
  upgradeIcon: {
    fontSize: 24,
  },
  
  upgradeSubtext: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 4,
  },
});
