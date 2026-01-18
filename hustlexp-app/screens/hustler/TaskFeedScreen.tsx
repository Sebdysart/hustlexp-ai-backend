/**
 * Task Feed Screen (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: TASK_FEED
 * Spec Authority: HUSTLEXP-DOCS/architecture/FEED_QUERY_AND_ELIGIBILITY_RESOLVER_LOCKED.md
 * Figma Reference: HUSTLEXP-DOCS/ui-specs/FIGMA_DESIGN_PROMPTS.md (PROMPT 3)
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS (NON-NEGOTIABLE)
 * ============================================================================
 * 
 * 1. ELIGIBILITY GUARANTEE: If a task appears in feed, user IS eligible.
 *    Backend guarantees this. NO disabled buttons, NO eligibility checks, NO warnings.
 * 
 * 2. FORBIDDEN ELEMENTS (Spec §7):
 *    - ❌ Disabled task cards (spec: "No disabled card")
 *    - ❌ "Apply anyway" flows (spec forbids)
 *    - ❌ Upsell prompts inside feed (spec forbids)
 *    - ❌ Eligibility warnings ("You're not eligible for this task")
 *    - ❌ Trust logic in UI (all eligibility is backend-enforced)
 *    - ❌ Visual indication of eligibility (no checkmarks, no badges)
 * 
 * 3. DETERMINISTIC LANGUAGE:
 *    - Use EXACT wording from FEED_QUERY_AND_ELIGIBILITY_RESOLVER_LOCKED.md
 *    - Task titles: Factual, descriptive (not emotional)
 *    - No emotional language, no urgency manipulation
 * 
 * 4. UI-ONLY: NO eligibility computation. NO backend logic.
 *    - All tasks received via props are assumed eligible
 *    - Client never decides eligibility
 *    - Client never shows disabled buttons or upsells
 * 
 * ============================================================================
 * COMPONENT DEPENDENCIES
 * ============================================================================
 * 
 * Required Components:
 * - GlassCard (hustlexp-app/ui/GlassCard.tsx)
 * - PrimaryActionButton (hustlexp-app/ui/PrimaryActionButton.tsx)
 * 
 * Required Tokens:
 * - colors (hustlexp-app/ui/colors.ts)
 * - spacing (hustlexp-app/ui/spacing.ts)
 * - typography (hustlexp-app/ui/typography.ts)
 * 
 * ============================================================================
 * FEED STRUCTURE (FIXED ORDER)
 * ============================================================================
 * 
 * 1. Header (Title + Feed Mode Selector)
 * 2. Feed Content (Scrollable list of task cards)
 * 3. Empty State (if no tasks)
 * 4. Loading State (if loading)
 * 
 * ============================================================================
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Design System Imports
import { GlassCard } from '../../ui/GlassCard';
import { PrimaryActionButton } from '../../ui/PrimaryActionButton';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';
import { typography } from '../../ui/typography';

// ============================================================================
// TYPE DEFINITIONS (MAX-TIER: Explicit, Exhaustive, Documented)
// ============================================================================

/**
 * Feed mode selector.
 * 
 * - normal: Standard feed (default)
 * - urgent: Urgent tasks only
 * - nearby: Tasks sorted by proximity (requires location)
 */
export type FeedMode = 'normal' | 'urgent' | 'nearby';

/**
 * Task category.
 * 
 * Used for display purposes only (badge/category label).
 */
type TaskCategory =
  | 'delivery'
  | 'moving'
  | 'cleaning'
  | 'pet_care'
  | 'errands'
  | 'handyman'
  | 'tech_help'
  | 'yard_work'
  | 'event_help'
  | 'other';

/**
 * Task entry in feed.
 * 
 * Represents a single task that appears in the feed.
 * ALL tasks in feed are eligible (backend guarantee).
 */
export interface FeedTask {
  /** Unique task identifier */
  id: string;
  
  /** Task title (factual, descriptive) */
  title: string;
  
  /** Task category (for badge display) */
  category: TaskCategory;
  
  /** Location string (e.g., "Seattle, WA") */
  location: string;
  
