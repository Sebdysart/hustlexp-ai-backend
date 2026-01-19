/**
 * Profile Screen (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: SETTINGS_PROFILE
 * Spec Authority: HUSTLEXP-DOCS/UI_SPEC.md §6 + §4 (Badge System)
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. BADGE RULES (UI_SPEC §4, §5):
 *    - XP Colors: Allowed (XP displayed here)
 *    - Badges: Never scale beyond 1.0, no pulse, no mount animations
 *    - Badge glow: Only obsidian tier (tier 4), max 12% opacity
 * 
 * 2. UI-ONLY: NO XP/badge computation.
 *    - All data comes from props
 *    - Display-only screen
 * 
 * ============================================================================
 * COMPONENT DEPENDENCIES
 * ============================================================================
 * 
 * Required Components:
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
import { GlassCard } from '../../ui/GlassCard';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';
import { typography } from '../../ui/typography';

// ============================================================================
// TYPE DEFINITIONS (MAX-TIER: Explicit, Exhaustive, Documented)
// ============================================================================

/**
 * Badge tier.
 * 
 * Material-based progression: 1=Matte, 2=Alloy, 3=Gold, 4=Obsidian
 */
export type BadgeTier = 1 | 2 | 3 | 4;

/**
 * Badge data.
 * 
 * Represents a single badge.
 */
export interface Badge {
  /** Badge name */
  name: string;
  
  /** Badge tier (material) */
  tier: BadgeTier;
  
  /** Whether badge is earned */
  earned: boolean;
}

/**
 * Profile data.
 * 
 * User profile information for display.
 */
export interface ProfileData {
  /** Current level */
  level: number;
  
  /** Current XP amount */
  currentXP: number;
  
  /** XP required for next level */
  nextLevelXP: number;
  
  /** Level title (e.g., "Rookie") */
  levelTitle: string;
  
  /** List of badges */
  badges: Badge[];
  
  /** Tasks completed */
  tasksCompleted: number;
  
  /** Current streak (days) */
  currentStreak: number;
  
  /** Trust tier */
  trustTier: string;
}

/**
 * Profile Screen Props
 * 
 * Props for profile screen display.
 */
