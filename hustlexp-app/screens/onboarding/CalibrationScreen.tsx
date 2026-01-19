/**
 * Calibration Screen (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: ONBOARDING_CALIBRATION
 * Spec Authority: HUSTLEXP-DOCS/ONBOARDING_SPEC.md §3 (Phase 1: Calibration Prompts)
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. DESIGN PRINCIPLES (ONBOARDING_SPEC §3):
 *    - Single sentence prompts
 *    - Binary/ternary choices only
 *    - No explanations
 *    - No emojis
 *    - No "why we ask"
 *    - Neutral, professional copy
 * 
 * 2. ACCESSIBILITY (ONBOARDING_SPEC):
 *    - Touch targets ≥44px (A4 requirement)
 * 
 * 3. ANIMATION (ONBOARDING_SPEC):
 *    - Fade transitions ≤300ms (M1 requirement)
 * 
 * 4. UI-ONLY: NO role inference computation.
 *    - Collects responses only
 *    - Navigation handled via props
 * 
 * ============================================================================
 * COMPONENT DEPENDENCIES
 * ============================================================================
 * 
 * Required Tokens:
 * - colors (hustlexp-app/ui/colors.ts)
 * - spacing (hustlexp-app/ui/spacing.ts)
 * - typography (hustlexp-app/ui/typography.ts)
 * 
 * ============================================================================
 */

import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  Animated,
} from 'react-native';

// Design System Imports
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';
import { typography } from '../../ui/typography';

// ============================================================================
// TYPE DEFINITIONS (MAX-TIER: Explicit, Exhaustive, Documented)
// ============================================================================

/**
 * Calibration option.
 * 
 * Represents a single choice option for a calibration question.
 */
export interface CalibrationOption {
  /** Unique option identifier */
  id: string;
  
  /** Display label */
  label: string;
}

/**
 * Calibration question.
 * 
 * Represents a single calibration question with its options.
 */
export interface CalibrationQuestion {
  /** Unique question identifier */
  id: string;
  
  /** Question prompt text */
  prompt: string;
  
  /** Available options */
  options: CalibrationOption[];
}

/**
 * Calibration responses.
 * 
 * Maps question IDs to selected option IDs.
 */
export interface CalibrationResponses {
  [questionId: string]: string;
}

/**
 * Calibration Screen Props
 * 
 * Props for calibration screen navigation and callbacks.
 */
export interface CalibrationScreenProps {
  /** Initial question index (default: 0) */
  initialQuestionIndex?: number;
  
  /** Initial responses (default: empty) */
  initialResponses?: CalibrationResponses;
  
  /** Callback when all questions are answered */
  onComplete?: (responses: CalibrationResponses) => void;
  
  /** Callback when user skips */
  onSkip?: (responses: CalibrationResponses) => void;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Calibration questions from ONBOARDING_SPEC §3.
 * 
 * 5 questions total, each with binary/ternary choices.
 * Exact wording from spec.
 */
const CALIBRATION_QUESTIONS: CalibrationQuestion[] = [
  {
    id: 'q1_motivation',
    prompt: 'Which matters more right now?',
    options: [
      { id: 'earning_income', label: 'Earning extra income' },
      { id: 'getting_done', label: 'Getting things done' },
      { id: 'both_equally', label: 'Both equally' },
    ],
  },
  {
    id: 'q2_frustration',
    prompt: "What frustrates you most about getting help?",
    options: [
      { id: 'finding_reliable', label: 'Finding reliable people' },
      { id: 'getting_paid', label: 'Getting paid fairly' },
      { id: 'poor_communication', label: 'Poor communication' },
    ],
  },
  {
    id: 'q3_availability',
    prompt: 'How much time can you commit weekly?',
    options: [
      { id: 'flexible', label: 'Flexible, varies weekly' },
      { id: 'limited', label: 'Limited, specific hours' },
      { id: 'minimal', label: 'Minimal, just oversight' },
    ],
  },
  {
    id: 'q4_price',
    prompt: 'When it comes to price:',
    options: [
      { id: 'compete_value', label: 'I compete on value' },
      { id: 'pay_quality', label: 'I pay for quality' },
      { id: 'fair_rates', label: 'Fair rates matter most' },
    ],
  },
  {
    id: 'q5_control',
    prompt: 'Your preferred working style:',
    options: [
      { id: 'work_independently', label: 'Work independently' },
      { id: 'clear_direction', label: 'Clear direction helps' },
      { id: 'delegate_verify', label: 'Delegate and verify' },
    ],
  },
];

/**
 * Minimum touch target height (A4 accessibility requirement).
 */
const MIN_TOUCH_TARGET_HEIGHT = 44;

/**
 * Fade animation duration (M1 requirement: ≤300ms total).
 */
const FADE_DURATION = 150; // Half duration for fade in/out (150 + 150 = 300ms)

/**
 * Progress bar height.
 */
const PROGRESS_BAR_HEIGHT = 2;

// ============================================================================
// HELPER FUNCTIONS (MAX-TIER: Pure, Documented, Type-Safe)
// ============================================================================

/**
 * Calculates progress percentage (0-1).
 * 
 * @param currentIndex - Current question index (0-based)
 * @param totalQuestions - Total number of questions
 * @returns Progress value between 0 and 1
 */
function calculateProgress(
  currentIndex: number,
  totalQuestions: number
): number {
  return (currentIndex + 1) / totalQuestions;
}

// ============================================================================
// SUB-COMPONENTS (MAX-TIER: Modular, Reusable, Documented)
// ============================================================================

/**
 * Progress Bar Component
 * 
 * Minimal progress indicator showing current question position.
 */
function ProgressBar({ progress }: { progress: number }) {
  return (
    <View style={styles.progressContainer}>
      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            { width: `${progress * 100}%` },
          ]}
        />
      </View>
    </View>
  );
}

