/**
 * Wallet Screen (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: SETTINGS_WALLET
 * Spec Authority: HUSTLEXP-DOCS/UI_SPEC.md §2 (Color Authority)
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. MONEY COLORS (UI_SPEC §2):
 *    - Money colors (MONEY.held, MONEY.released, MONEY.disputed)
 *    - ONLY for escrow states
 *    - Not for general dollar amounts
 * 
 * 2. UI-ONLY: NO financial logic.
 *    - All data comes from props
 *    - Display-only screen
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

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
} from 'react-native';

// Design System Imports
import { PrimaryActionButton } from '../../ui/PrimaryActionButton';
import { GlassCard } from '../../ui/GlassCard';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';
import { typography } from '../../ui/typography';

// ============================================================================
// TYPE DEFINITIONS (MAX-TIER: Explicit, Exhaustive, Documented)
// ============================================================================

/**
 * Wallet data.
 * 
 * Wallet information for display.
 */
export interface WalletData {
  /** Available balance (can withdraw) */
  availableBalance: number;
  
  /** Amount in escrow (held until task completion) */
  inEscrow: number;
  
  /** Whether payout settings are configured */
  hasPaymentMethod: boolean;
}

/**
 * Wallet Screen Props
 * 
 * Props for wallet screen display.
 */
export interface WalletScreenProps {
  /** Wallet data to display */
  wallet?: WalletData;
  
  /** Callback when withdraw is pressed */
  onWithdraw?: () => void;
  
  /** Callback when connect bank account is pressed */
  onConnectBank?: () => void;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Default wallet data.
 */
const DEFAULT_WALLET: WalletData = {
  availableBalance: 0,
  inEscrow: 0,
  hasPaymentMethod: false,
};

/**
 * Money colors (per UI_SPEC §2: ONLY for escrow states).
 * 
 * MONEY.held = Held in escrow (FUNDED state)
 * MONEY.released = Released from escrow (RELEASED state)
 * MONEY.disputed = Disputed funds
 */
const MONEY_COLORS = {
  held: '#059669', // Emerald 600 (held)
  released: '#10B981', // Emerald 500 (released)
  disputed: '#EF4444', // Red 500 (disputed)
} as const;

/**
 * Formatters.
 */
function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Wallet Screen
 * 
 * Displays earnings, payouts, and payment settings.
 * 
 * MONEY COLORS (UI_SPEC §2):
 * - Money colors ONLY for escrow states
 * - Not for general dollar amounts
 * 
 * @param props - Wallet screen props
 * @returns React component
 */
export function WalletScreen({
  wallet = DEFAULT_WALLET,
  onWithdraw,
  onConnectBank,
}: WalletScreenProps) {
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
        <Text style={styles.headerTitle}>Wallet</Text>
        <Text style={styles.subtitle}>Your earnings and payouts</Text>

        {/* Balance Card */}
        <GlassCard style={styles.balanceCard}>
          <Text style={styles.balanceLabel}>AVAILABLE BALANCE</Text>
          <Text style={styles.balanceAmount}>
            {formatCurrency(wallet.availableBalance)}
          </Text>
          <View style={styles.withdrawButtonContainer}>
            <PrimaryActionButton
              label="Withdraw"
              onPress={onWithdraw}
              disabled={wallet.availableBalance === 0}
            />
          </View>
        </GlassCard>

        {/* Pending Earnings */}
        <Text style={styles.sectionTitle}>PENDING EARNINGS</Text>
        <GlassCard style={styles.pendingCard}>
          <View style={styles.pendingRow}>
            <Text style={styles.pendingLabel}>In Escrow</Text>
            {/* MONEY.held color for FUNDED escrow state */}
            <Text style={[styles.pendingAmount, { color: MONEY_COLORS.held }]}>
              {formatCurrency(wallet.inEscrow)}
            </Text>
          </View>
          <Text style={styles.pendingHint}>
            Funds held until task completion
          </Text>
        </GlassCard>

        {/* Transaction History */}
        <Text style={styles.sectionTitle}>RECENT TRANSACTIONS</Text>
        <GlassCard style={styles.historyCard}>
          <Text style={styles.emptyText}>No transactions yet</Text>
        </GlassCard>

        {/* Payout Settings */}
        <Text style={styles.sectionTitle}>PAYOUT SETTINGS</Text>
        <GlassCard style={styles.settingsCard}>
          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Payment Method</Text>
            <Text style={styles.settingValue}>
              {wallet.hasPaymentMethod ? 'Connected' : 'Not set'}
            </Text>
          </View>
          <View style={styles.connectButtonContainer}>
            <PrimaryActionButton
              label="Connect Bank Account"
              onPress={onConnectBank}
            />
          </View>
        </GlassCard>
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
    padding: spacing.card,
  },

  // ========================================================================
  // Header
  // ========================================================================

  headerTitle: {
    fontSize: typography.header.fontSize,
    fontWeight: typography.header.fontWeight,
    color: colors.textPrimary,
    marginBottom: spacing.card / 2,
  },

  subtitle: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    marginBottom: spacing.section,
  },

  // ========================================================================
  // Balance Card
  // ========================================================================

  balanceCard: {
    alignItems: 'center',
    paddingVertical: spacing.section * 1.5,
    paddingHorizontal: spacing.section,
    marginBottom: spacing.section,
  },

  balanceLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.card,
  },

  balanceAmount: {
    fontSize: 48,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.section,
  },

  withdrawButtonContainer: {
    width: '100%',
  },

  // ========================================================================
  // Sections
  // ========================================================================

  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: spacing.section * 2,
    marginBottom: spacing.card,
  },

  // ========================================================================
  // Pending Earnings
  // ========================================================================

  pendingCard: {
    padding: spacing.section,
    marginBottom: spacing.section,
  },

  pendingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  pendingLabel: {
    fontSize: typography.body.fontSize,
    color: colors.textPrimary,
  },

  pendingAmount: {
    fontSize: typography.body.fontSize,
    fontWeight: '600',
    // Color set inline (MONEY.held)
  },

  pendingHint: {
    fontSize: 12,
    color: colors.muted,
    marginTop: spacing.card / 2,
  },

  // ========================================================================
  // Transaction History
  // ========================================================================

  historyCard: {
    padding: spacing.section * 2,
    marginBottom: spacing.section,
    alignItems: 'center',
    justifyContent: 'center',
  },

  emptyText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
  },

  // ========================================================================
  // Payout Settings
  // ========================================================================

  settingsCard: {
    padding: spacing.section,
  },

  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.card,
  },

  settingLabel: {
    fontSize: typography.body.fontSize,
    color: colors.textPrimary,
  },

  settingValue: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
  },

  connectButtonContainer: {
    marginTop: spacing.card / 2,
  },
});