export interface ProfileScreenProps {
  /** Profile data to display */
  profile?: ProfileData;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Default profile data.
 */
const DEFAULT_PROFILE: ProfileData = {
  level: 1,
  currentXP: 0,
  nextLevelXP: 100,
  levelTitle: 'Rookie',
  badges: [
    { name: 'First Task', tier: 1, earned: false },
    { name: 'Week Streak', tier: 1, earned: false },
    { name: 'Pro Hustler', tier: 2, earned: false },
    { name: 'Elite', tier: 3, earned: false },
  ],
  tasksCompleted: 0,
  currentStreak: 0,
  trustTier: '1 (Verified)',
};

/**
 * Badge tier colors (simplified - actual spec uses material gradients).
 * 
 * Per UI_SPEC §5: Material-based progression.
 */
const BADGE_COLORS: Record<BadgeTier, string> = {
  1: colors.muted, // Matte (gray)
  2: '#C0C0C0', // Alloy (silver)
  3: '#FFD700', // Gold
  4: '#1A1A1A', // Obsidian (dark)
};

/**
 * XP color (per UI_SPEC §3: XP colors allowed on profile).
 */
const XP_COLOR = '#059669'; // Emerald 600

/**
 * Progress bar height.
 */
const PROGRESS_BAR_HEIGHT = 8;

/**
 * Badge icon size.
 * 
 * Per UI_SPEC §4: Never scale beyond 1.0
 */
const BADGE_ICON_SIZE = 48;

/**
 * Maximum glow opacity for obsidian tier (per UI_SPEC §4).
 */
const OBSIDIAN_GLOW_OPACITY = 0.12;

// ============================================================================
// SUB-COMPONENTS (MAX-TIER: Modular, Reusable, Documented)
// ============================================================================

/**
 * Badge Display Component
 * 
 * Displays a single badge following BADGE RENDER LOCK rules:
 * - Never scale beyond 1.0
 * - No pulse
 * - No mount animations
 * - Glow only for obsidian tier, max 12% opacity
 */
function BadgeDisplay({ badge }: { badge: Badge }) {
  const badgeColor = BADGE_COLORS[badge.tier];
  const isObsidian = badge.tier === 4 && badge.earned;

  return (
    <View style={styles.badge}>
      <View
        style={[
          styles.badgeIcon,
          {
            backgroundColor: badgeColor,
            opacity: badge.earned ? 1 : 0.3,
          },
          isObsidian && styles.obsidianGlow,
        ]}
      >
        {/* Badge icon placeholder - no animations on mount */}
      </View>
      <Text
        style={[
          styles.badgeText,
          !badge.earned && styles.badgeTextLocked,
        ]}
      >
        {badge.name}
      </Text>
    </View>
  );
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Profile Screen
 * 
 * Displays user profile with XP progress, badges, and statistics.
 * 
 * BADGE RULES (UI_SPEC §4, §5):
 * - XP Colors: Allowed (XP displayed)
 * - Badges: Never scale beyond 1.0, no pulse, no mount animations
 * - Badge glow: Only obsidian tier, max 12% opacity
 * 
 * @param props - Profile screen props
 * @returns React component
 */
export function ProfileScreen({ profile = DEFAULT_PROFILE }: ProfileScreenProps) {
  // ========================================================================
  // Derived Values
  // ========================================================================

  const progressPercent =
    profile.nextLevelXP > 0
      ? (profile.currentXP / profile.nextLevelXP) * 100
      : 0;

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
        <Text style={styles.headerTitle}>Profile</Text>

        {/* XP Progress Section - XP colors allowed */}
        <GlassCard style={styles.xpSection}>
          <Text style={styles.sectionLabel}>LEVEL PROGRESS</Text>
          <View style={styles.levelRow}>
            <Text style={[styles.levelText, { color: XP_COLOR }]}>
              Level {profile.level}
            </Text>
            <Text style={styles.levelTitle}>{profile.levelTitle}</Text>
          </View>

          {/* Progress Bar - XP secondary color allowed */}
          <View style={styles.progressContainer}>
            <View style={styles.progressBg}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${progressPercent}%`, backgroundColor: XP_COLOR },
                ]}
              />
            </View>
            <Text style={styles.progressText}>
              {profile.currentXP} / {profile.nextLevelXP} XP
            </Text>
          </View>
        </GlassCard>

        {/* Badges Section */}
        <Text style={styles.sectionTitle}>BADGES</Text>
        <GlassCard style={styles.badgesCard}>
          <View style={styles.badgesGrid}>
            {profile.badges.map((badge, index) => (
              <BadgeDisplay key={index} badge={badge} />
            ))}
          </View>
        </GlassCard>

        {/* Statistics Section */}
        <Text style={styles.sectionTitle}>STATISTICS</Text>
        <GlassCard style={styles.statsCard}>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Tasks Completed</Text>
            <Text style={styles.statValue}>{profile.tasksCompleted}</Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Current Streak</Text>
            <Text style={styles.statValue}>{profile.currentStreak} days</Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Trust Tier</Text>
            <Text style={styles.statValue}>{profile.trustTier}</Text>
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
    marginBottom: spacing.section,
  },

  // ========================================================================
  // XP Section
  // ========================================================================

  xpSection: {
    marginBottom: spacing.section,
    padding: spacing.section,
  },

  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.card,
  },

  levelRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.card / 2,
    marginBottom: spacing.section,
  },

  levelText: {
    fontSize: 24,
    fontWeight: '700',
  },

  levelTitle: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
  },

  progressContainer: {
    marginTop: spacing.card,
  },

  progressBg: {
    height: PROGRESS_BAR_HEIGHT,
    backgroundColor: colors.glassBorderSecondary,
    borderRadius: PROGRESS_BAR_HEIGHT / 2,
    overflow: 'hidden',
    marginBottom: spacing.card / 2,
  },

  progressFill: {
    height: '100%',
    borderRadius: PROGRESS_BAR_HEIGHT / 2,
  },

  progressText: {
    fontSize: 12,
    color: colors.muted,
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
  // Badges
  // ========================================================================

  badgesCard: {
    padding: spacing.section,
    marginBottom: spacing.section,
  },

  badgesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.section,
  },

  badge: {
    alignItems: 'center',
    width: 70,
  },

  badgeIcon: {
    width: BADGE_ICON_SIZE,
    height: BADGE_ICON_SIZE,
    borderRadius: BADGE_ICON_SIZE / 2,
    marginBottom: spacing.card / 2,
    // Scale is 1.0 - BADGE RENDER LOCK enforced
  },

  obsidianGlow: {
    // Max 12% opacity glow per UI_SPEC §4
    shadowColor: XP_COLOR,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: OBSIDIAN_GLOW_OPACITY,
    shadowRadius: 8,
  },

  badgeText: {
    fontSize: 12,
    color: colors.textPrimary,
    textAlign: 'center',
  },

  badgeTextLocked: {
    color: colors.muted,
  },

  // ========================================================================
  // Statistics
  // ========================================================================

  statsCard: {
    padding: spacing.section,
  },

  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.card / 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorderPrimary,
  },

  statLabel: {
    fontSize: typography.body.fontSize,
    color: colors.textPrimary,
  },

  statValue: {
    fontSize: typography.body.fontSize,
    fontWeight: '600',
    color: colors.textPrimary,
  },
});
