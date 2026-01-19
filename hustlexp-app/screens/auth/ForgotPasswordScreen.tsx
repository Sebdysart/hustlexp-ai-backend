/**
 * Forgot Password Screen (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: AUTH_FORGOT_PASSWORD
 * Spec Authority: Standard authentication flow
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. SPEC COMPLIANCE:
 *    - A4: Touch targets minimum 44px
 *    - C3: No gradients on buttons
 * 
 * 2. UI-ONLY: NO password reset logic.
 *    - Collects email only
 *    - Callback when reset requested
 *    - Success state shown when reset email sent
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
  TextInput,
  StyleSheet,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
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
 * Forgot Password Screen Props
 * 
 * Props for forgot password screen navigation and callbacks.
 */
export interface ForgotPasswordScreenProps {
  /** Callback when reset request is submitted */
  onReset?: (email: string) => void;
  
  /** Callback when back button is pressed */
  onBack?: () => void;
  
  /** Callback when back to sign in is pressed (success state) */
  onBackToSignIn?: () => void;
  
  /** Whether reset request is in progress */
  isLoading?: boolean;
  
  /** Whether reset email was successfully sent */
  isSent?: boolean;
  
  /** Error message to display */
  error?: string | null;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Header text.
 */
const HEADER_TEXT = 'Reset Password';

/**
 * Subtitle text.
 */
const SUBTITLE_TEXT = "Enter your email and we'll send you reset instructions";

/**
 * Success state text.
 */
const SUCCESS_TITLE = 'Check Your Email';

/**
 * Form labels.
 */
const LABELS = {
  email: 'Email',
} as const;

/**
 * Placeholders.
 */
const PLACEHOLDERS = {
  email: 'your@email.com',
} as const;

/**
 * Button labels.
 */
const BUTTON_LABELS = {
  sendResetLink: 'Send Reset Link',
  back: '← Back',
  backToSignIn: 'Back to Sign In',
} as const;

/**
 * Minimum touch target height (A4 accessibility requirement).
 */
const MIN_TOUCH_TARGET_HEIGHT = 44;

// ============================================================================
// SUB-COMPONENTS (MAX-TIER: Modular, Reusable, Documented)
// ============================================================================

/**
 * Text Input Component
 * 
 * Styled text input with label and proper focus states.
 */
function StyledTextInput({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = 'default',
  autoCapitalize = 'none',
  autoComplete,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'email-address';
  autoCapitalize?: 'none';
  autoComplete?: 'email';
}) {
  const [isFocused, setIsFocused] = useState(false);

  return (
    <View style={styles.inputContainer}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        style={[
          styles.input,
          isFocused && styles.inputFocused, // A2: Focus states visible
        ]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoComplete={autoComplete}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
      />
    </View>
  );
}

/**
 * Success State Component
 * 
 * Displays when reset email has been sent successfully.
 */
function SuccessState({
  email,
  onBackToSignIn,
}: {
  email: string;
  onBackToSignIn?: () => void;
}) {
  return (
    <View style={styles.successContainer}>
      <Text style={styles.successTitle}>{SUCCESS_TITLE}</Text>
      <Text style={styles.successText}>
        We've sent password reset instructions to {email}
      </Text>
      <View style={styles.successButtonContainer}>
        <PrimaryActionButton
          label={BUTTON_LABELS.backToSignIn}
          onPress={onBackToSignIn}
        />
      </View>
    </View>
  );
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Forgot Password Screen
 * 
 * Password reset request screen with email input.
 * Shows success state after reset email is sent.
 * 
 * SPEC COMPLIANCE:
 * - A4: Touch targets minimum 44px
 * - C3: No gradients on buttons
 * 
 * @param props - Forgot password screen props
 * @returns React component
 */
export function ForgotPasswordScreen({
  onReset,
  onBack,
  onBackToSignIn,
  isLoading = false,
  isSent = false,
  error,
}: ForgotPasswordScreenProps) {
  // ========================================================================
  // State
  // ========================================================================

  const [email, setEmail] = useState('');

  // ========================================================================
  // Handlers
  // ========================================================================

  const handleReset = () => {
    if (!email) {
      return; // Validation handled by parent if needed
    }
    onReset?.(email);
  };

  const handleBack = () => {
    onBack?.();
  };

  // ========================================================================
  // Render Success State
  // ========================================================================

  if (isSent) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.content}>
          <SuccessState email={email} onBackToSignIn={onBackToSignIn} />
        </View>
      </SafeAreaView>
    );
  }