  /** Payout amount (numeric, in dollars) */
  payout: number;
  
  /** Time posted (e.g., "2 hours ago") */
  timePosted: string;
  
  /** Optional: Scheduled time if task is scheduled */
  scheduledTime?: string;
}

/**
 * Pagination cursor (opaque string).
 * 
 * Used for cursor-based pagination.
 */
export interface PaginationCursor {
  /** Opaque cursor string */
  cursor: string | null;
  
  /** Whether more tasks are available */
  hasMore: boolean;
}

/**
 * Task Feed Screen Props
 * 
 * All props are optional. Component handles empty states gracefully.
 */
export interface TaskFeedScreenProps {
  // ========================================================================
  // Feed Data
  // ========================================================================
  
  /** Array of tasks to display. Empty array = empty state. */
  tasks?: FeedTask[];
  
  /** Whether feed is currently loading */
  isLoading?: boolean;
  
  /** Pagination information */
  pagination?: PaginationCursor;
  
  // ========================================================================
  // Feed Mode
  // ========================================================================
  
  /** Current feed mode (default: 'normal') */
  initialFeedMode?: FeedMode;
  
  /** Callback when feed mode changes */
  onFeedModeChange?: (mode: FeedMode) => void;
  
  // ========================================================================
  // Actions
  // ========================================================================
  
  /** Callback when task accept button is pressed */
  onAcceptTask?: (taskId: string) => void;
  
  /** Callback when refresh is triggered */
  onRefresh?: () => void;
  
