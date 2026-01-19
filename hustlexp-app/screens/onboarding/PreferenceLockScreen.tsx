/**
 * Preference Lock Screen (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: ONBOARDING_PREFERENCE_LOCK
 * Spec Authority: HUSTLEXP-DOCS/ONBOARDING_SPEC.md §3 (Phase 4: Preference Lock-In)
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. PURPOSE (ONBOARDING_SPEC §3):
 *    - Collect preferences AFTER role is established
 *    - Role context makes answers truthful
 * 
 * 2. ROLE-SPECIFIC PREFERENCES:
 *    - Worker: task types, availability windows
 *    - Poster: task categories, urgency preference
 * 
 * 3. UI-ONLY: NO preference computation.
 *    - Collects selections only
 *    - Callback when complete
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
import { PrimaryActionButton } from '../../ui/PrimaryActionButton';
import { GlassCard } from '../../ui/GlassCard';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';
import { typography } from '../../ui/typography';

// ============================================================================
// TYPE DEFINITIONS (MAX-TIER: Explicit, Exhaustive, Documented)
// ============================================================================

/**
 * User role type.
 */
export type UserRole = 'worker' | 'poster';

/**
 * Preference option.
 * 
 * Represents a single preference choice.
 */
export interface PreferenceOption {
  /** Unique option identifier */
  id: string;
  
  /** Display label */
  label: string;
}

/**
 * Worker preferences.
 * 
 * Preferences specific to workers.
 */
export interface WorkerPreferences {
  /** Selected task types */
  taskTypes: string[];
  
  /** Selected availability windows */
  availability: string[];
}

/**
 * Poster preferences.
 * 
 * Preferences specific to posters.
 */
export interface PosterPreferences {
  /** Selected task categories */
  categories: string[];
  
  /** Selected urgency preference */
  urgency: string | null;
}

/**
 * Preference Lock Screen Props
 * 
 * Props for preference lock screen.
 */
export interface PreferenceLockScreenProps {
  /** User role (determines which preferences to show) */
  role: UserRole;
  
  /** Callback when preferences are complete */
  onComplete?: (preferences: WorkerPreferences | PosterPreferences) => void;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Worker-specific task types.
 * 
 * Options for workers to select task types they're interested in.
 */
const WORKER_TASK_TYPES: PreferenceOption[] = [
  { id: 'errands', label: 'Errands & Deliveries' },
  { id: 'cleaning', label: 'Cleaning & Organization' },
  { id: 'moving', label: 'Moving & Heavy Lifting' },
  { id: 'tech', label: 'Tech Support' },
  { id: 'handyman', label: 'Handyman Tasks' },
  { id: 'other', label: 'Other / Flexible' },
];

/**
 * Availability options (for workers).
 * 
 * Time windows workers can select.
 */
const AVAILABILITY_OPTIONS: PreferenceOption[] = [
  { id: 'weekday_morning', label: 'Weekday mornings' },
  { id: 'weekday_evening', label: 'Weekday evenings' },
  { id: 'weekend', label: 'Weekends' },
  { id: 'flexible', label: 'Flexible / Anytime' },
];

/**
 * Poster-specific task categories.
 * 
 * Options for posters to select categories they need help with.
 */
const POSTER_CATEGORIES: PreferenceOption[] = [
  { id: 'home', label: 'Home & Personal' },
  { id: 'business', label: 'Business Tasks' },
  { id: 'events', label: 'Events & Special' },
  { id: 'recurring', label: 'Recurring Needs' },
];

/**
 * Urgency options (for posters).
 * 
 * Urgency preference options for posters.
 */
const URGENCY_OPTIONS: PreferenceOption[] = [
  { id: 'asap', label: 'Usually urgent' },
  { id: 'planned', label: 'Usually planned ahead' },
  { id: 'flexible', label: 'Varies' },
];

/**
 * Minimum touch target height (A4 accessibility requirement).
 */
const MIN_TOUCH_TARGET_HEIGHT = 44;

// ============================================================================
// SUB-COMPONENTS (MAX-TIER: Modular, Reusable, Documented)
// ============================================================================

/**
 * Chip Button Component
 * 
 * Selectable chip/tag button for multi-select preferences.
 */
function ChipButton({
  option,
  isSelected,
  onSelect,
}: {
  option: PreferenceOption;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.chipButton, isSelected && styles.chipSelected]}
      onPress={onSelect}
      activeOpacity={0.8}
    >
      <Text
        style={[styles.chipText, isSelected && styles.chipTextSelected]}
      >
        {option.label}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * Radio Button Component
 * 
 * Single-select option button for urgency preference.
 */
function RadioButton({
  option,
  isSelected,
  onSelect,
}: {
  option: PreferenceOption;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.radioButton, isSelected && styles.radioSelected]}
      onPress={onSelect}
      activeOpacity={0.8}
    >
      <View style={styles.radioInner}>
        {isSelected && <View style={styles.radioDot} />}
      </View>
      <Text
        style={[styles.radioText, isSelected && styles.radioTextSelected]}
      >
        {option.label}
      </Text>
    </TouchableOpacity>
  );
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Preference Lock Screen
 * 
 * Phase 4 Preference Lock-In - Collects role-specific preferences
 * after role is established. Role context makes answers truthful.
 * 
 * ROLE-SPECIFIC PREFERENCES:
 * - Worker: task types, availability windows
 * - Poster: task categories, urgency preference
 * 
 * Follows ONBOARDING_SPEC.md §3 (Phase 4) exactly.
 * 
 * @param props - Preference lock screen props
 * @returns React component
 */