  // ========================================================================
  // Render Form State
  // ========================================================================

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <View style={styles.content}>
          {/* Back Button */}
          <TouchableOpacity onPress={handleBack} style={styles.backNav}>
            <Text style={styles.backNavText}>{BUTTON_LABELS.back}</Text>
          </TouchableOpacity>

          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>{HEADER_TEXT}</Text>
            <Text style={styles.subtitle}>{SUBTITLE_TEXT}</Text>
          </View>

          {/* Form */}
          <GlassCard style={styles.formCard}>
            {/* Error Message */}
            {error && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {/* Email Input */}
            <StyledTextInput
              label={LABELS.email}
              value={email}
              onChangeText={setEmail}
              placeholder={PLACEHOLDERS.email}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
            />

            {/* Send Reset Link Button */}
            <View style={styles.submitButtonContainer}>
              <PrimaryActionButton
                label={BUTTON_LABELS.sendResetLink}
                onPress={handleReset}
                disabled={isLoading || !email}
              />
            </View>
          </GlassCard>
        </View>
      </KeyboardAvoidingView>
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

  keyboardView: {
    flex: 1,
  },

  content: {
    flex: 1,
    padding: spacing.card,
    justifyContent: 'center',
  },

  // ========================================================================
  // Back Navigation
  // ========================================================================

  backNav: {
    position: 'absolute',
    top: spacing.card,
    left: spacing.card,
    paddingVertical: spacing.card / 2, // A4: Touch target
    paddingHorizontal: spacing.card / 2,
    zIndex: 10,
  },

  backNavText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
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

  subtitle: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
  },

  // ========================================================================
  // Form Card
  // ========================================================================

  formCard: {
    padding: spacing.section,
  },

  // ========================================================================
  // Error Container
  // ========================================================================

  errorContainer: {
    marginBottom: spacing.card,
    paddingVertical: spacing.card / 2,
    paddingHorizontal: spacing.card,
    backgroundColor: 'rgba(255, 59, 48, 0.1)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 59, 48, 0.3)',
  },

  errorText: {
    fontSize: typography.body.fontSize,
    color: '#FF3B30',
    textAlign: 'center',
  },

  // ========================================================================
  // Text Input
  // ========================================================================

  inputContainer: {
    marginBottom: spacing.section,
  },

  inputLabel: {
    fontSize: typography.body.fontSize,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.card / 2,
  },

  input: {
    backgroundColor: colors.glassSecondary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 12,
    paddingVertical: spacing.card,
    paddingHorizontal: spacing.card,
    fontSize: typography.body.fontSize,
    color: colors.textPrimary,
    minHeight: MIN_TOUCH_TARGET_HEIGHT, // A4: ≥44px
  },

  inputFocused: {
    borderColor: colors.textPrimary, // A2: Focus states visible
    borderWidth: 2,
  },

  // ========================================================================
  // Submit Button
  // ========================================================================

  submitButtonContainer: {
    marginTop: spacing.card,
  },

  // ========================================================================
  // Success State
  // ========================================================================

  successContainer: {
    alignItems: 'center',
  },

  successTitle: {
    fontSize: typography.header.fontSize,
    fontWeight: typography.header.fontWeight,
    color: colors.textPrimary,
    marginBottom: spacing.card,
    textAlign: 'center',
  },

  successText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
    marginBottom: spacing.section * 2,
  },

  successButtonContainer: {
    width: '100%',
  },
});
