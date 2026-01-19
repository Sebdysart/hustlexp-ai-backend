/**
 * Task History Screen (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: HUSTLER_TASK_HISTORY
 * Spec Authority: Canonical screen taxonomy (feed authority enforcement)
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS (HARD-SCOPED)
 * ============================================================================
 * 
 * 1. SCOPE RESTRICTIONS (NON-NEGOTIABLE):
 *    ✅ Show ONLY: completed tasks, cancelled tasks, expired tasks, drafts
 *    ❌ NEVER: query available tasks, share feed query logic, show eligibility-gated content
 * 
 * 2. FEED AUTHORITY (PRODUCT_SPEC §17, ARCHITECTURE §13):
 *    - TaskFeedScreen is the ONLY browse surface for available tasks
 *    - This screen shows historical/past tasks only
 *    - If a task is available, it appears in TaskFeedScreen, not here
 * 
 * 3. DATA SOURCE:
 *    - All tasks displayed must have status: COMPLETED, CANCELLED, or EXPIRED
 *    - No active/pending tasks allowed
 *    - No task filtering by eligibility (past tasks are already resolved)
 * 
 * 4. SPEC RULES (UI_SPEC §6):
 *    - Celebration: ❌ Forbidden
 *    - Animation: Card hover only
 *    - XP Colors: ❌ Forbidden
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
  FlatList,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
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
 * Task status for history tasks.
 * 
 * Only past/resolved task statuses are allowed.
 */
export type TaskHistoryStatus = 'COMPLETED' | 'CANCELLED' | 'EXPIRED';

/**
 * Task history item.
 * 
 * Represents a single past task (completed, cancelled, or expired).
 */
export interface TaskHistoryItem {
  /** Task ID */
  id: string;
  
  /** Task title */
  title: string;
  
  /** Task price (in cents) */
  price: number;
  
  /** Task location */
  location: string;
  
  /** Task status (must be past/resolved) */
  status: TaskHistoryStatus;
  
  /** Completion/cancellation date (ISO 8601) */
  resolvedAt: string;
}

/**
 * Task History Screen Props
 * 
 * Props for task history screen display.
 * All tasks must be past/resolved tasks only.
 */
export interface TaskHistoryScreenProps {
  /** List of past tasks to display (completed, cancelled, expired) */
  tasks?: TaskHistoryItem[];
  
  /** Callback when task is selected */
  onTaskSelect?: (taskId: string) => void;
  