  /** Callback when load more is triggered (pagination) */
  onLoadMore?: () => void;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Feed mode labels.
 * 
 * Display labels for feed mode tabs.
 */
const FEED_MODE_LABELS: Record<FeedMode, string> = {
  normal: 'Normal',
  urgent: 'Urgent',
  nearby: 'Nearby',
} as const;

/**
 * Category display labels.
 * 
 * Maps category enum to display string.
 */
const CATEGORY_LABELS: Record<TaskCategory, string> = {
  delivery: 'DELIVERY',
  moving: 'MOVING',
  cleaning: 'CLEANING',
  pet_care: 'PET CARE',
  errands: 'ERRANDS',
  handyman: 'HANDYMAN',
  tech_help: 'TECH HELP',
  yard_work: 'YARD WORK',
  event_help: 'EVENT HELP',
  other: 'OTHER',
} as const;

/**
 * All available feed modes.
 */
const FEED_MODES: FeedMode[] = ['normal', 'urgent', 'nearby'];

// ============================================================================
// HELPER FUNCTIONS (MAX-TIER: Pure, Documented, Type-Safe)
// ============================================================================

/**
 * Formats payout amount to display string.
 * 
 * @param amount - Payout amount in dollars
 * @returns Formatted string (e.g., "$180")
 */
function formatPayout(amount: number): string {
  return `$${Math.round(amount)}`;
}

/**
 * Gets category display label.
 * 
 * @param category - Task category
 * @returns Uppercase display label
 */
function getCategoryLabel(category: TaskCategory): string {
  return CATEGORY_LABELS[category] || 'OTHER';
}

// ============================================================================
// SUB-COMPONENTS (MAX-TIER: Modular, Reusable, Documented)
// ============================================================================

/**
 * Feed Header Component
 * 
 * Displays page title and feed mode selector tabs.
 */
function FeedHeader({
  feedMode,
  onFeedModeChange,
}: {
  feedMode: FeedMode;
  onFeedModeChange: (mode: FeedMode) => void;
}) {
  return (
    <View style={styles.header}>
      {/* Page Title */}
      <Text style={styles.pageTitle}>Available Tasks</Text>

      {/* Feed Mode Selector Tabs */}
      <View style={styles.tabContainer}>
        {FEED_MODES.map((mode) => {
          const isActive = mode === feedMode;
          return (
            <TouchableOpacity
              key={mode}
              style={[styles.tab, isActive && styles.tabActive]}
              onPress={() => onFeedModeChange(mode)}
              activeOpacity={0.8}
            >
              <Text
                style={[styles.tabText, isActive && styles.tabTextActive]}
              >
                {FEED_MODE_LABELS[mode]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Task Card Component
 * 
 * Displays single task card with title, category, location, payout, time, accept button.
 * 
 * CRITICAL: This card is ONLY rendered for eligible tasks.
 * NO disabled state, NO eligibility checks, NO warnings.
 */
function TaskCard({
  task,
  onAcceptPress,
}: {
  task: FeedTask;
  onAcceptPress?: () => void;
}) {
  return (
    <GlassCard style={styles.taskCard}>
      {/* Title */}
      <Text style={styles.taskTitle}>{task.title}</Text>

      {/* Category Badge */}
      <View style={styles.categoryBadge}>
        <Text style={styles.categoryBadgeText}>
          {getCategoryLabel(task.category)}
        </Text>
      </View>

      {/* Location and Payout Row */}
      <View style={styles.taskRow}>
        <View style={styles.locationContainer}>
          <Text style={styles.locationIcon}>📍</Text>
          <Text style={styles.locationText}>{task.location}</Text>
        </View>
        <Text style={styles.payoutText}>{formatPayout(task.payout)}</Text>
      </View>

      {/* Time Posted */}
      <Text style={styles.timeText}>Posted {task.timePosted}</Text>

      {/* Accept Button (ALWAYS ENABLED - all tasks are eligible) */}
      <View style={styles.acceptButtonContainer}>
        <PrimaryActionButton
          label="Accept"
          onPress={onAcceptPress || (() => {
            console.log('[TaskFeed] Accept task:', task.id);
          })}
          disabled={false}
        />
      </View>
    </GlassCard>
  );
}

/**
 * Empty State Component
 * 
 * Displays when no tasks are available.
 * Uses deterministic language from spec.
 */
function EmptyState({ onRefresh }: { onRefresh?: () => void }) {
  return (
    <View style={styles.emptyStateContainer}>
      <View style={styles.emptyStateIcon}>
        <Text style={styles.emptyStateIconText}>📋</Text>
      </View>
      <Text style={styles.emptyStateTitle}>No tasks available</Text>
      <Text style={styles.emptyStateSubtext}>
        New tasks typically appear within 24 hours
      </Text>
      {onRefresh && (
        <View style={styles.emptyStateButton}>
          <PrimaryActionButton label="Refresh" onPress={onRefresh} />
        </View>
      )}
    </View>
  );
}

/**
 * Loading State Component
 * 
 * Displays while feed is loading.
 */
function LoadingState() {
  return (
    <View style={styles.loadingContainer}>
      <ActivityIndicator size="large" color={colors.muted} />
      <Text style={styles.loadingText}>Loading tasks...</Text>
    </View>
  );
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Task Feed Screen
 * 
 * Primary feed screen for hustlers to browse and accept available tasks.
 * 
 * CRITICAL PRINCIPLE: If a task appears in feed, the user IS eligible.
 * There are no exceptions, warnings, disabled buttons, or soft blocks.
 * Backend guarantees eligibility. UI never decides eligibility.
 * 
 * Follows FEED_QUERY_AND_ELIGIBILITY_RESOLVER_LOCKED.md spec exactly.
 * 
 * @param props - Task feed screen props
 * @returns React component
 */
export function TaskFeedScreen({
  tasks = [],
  isLoading = false,
  pagination,
  initialFeedMode = 'normal',
  onFeedModeChange,
  onAcceptTask,
  onRefresh,
  onLoadMore,
}: TaskFeedScreenProps) {
  // ========================================================================
  // State
  // ========================================================================
  
  const [feedMode, setFeedMode] = useState<FeedMode>(initialFeedMode);

  // ========================================================================
  // Handlers
  // ========================================================================
  
  const handleFeedModeChange = (mode: FeedMode) => {
    setFeedMode(mode);
    onFeedModeChange?.(mode);
  };

  const handleAcceptTask = (taskId: string) => {
    onAcceptTask?.(taskId);
  };

  // ========================================================================
  // Render Logic (Determines which state to show)
  // ========================================================================
  
  const showLoading = isLoading && tasks.length === 0;
  const showEmpty = !isLoading && tasks.length === 0;
  const showTasks = !isLoading && tasks.length > 0;

  // ========================================================================
  // Render (Follows Spec Structure Order)
  // ========================================================================

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header (Always Visible) */}
      <FeedHeader
        feedMode={feedMode}
        onFeedModeChange={handleFeedModeChange}
      />

      {/* Content Area */}
      {showLoading && <LoadingState />}

      {showEmpty && <EmptyState onRefresh={onRefresh} />}

      {showTasks && (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={isLoading}
                onRefresh={onRefresh}
                tintColor={colors.muted}
              />
            ) : undefined
          }
          onScrollEndDrag={(event) => {
            // Load more when scrolling near bottom (pagination)
            const { layoutMeasurement, contentOffset, contentSize } =
              event.nativeEvent;
            const paddingToBottom = 100;
            const isNearBottom =
              layoutMeasurement.height + contentOffset.y >=
              contentSize.height - paddingToBottom;

            if (isNearBottom && pagination?.hasMore && onLoadMore) {
              onLoadMore();
            }
          }}
          scrollEventThrottle={400}
        >
          {/* Task Cards List */}
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onAcceptPress={() => handleAcceptTask(task.id)}
            />
          ))}

          {/* Loading More Indicator (if pagination) */}
          {isLoading && tasks.length > 0 && (
            <View style={styles.loadMoreContainer}>
              <ActivityIndicator size="small" color={colors.muted} />
            </View>
          )}
        </ScrollView>
      )}
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
    paddingBottom: spacing.section,
  },

  // ========================================================================
  // Header
  // ========================================================================

  header: {
    paddingTop: 24,
    paddingHorizontal: spacing.card,
    paddingBottom: spacing.card,
  },

  pageTitle: {
    fontSize: typography.header.fontSize,
    fontWeight: typography.header.fontWeight,
    color: colors.textPrimary,
    marginBottom: spacing.card,
  },

  // ========================================================================
  // Feed Mode Selector Tabs
  // ========================================================================

  tabContainer: {
    flexDirection: 'row',
    gap: 8,
  },

  tab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: 'transparent',
  },

  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: colors.primaryAction,
  },