/**
 * Option Button Component
 * 
 * Single choice option button with A4-compliant touch target.
 */
function OptionButton({
  option,
  onSelect,
}: {
  option: CalibrationOption;
  onSelect: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.optionButton}
      onPress={onSelect}
      activeOpacity={0.7}
    >
      <Text style={styles.optionText}>{option.label}</Text>
    </TouchableOpacity>
  );
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Calibration Screen
 * 
 * Phase 1 Calibration Prompts - Collects role inference data through
 * 5 behavioral questions. Each question has binary/ternary choices.
 * 
 * DESIGN PRINCIPLES (ONBOARDING_SPEC §3):
 * - Single sentence prompts
 * - Binary/ternary choices only
 * - No explanations
 * - No emojis
 * - No "why we ask"
 * - Neutral, professional copy
 * 
 * Follows ONBOARDING_SPEC.md §3 exactly.
 * 
 * @param props - Calibration screen props
 * @returns React component
 */
export function CalibrationScreen({
  initialQuestionIndex = 0,
  initialResponses = {},
  onComplete,
  onSkip,
}: CalibrationScreenProps) {
  // ========================================================================
  // State
  // ========================================================================

  const [currentIndex, setCurrentIndex] = useState(initialQuestionIndex);
  const [responses, setResponses] = useState<CalibrationResponses>(
    initialResponses
  );
  const fadeAnim = useRef(new Animated.Value(1)).current;

  // ========================================================================
  // Derived Values
  // ========================================================================

  const currentQuestion = CALIBRATION_QUESTIONS[currentIndex];
  const totalQuestions = CALIBRATION_QUESTIONS.length;
  const progress = calculateProgress(currentIndex, totalQuestions);
  const isLastQuestion = currentIndex === totalQuestions - 1;

  // ========================================================================
  // Handlers
  // ========================================================================

  const handleSelect = (optionId: string) => {
    const newResponses = {
      ...responses,
      [currentQuestion.id]: optionId,
    };
    setResponses(newResponses);

    // Fade transition (≤300ms per M1)
    Animated.timing(fadeAnim, {
      toValue: 0,
      duration: FADE_DURATION,
      useNativeDriver: true,
    }).start(() => {
      if (isLastQuestion) {
        // Last question - complete
        onComplete?.(newResponses);
      } else {
        // Move to next question
        setCurrentIndex(currentIndex + 1);
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: FADE_DURATION,
          useNativeDriver: true,
        }).start();
      }
    });
  };

  const handleSkip = () => {
    onSkip?.(responses);
  };

  // ========================================================================
  // Render
  // ========================================================================

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Progress Bar - Minimal */}
      <ProgressBar progress={progress} />

      {/* Content with Fade Animation */}
      <Animated.View style={[styles.content, { opacity: fadeAnim }]}>
        {/* Question Container */}
        <View style={styles.questionContainer}>
          <Text style={styles.prompt}>{currentQuestion.prompt}</Text>
        </View>

        {/* Options Container */}
        <View style={styles.optionsContainer}>
          {currentQuestion.options.map((option) => (
            <OptionButton
              key={option.id}
              option={option}
              onSelect={() => handleSelect(option.id)}
            />
          ))}
        </View>
      </Animated.View>

      {/* Skip Button */}
      <TouchableOpacity style={styles.skipButton} onPress={handleSkip}>
        <Text style={styles.skipText}>Skip</Text>
      </TouchableOpacity>
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
  // Progress Bar
  // ========================================================================

  progressContainer: {
    paddingHorizontal: spacing.card,
    paddingTop: spacing.card,
  },

  progressTrack: {
    height: PROGRESS_BAR_HEIGHT,
    backgroundColor: colors.glassBorderSecondary,
    borderRadius: 1,
  },

  progressFill: {
    height: PROGRESS_BAR_HEIGHT,
    backgroundColor: colors.textPrimary,
    borderRadius: 1,
  },

  // ========================================================================
  // Content
  // ========================================================================

  content: {
    flex: 1,
    paddingHorizontal: spacing.card,
    justifyContent: 'center',
  },

  questionContainer: {
    marginBottom: spacing.section * 2, // 48px spacing
  },

  prompt: {
    fontSize: typography.header.fontSize,
    fontWeight: typography.header.fontWeight,
    color: colors.textPrimary,
    textAlign: 'center',
    lineHeight: 36,
  },

  // ========================================================================
  // Options
  // ========================================================================

  optionsContainer: {
    gap: spacing.card / 2, // 8px gap between options
  },

  optionButton: {
    backgroundColor: colors.glassPrimary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 12,
    paddingVertical: spacing.card,
    paddingHorizontal: spacing.section,
    minHeight: MIN_TOUCH_TARGET_HEIGHT, // A4: ≥44px
    justifyContent: 'center',
    alignItems: 'center',
  },

  optionText: {
    fontSize: typography.body.fontSize,
    color: colors.textPrimary,
    textAlign: 'center',
  },

  // ========================================================================
  // Skip Button
  // ========================================================================

  skipButton: {
    alignSelf: 'center',
    paddingVertical: spacing.card,
    paddingHorizontal: spacing.section,
    marginBottom: spacing.card,
  },

  skipText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
  },
});