  /** Callback when view details is pressed */
  onViewDetails?: (taskId: string) => void;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Default/placeholder history tasks.
 * 
 * All have past/resolved statuses.
 */
const PLACEHOLDER_TASKS: TaskHistoryItem[] = [
  {
    id: '1',
    title: 'Help move furniture',
    price: 5000,
    location: 'Campus',
    status: 'COMPLETED',
    resolvedAt: '2025-01-15T10:00:00Z',
  },
  {
    id: '2',
    title: 'Pick up groceries',
    price: 2500,
    location: 'Downtown',
    status: 'CANCELLED',
    resolvedAt: '2025-01-14T14:30:00Z',
  },
  {
    id: '3',
    title: 'Deliver package',
    price: 1500,
    location: 'Library',
    status: 'EXPIRED',
    resolvedAt: '2025-01-13T18:00:00Z',
  },
];

/**
 * Header text.
 */
const HEADER_TITLE = 'Task History';

/**
 * Subtitle text.
 */
const SUBTITLE_TEXT = 'Past tasks and activity';

/**
 * Empty state text.
 */
const EMPTY_TEXT = 'No past tasks';

/**
 * Formatters.
 */
function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

/**
 * Format task status for display.
 */
function formatStatus(status: TaskHistoryStatus): string {
  switch (status) {
    case 'COMPLETED':
      return 'Completed';
    case 'CANCELLED':
      return 'Cancelled';
    case 'EXPIRED':
      return 'Expired';
  }
}

// ============================================================================
// SUB-COMPONENTS (MAX-TIER: Modular, Reusable, Documented)
// ============================================================================

/**
 * Task History Card Component
 * 
 * Displays a single past task card.
 * Note: Money color NOT used here (only for escrow states per UI_SPEC §2).
 */
function TaskHistoryCard({
  task,
  onPress,
  onViewDetails,
}: {
  task: TaskHistoryItem;
  onPress?: () => void;
  onViewDetails?: () => void;
}) {
  return (
    <GlassCard style={styles.taskCard}>
      <TouchableOpacity onPress={onPress} activeOpacity={0.8}>
        <View style={styles.taskHeader}>
          <Text style={styles.taskTitle}>{task.title}</Text>
          {/* Money color only for escrow states - using neutral here */}
          <Text style={styles.taskPrice}>{formatPrice(task.price)}</Text>
        </View>
        <View style={styles.taskMeta}>
          <Text style={styles.taskLocation}>{task.location}</Text>
          <Text style={styles.taskStatus}>{formatStatus(task.status)}</Text>
        </View>
      </TouchableOpacity>

      <View style={styles.viewButtonContainer}>
        <PrimaryActionButton
          label="View Details"
          onPress={onViewDetails}
        />
      </View>
    </GlassCard>
  );
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Task History Screen
 * 
 * Displays past tasks (completed, cancelled, expired).
 * 
 * HARD-SCOPED RESTRICTIONS:
 * - ✅ Shows ONLY past/resolved tasks (COMPLETED, CANCELLED, EXPIRED)
 * - ❌ NEVER queries available tasks (TaskFeedScreen is canonical for available tasks)
 * - ❌ NEVER shares feed query logic
 * - ❌ NEVER shows eligibility-gated content
 * 
 * FEED AUTHORITY (PRODUCT_SPEC §17, ARCHITECTURE §13):
 * - If a task is available, it appears in TaskFeedScreen, not here
 * - This screen is strictly for historical/past task viewing
 * 
 * SPEC RULES (UI_SPEC §6):
 * - Celebration: ❌ Forbidden
 * - Animation: Card hover only
 * - XP Colors: ❌ Forbidden
 * 
 * @param props - Task history screen props
 * @returns React component
 */
export function TaskHistoryScreen({
  tasks = PLACEHOLDER_TASKS,
  onTaskSelect,
  onViewDetails,
}: TaskHistoryScreenProps) {
  // ========================================================================
  // Handlers
  // ========================================================================

  const handleTaskPress = (taskId: string) => {
    onTaskSelect?.(taskId);
  };

  const handleViewDetails = (taskId: string) => {
    onViewDetails?.(taskId);
  };

  // ========================================================================
  // Render
  // ========================================================================

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{HEADER_TITLE}</Text>
        <Text style={styles.subtitle}>{SUBTITLE_TEXT}</Text>
      </View>

      {/* Task List */}
      <FlatList
        data={tasks}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TaskHistoryCard
            task={item}
            onPress={() => handleTaskPress(item.id)}
            onViewDetails={() => handleViewDetails(item.id)}
          />
        )}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <GlassCard style={styles.emptyCard}>
            <Text style={styles.emptyText}>{EMPTY_TEXT}</Text>
          </GlassCard>
        }
      />
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

  // ========================================================================
  // Header
  // ========================================================================

  header: {
    padding: spacing.card,
    paddingBottom: spacing.card / 2,
  },

  headerTitle: {
    fontSize: typography.header.fontSize,
    fontWeight: typography.header.fontWeight,
    color: colors.textPrimary,
    marginBottom: spacing.card / 2,
  },

  subtitle: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
  },

  // ========================================================================
  // Task List
  // ========================================================================

  list: {
    padding: spacing.card,
    paddingTop: spacing.card / 2,
  },

  taskCard: {
    marginBottom: spacing.card,
    padding: spacing.section,
  },

  taskHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.card / 2,
  },

  taskTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textPrimary,
    flex: 1,
  },

  taskPrice: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textPrimary, // Not money color (only for escrow states)
    marginLeft: spacing.card,
  },

  taskMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.card,
  },

  taskLocation: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
  },

  taskStatus: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  viewButtonContainer: {
    marginTop: spacing.card,
  },

  // ========================================================================
  // Empty State
  // ========================================================================

  emptyCard: {
    padding: spacing.section * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },

  emptyText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
  },
});