export function PreferenceLockScreen({
  role,
  onComplete,
}: PreferenceLockScreenProps) {
  // ========================================================================
  // State
  // ========================================================================

  const isWorker = role === 'worker';

  // Worker state
  const [selectedTaskTypes, setSelectedTaskTypes] = useState<string[]>([]);
  const [selectedAvailability, setSelectedAvailability] = useState<string[]>(
    []
  );

  // Poster state
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedUrgency, setSelectedUrgency] = useState<string | null>(null);

  // ========================================================================
  // Handlers
  // ========================================================================

  const toggleTaskType = (id: string) => {
    setSelectedTaskTypes((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  };

  const toggleAvailability = (id: string) => {
    setSelectedAvailability((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    );
  };

  const toggleCategory = (id: string) => {
    setSelectedCategories((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const handleComplete = () => {
    if (isWorker) {
      const preferences: WorkerPreferences = {
        taskTypes: selectedTaskTypes,
        availability: selectedAvailability,
      };
      onComplete?.(preferences);
    } else {
      const preferences: PosterPreferences = {
        categories: selectedCategories,
        urgency: selectedUrgency,
      };
      onComplete?.(preferences);
    }
  };

  // ========================================================================
  // Derived Values
  // ========================================================================

  const canContinue = isWorker
    ? selectedTaskTypes.length > 0
    : selectedCategories.length > 0 && selectedUrgency !== null;

  // Worker-specific options
  const taskTypeOptions = WORKER_TASK_TYPES;
  const availabilityOptions = AVAILABILITY_OPTIONS;

  // Poster-specific options
  const categoryOptions = POSTER_CATEGORIES;
  const urgencyOptions = URGENCY_OPTIONS;

  // Headers
  const mainHeader = isWorker
    ? 'What tasks interest you?'
    : 'What do you need help with?';
  const availabilityHeader = isWorker
    ? 'When are you available?'
    : 'How urgent are your tasks usually?';

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
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{mainHeader}</Text>
          <Text style={styles.headerSubtitle}>Select all that apply</Text>
        </View>

        {/* Task Types / Categories Section */}
        <GlassCard style={styles.sectionCard}>
          <View style={styles.optionGrid}>
            {(isWorker ? taskTypeOptions : categoryOptions).map((option) => (
              <ChipButton
                key={option.id}
                option={option}
                isSelected={
                  isWorker
                    ? selectedTaskTypes.includes(option.id)
                    : selectedCategories.includes(option.id)
                }
                onSelect={() =>
                  isWorker
                    ? toggleTaskType(option.id)
                    : toggleCategory(option.id)
                }
              />
            ))}
          </View>
        </GlassCard>

        {/* Availability (Worker) or Urgency (Poster) Section */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>{availabilityHeader}</Text>

          {isWorker ? (
            <GlassCard style={styles.sectionCard}>
              <View style={styles.optionGrid}>
                {availabilityOptions.map((option) => (
                  <ChipButton
                    key={option.id}
                    option={option}
                    isSelected={selectedAvailability.includes(option.id)}
                    onSelect={() => toggleAvailability(option.id)}
                  />
                ))}
              </View>
            </GlassCard>
          ) : (
            <GlassCard style={styles.sectionCard}>
              <View style={styles.optionList}>
                {urgencyOptions.map((option) => (
                  <RadioButton
                    key={option.id}
                    option={option}
                    isSelected={selectedUrgency === option.id}
                    onSelect={() => setSelectedUrgency(option.id)}
                  />
                ))}
              </View>
            </GlassCard>
          )}
        </View>

        {/* Continue Button */}
        <View style={styles.actionContainer}>
          <PrimaryActionButton
            label="Continue"
            onPress={handleComplete}
            disabled={!canContinue}
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

  header: {
    marginBottom: spacing.section * 2,
  },

  headerTitle: {
    fontSize: typography.header.fontSize,
    fontWeight: typography.header.fontWeight,
    color: colors.textPrimary,
    marginBottom: spacing.card / 2,
  },

  headerSubtitle: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
  },

  // ========================================================================
  // Sections
  // ========================================================================

  section: {
    marginBottom: spacing.section * 2,
  },

  sectionLabel: {
    fontSize: typography.body.fontSize,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.card,
  },

  sectionCard: {
    marginBottom: 0,
  },

  // ========================================================================
  // Option Grid (Chips)
  // ========================================================================

  optionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.card / 2, // 8px gap
  },

  chipButton: {
    backgroundColor: colors.glassSecondary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 8,
    paddingVertical: spacing.card / 2,
    paddingHorizontal: spacing.card,
    minHeight: MIN_TOUCH_TARGET_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
  },

  chipSelected: {
    borderColor: colors.textPrimary,
    backgroundColor: colors.glassPrimary,
  },

  chipText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
  },

  chipTextSelected: {
    color: colors.textPrimary,
    fontWeight: '600',
  },

  // ========================================================================
  // Option List (Radio Buttons)
  // ========================================================================

  optionList: {
    gap: spacing.card / 2,
  },

  radioButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.card / 2,
    minHeight: MIN_TOUCH_TARGET_HEIGHT,
  },

  radioSelected: {
    // Selection styling handled by radioDot
  },

  radioInner: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.glassBorderPrimary,
    marginRight: spacing.card,
    justifyContent: 'center',
    alignItems: 'center',
  },

  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.textPrimary,
  },

  radioText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    flex: 1,
  },

  radioTextSelected: {
    color: colors.textPrimary,
    fontWeight: '600',
  },

  // ========================================================================
  // Action Container
  // ========================================================================

  actionContainer: {
    marginTop: spacing.section,
  },
});
