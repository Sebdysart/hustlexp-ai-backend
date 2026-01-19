/**
 * Task Detail Screen (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: TASK_DETAIL
 * Spec Authority: HUSTLEXP-DOCS/architecture/FEED_QUERY_AND_ELIGIBILITY_RESOLVER_LOCKED.md
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. ELIGIBILITY GUARANTEE: If task is shown, user IS eligible.
 *    NO disabled buttons, NO eligibility checks, NO warnings.
 * 
 * 2. FORBIDDEN ELEMENTS:
 *    - ❌ Disabled accept button
 *    - ❌ "Apply anyway" flows
 *    - ❌ Eligibility warnings
 *    - ❌ Trust logic in UI
 * 
 * 3. DETERMINISTIC LANGUAGE:
 *    - Factual, descriptive (not emotional)
 *    - No urgency manipulation
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
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { HustlerMainStackParamList } from '../../navigation/types';

// Design System Imports
import { GlassCard } from '../../ui/GlassCard';
import { PrimaryActionButton } from '../../ui/PrimaryActionButton';
import { SectionHeader } from '../../ui/SectionHeader';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';
import { typography } from '../../ui/typography';

interface TaskDetailScreenProps {
  taskId: string;
}

type NavigationProp = NativeStackNavigationProp<HustlerMainStackParamList>;

interface Task {
  id: string;
  title: string;
  description: string;
  category: string;
  price: number;
  xpReward: number;
  location: string;
  deadline?: string;
  estimatedDuration?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  requirements?: string;
  posterName?: string;
  createdAt: string;
}

// Mock data - will be replaced with tRPC query
const MOCK_TASK: Task = {
  id: 'task-123',
  title: 'Fix leaky faucet',
  description: 'Kitchen faucet is leaking. Need someone to fix it. Should take about 30 minutes.',
  category: 'plumbing',
  price: 45.00,
  xpReward: 50,
  location: '123 Main St, Seattle, WA',
  deadline: '2025-01-18T18:00:00Z',
  estimatedDuration: '30 minutes',
  difficulty: 'medium',
  requirements: 'Basic plumbing tools required',
  posterName: 'John D.',
  createdAt: '2025-01-17T10:00:00Z',
};

export default function TaskDetailScreen() {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute();
  const { taskId } = route.params as TaskDetailScreenProps;

  const [task, setTask] = useState<Task>(MOCK_TASK);
  const [isLoading, setIsLoading] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);

  // TODO: Replace with tRPC query
  // useEffect(() => {
  //   const fetchTask = async () => {
  //     setIsLoading(true);
  //     try {
  //       const taskData = await trpc.tasks.get.query({ taskId });
  //       setTask(taskData);
  //     } catch (error) {
  //       console.error('Failed to fetch task:', error);
  //     } finally {
  //       setIsLoading(false);
  //     }
  //   };
  //   fetchTask();
  // }, [taskId]);

  const handleAccept = async () => {
    setIsAccepting(true);
    try {
      // TODO: Replace with tRPC mutation
      // await trpc.tasks.accept.mutate({ taskId });
      console.log('[TaskDetail] Accepting task:', taskId);
      
      // Navigate to TaskInProgress after acceptance
      navigation.navigate('TaskInProgress', { taskId });
    } catch (error) {
      console.error('Failed to accept task:', error);
    } finally {
      setIsAccepting(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const getDifficultyColor = (difficulty?: string) => {
    switch (difficulty) {
      case 'easy':
        return '#34C759';
      case 'medium':
        return '#FF9500';
      case 'hard':
        return '#FF3B30';
      default:
        return colors.muted;
    }
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.textPrimary} />
          <Text style={styles.loadingText}>Loading task details...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.backButton}
          >
            <MaterialIcons name="arrow-back" size={24} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Task Details</Text>
          <View style={styles.backButton} /> {/* Placeholder for alignment */}
        </View>

        {/* Task Title */}
        <View style={styles.titleSection}>
          <Text style={styles.title}>{task.title}</Text>
          <View style={styles.categoryBadge}>
            <Text style={styles.categoryText}>{task.category}</Text>
          </View>
        </View>

        {/* Price & XP */}
        <GlassCard style={styles.priceCard}>
          <View style={styles.priceRow}>
            <View>
              <Text style={styles.priceLabel}>PAYOUT</Text>
              <Text style={styles.priceAmount}>${task.price.toFixed(2)}</Text>
            </View>
            <View style={styles.xpSection}>
              <MaterialIcons name="star" size={20} color="#FFD700" />
              <Text style={styles.xpText}>+{task.xpReward} XP</Text>
            </View>
          </View>
        </GlassCard>

        {/* Description */}
        <GlassCard style={styles.sectionCard}>
          <SectionHeader title="Description" />
          <Text style={styles.description}>{task.description}</Text>
        </GlassCard>

        {/* Details Grid */}
        <View style={styles.detailsGrid}>
          <GlassCard style={styles.detailCard}>
            <MaterialIcons name="location-on" size={20} color={colors.muted} />
            <Text style={styles.detailLabel}>LOCATION</Text>
            <Text style={styles.detailValue}>{task.location}</Text>
          </GlassCard>

          {task.estimatedDuration && (
            <GlassCard style={styles.detailCard}>
              <MaterialIcons name="schedule" size={20} color={colors.muted} />
              <Text style={styles.detailLabel}>DURATION</Text>
              <Text style={styles.detailValue}>{task.estimatedDuration}</Text>
            </GlassCard>
          )}

          {task.difficulty && (
            <GlassCard style={styles.detailCard}>
              <MaterialIcons name="trending-up" size={20} color={getDifficultyColor(task.difficulty)} />
              <Text style={styles.detailLabel}>DIFFICULTY</Text>
              <Text style={[styles.detailValue, { color: getDifficultyColor(task.difficulty) }]}>
                {task.difficulty.toUpperCase()}
              </Text>
            </GlassCard>
          )}

          {task.deadline && (
            <GlassCard style={styles.detailCard}>
              <MaterialIcons name="event" size={20} color={colors.muted} />
              <Text style={styles.detailLabel}>DEADLINE</Text>
              <Text style={styles.detailValue}>{formatDate(task.deadline)}</Text>
            </GlassCard>
          )}
        </View>

        {/* Requirements */}
        {task.requirements && (
          <GlassCard style={styles.sectionCard}>
            <SectionHeader title="Requirements" />
            <Text style={styles.requirements}>{task.requirements}</Text>
          </GlassCard>
        )}

        {/* Poster Info */}
        {task.posterName && (
          <GlassCard style={styles.sectionCard}>
            <SectionHeader title="Posted By" />
            <View style={styles.posterRow}>
              <View style={styles.posterAvatar}>
                <Text style={styles.posterInitials}>
                  {task.posterName.split(' ').map(n => n[0]).join('').toUpperCase()}
                </Text>
              </View>
              <Text style={styles.posterName}>{task.posterName}</Text>
            </View>
          </GlassCard>
        )}

        {/* Posted Time */}
        <View style={styles.metaSection}>
          <Text style={styles.metaText}>
            Posted {formatDate(task.createdAt)}
          </Text>
        </View>
      </ScrollView>

      {/* Accept Button */}
      <View style={styles.footer}>
        <PrimaryActionButton
          label={isAccepting ? 'Accepting...' : 'Accept Task'}
          onPress={handleAccept}
          disabled={isAccepting}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: spacing.section,
    paddingBottom: 100,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: spacing.md,
    color: colors.muted,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.section,
  },
  backButton: {
    width: 40,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  titleSection: {
    marginBottom: spacing.section,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.md,
  },
  categoryBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.glassPrimary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  categoryText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
  },
  priceCard: {
    marginBottom: spacing.section,
  },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  priceLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: spacing.xs,
  },
  priceAmount: {
    fontSize: 32,
    fontWeight: '700',
    color: '#34C759',
  },
  xpSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  xpText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  sectionCard: {
    marginBottom: spacing.section,
  },
  description: {
    fontSize: typography.body.fontSize,
    color: colors.textSecondary,
    lineHeight: 22,
    marginTop: spacing.md,
  },
  detailsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginBottom: spacing.section,
  },
  detailCard: {
    flex: 1,
    minWidth: '45%',
    alignItems: 'center',
    padding: spacing.md,
  },
  detailLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  requirements: {
    fontSize: typography.body.fontSize,
    color: colors.textSecondary,
    lineHeight: 22,
    marginTop: spacing.md,
  },
  posterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  posterAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.glassSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  posterInitials: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  posterName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  metaSection: {
    alignItems: 'center',
    marginTop: spacing.md,
  },
  metaText: {
    fontSize: 12,
    color: colors.muted,
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.section,
    paddingBottom: 32,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorderSecondary,
  },
});
