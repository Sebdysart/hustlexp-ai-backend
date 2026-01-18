/**
 * Settings → Work Eligibility Screen
 * 
 * Screen: SETTINGS_WORK_ELIGIBILITY
 * Spec: HUSTLEXP-DOCS/architecture/SETTINGS_VERIFICATION_AND_ELIGIBILITY_LOCKED.md
 * Figma: HUSTLEXP-DOCS/ui-specs/designs/WorkEligibility.figma.tsx
 * Version: v1
 * Status: LOCKED
 * 
 * Components (required):
 * - GlassCard (from hustlexp-app/ui/GlassCard.tsx)
 * - PrimaryActionButton (from hustlexp-app/ui/PrimaryActionButton.tsx)
 * - SectionHeader (from hustlexp-app/ui/SectionHeader.tsx)
 * 
 * Tokens (required):
 * - colors (from hustlexp-app/ui/colors.ts)
 * - spacing (from hustlexp-app/ui/spacing.ts)
 * - typography (from hustlexp-app/ui/typography.ts)
 * 
 * CRITICAL: This is UI-only. NO eligibility computation. NO backend logic.
 * All data comes from props. Placeholder buttons are disabled or use console.log handlers.
 */

import React from 'react';
import { View, Text, ScrollView, StyleSheet, SafeAreaView } from 'react-native';
import { GlassCard } from '../../ui/GlassCard';
import { PrimaryActionButton } from '../../ui/PrimaryActionButton';
import { SectionHeader } from '../../ui/SectionHeader';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';
import { typography } from '../../ui/typography';

// ============================================================================
// TYPES
// ============================================================================

interface WorkEligibilityProps {
  // Eligibility Summary
  currentTrustTier?: number;
  riskClearance?: 'low' | 'medium' | 'high' | 'critical';
  workLocation?: string; // State abbreviation, e.g., "WA"
  eligibleFor?: string[];
  notEligibleFor?: string[];

  // Verified Trades
  verifiedTrades?: Array<{
    trade: string;
    status: 'not_verified' | 'pending' | 'verified' | 'expired';
    state?: string;
    expiresAt?: string;
  }>;

  // Insurance (conditional)
  insurance?: {
    status: 'not_on_file' | 'pending' | 'active' | 'expired';
    expiresAt?: string;
  };

  // Background Check (conditional)
  backgroundCheck?: {
    status: 'not_completed' | 'pending' | 'verified' | 'expired';
    expiresAt?: string;
  };

  // Upgrade Opportunities (computed display only)
  upgradeOpportunities?: Array<{
    trade: string;
    activeGigs: number;
    averagePayout: number;
  }>;

  // System Notice
  hasExpiredCredentials?: boolean;
  
  // Conditional rendering flags
  optedIntoCriticalTasks?: boolean;
}