  tabText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
  },

  tabTextActive: {
    color: colors.textPrimary,
    fontWeight: '600',
  },

  // ========================================================================
  // Task Card
  // ========================================================================

  taskCard: {
    marginBottom: spacing.card,
  },

  taskTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 8,
  },

  categoryBadge: {
    alignSelf: 'flex-start',
    marginBottom: 12,
  },

  categoryBadgeText: {
    fontSize: 12,
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  taskRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },

  locationContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },

  locationIcon: {
    fontSize: 12,
  },

  locationText: {
    fontSize: 12,
    color: colors.muted,
  },

  payoutText: {
    fontSize: typography.body.fontSize,
    fontWeight: '700',
    color: colors.textPrimary,
  },

  timeText: {
    fontSize: 12,
    color: colors.muted,
    marginBottom: 16,
  },

  acceptButtonContainer: {
    marginTop: 4,
  },

  // ========================================================================
  // Empty State
  // ========================================================================

  emptyStateContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.card,
    paddingVertical: spacing.section * 2,
  },

  emptyStateIcon: {
    marginBottom: spacing.card,
  },

  emptyStateIconText: {
    fontSize: 64,
  },

  emptyStateTitle: {
    fontSize: typography.header.fontSize,
    fontWeight: typography.header.fontWeight,
    color: colors.textPrimary,
    marginBottom: 8,
    textAlign: 'center',
  },

  emptyStateSubtext: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
    marginBottom: spacing.section,
  },

  emptyStateButton: {
    width: '100%',
    maxWidth: 200,
  },

  // ========================================================================
  // Loading State
  // ========================================================================

  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: spacing.section * 2,
  },

  loadingText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    marginTop: spacing.card,
  },

  loadMoreContainer: {
    paddingVertical: spacing.card,
    alignItems: 'center',
  },
});