// ============================================================================
// COMPONENT
// ============================================================================

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
}: WorkEligibilityProps) {
  // Helper function to get status icon
  const getStatusIcon = (status: string): string => {
    switch (status) {
      case 'not_verified':
      case 'not_on_file':
      case 'not_completed':
        return '❌';
      case 'pending':
        return '⏳';
      case 'verified':
      case 'active':
        return '✅';
      case 'expired':
        return '⚠️';
      default:
        return '';
    }
  };

  // Helper function to format risk clearance badge
  const getRiskClearanceColor = (level: string) => {
    switch (level) {
      case 'low':
        return 'rgba(52, 199, 89, 0.2)';
      case 'medium':
        return 'rgba(52, 199, 89, 0.2)';
      case 'high':
        return 'rgba(255, 149, 0, 0.2)';
      case 'critical':
        return 'rgba(255, 59, 48, 0.2)';
      default:
        return 'rgba(52, 199, 89, 0.2)';
    }
  };

  const getRiskClearanceBorderColor = (level: string) => {
    switch (level) {
      case 'low':
        return 'rgba(52, 199, 89, 0.4)';
      case 'medium':
        return 'rgba(52, 199, 89, 0.4)';
      case 'high':
        return 'rgba(255, 149, 0, 0.4)';
      case 'critical':
        return 'rgba(255, 59, 48, 0.4)';
      default:
        return 'rgba(52, 199, 89, 0.4)';
    }
  };

  const getRiskClearanceTextColor = (level: string) => {
    switch (level) {
      case 'low':
      case 'medium':
        return '#34C759';
      case 'high':
        return '#FF9500';
      case 'critical':
        return '#FF3B30';
      default:
        return '#34C759';
    }
  };

  // Check if insurance section should be shown
  const hasVerifiedTrade = verifiedTrades.some((t) => t.status === 'verified');
  const shouldShowInsurance = hasVerifiedTrade && insurance;

  // Check if background check section should be shown
  const shouldShowBackgroundCheck = optedIntoCriticalTasks && backgroundCheck;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* System Notice - Expired Credential Alert */}
        {hasExpiredCredentials && (
          <View style={styles.systemNotice}>
            <Text style={styles.systemNoticeIcon}>⚠️</Text>
            <View style={styles.systemNoticeContent}>
              <Text style={styles.systemNoticeTitle}>Credential expired</Text>
              <Text style={styles.systemNoticeSubtext}>
                Expired credentials remove access immediately
              </Text>
            </View>
          </View>
        )}

        {/* SECTION 1: Eligibility Summary */}
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
                        backgroundColor: getRiskClearanceColor(riskClearance),
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
                      {riskClearance.charAt(0).toUpperCase() +
                        riskClearance.slice(1)}
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

              {/* Two-column eligibility list */}
              {(eligibleFor.length > 0 || notEligibleFor.length > 0) && (
                <View style={styles.eligibilityGrid}>
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
                </View>
              )}
            </View>
          </GlassCard>
        </View>

        {/* SECTION 2: Verified Trades */}
        {verifiedTrades.length > 0 && (
          <View style={styles.section}>
            <SectionHeader title="Verified Trades" />

            <View style={styles.cardList}>
              {verifiedTrades.map((trade, index) => (
                <GlassCard key={index} style={styles.tradeCard}>
                  <View style={styles.tradeHeader}>
                    <Text style={styles.statusIcon}>
                      {getStatusIcon(trade.status)}
                    </Text>
                    <View style={styles.tradeContent}>
                      <Text
                        style={[
                          styles.tradeName,
                          trade.status === 'verified' && styles.tradeNameBold,
                        ]}
                      >
                        {trade.trade}
                      </Text>
                      {trade.status === 'not_verified' && (
                        <Text style={styles.tradeStatus}>Not verified</Text>
                      )}
                      {trade.status === 'pending' && (
                        <>
                          <Text style={styles.tradeStatus}>
                            Verification in progress
                          </Text>
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
                            <Text style={styles.tradeStatus}>
                              Expires: {trade.expiresAt}
                            </Text>
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
                  {(trade.status === 'not_verified' ||
                    trade.status === 'expired') && (
                    <View style={styles.tradeAction}>
                      <PrimaryActionButton
                        label={
                          trade.status === 'expired'
                            ? 'Renew verification'
                            : 'Verify license'
                        }
                        onPress={() => {
                          console.log('Verify/Renew license:', trade.trade);
                        }}
                        disabled={trade.status === 'not_verified'}
                      />
                    </View>
                  )}
                </GlassCard>
              ))}
            </View>
          </View>
        )}

        {/* SECTION 3: Insurance Section (Conditional) */}
        {shouldShowInsurance && (
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
                        console.log('Add/Renew insurance');
                      }}
                    />
                  </View>
                )}
              </GlassCard>
            </View>
          </View>
        )}

        {/* SECTION 4: Background Checks (Conditional) */}
        {shouldShowBackgroundCheck && (
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
                        console.log('Start/Renew background check');
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
                      console.log('Verify license:', opportunity.trade);
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
// STYLES
// ============================================================================

const styles = StyleSheet.create({
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
  section: {
    marginBottom: spacing.section,
  },
  pageTitle: {
    fontSize: typography.header.fontSize,
    fontWeight: typography.header.fontWeight,
    color: colors.textPrimary,
    marginBottom: spacing.card,
  },
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
  cardList: {
    gap: spacing.card,
  },
  tradeCard: {
    marginBottom: 0,
  },
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
