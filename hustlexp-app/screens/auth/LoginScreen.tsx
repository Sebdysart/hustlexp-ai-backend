/**
 * Login Screen (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: AUTH_LOGIN
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
 *    - A2: Focus states visible on inputs
 * 
 * 2. UI-ONLY: NO authentication logic.
 *    - Collects credentials only
 *    - Callback when login attempted
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
 * Login Screen Props
 * 
 * Props for login screen navigation and callbacks.
 */
export interface LoginScreenProps {
  /** Callback when login form is submitted */
  onLogin?: (email: string, password: string) => void;
  
  /** Callback when forgot password is pressed */
  onForgotPassword?: () => void;
  
  /** Callback when sign up link is pressed */
  onSignUp?: () => void;
  
  /** Whether login is in progress */
  isLoading?: boolean;
  
  /** Error message to display */
  error?: string | null;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * App name/title.
 */
const APP_NAME = 'HustleXP';

/**
 * Subtitle text.
 */
const SUBTITLE_TEXT = 'Sign in to continue';

/**
 * Form labels.
 */
const LABELS = {
  email: 'Email',
  password: 'Password',
} as const;

/**
 * Placeholders.
 */
const PLACEHOLDERS = {
  email: 'your@email.com',
  password: 'Enter password',
} as const;

/**
 * Button labels.
 */
const BUTTON_LABELS = {
  signIn: 'Sign In',
  forgotPassword: 'Forgot password?',
} as const;

/**
 * Link text.
 */
const LINK_TEXT = {
  noAccount: "Don't have an account?",
  signUp: 'Sign Up',
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
  secureTextEntry = false,
  keyboardType = 'default',
  autoCapitalize = 'none',
  autoComplete,
  style,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address';
  autoCapitalize?: 'none' | 'sentences';
  autoComplete?: 'email' | 'password' | 'name';
  style?: any;
}) {
  const [isFocused, setIsFocused] = useState(false);

  return (
    <View style={[styles.inputContainer, style]}>
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
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoComplete={autoComplete}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
      />
    </View>
  );
}

// ============================================================================
// MAIN COMPONENT (MAX-TIER: Clean, Documented, Well-Structured)
// ============================================================================

/**
 * Login Screen
 * 
 * User authentication screen with email and password inputs.
 * 
 * SPEC COMPLIANCE:
 * - A4: Touch targets minimum 44px
 * - C3: No gradients on buttons
 * - A2: Focus states visible on inputs
 * 
 * @param props - Login screen props
 * @returns React component
 */
export function LoginScreen({
  onLogin,
  onForgotPassword,
  onSignUp,
  isLoading = false,
  error,
}: LoginScreenProps) {
  // ========================================================================
  // State
  // ========================================================================

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // ========================================================================
  // Handlers
  // ========================================================================

  const handleLogin = () => {
    if (!email || !password) {
      return; // Validation handled by parent if needed
    }
    onLogin?.(email, password);
  };

  const handleForgotPassword = () => {
    onForgotPassword?.();
  };

  const handleSignUp = () => {
    onSignUp?.();
  };

  // ========================================================================
  // Render
  // ========================================================================

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <View style={styles.content}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.appName}>{APP_NAME}</Text>
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

            {/* Password Input */}
            <StyledTextInput
              label={LABELS.password}
              value={password}
              onChangeText={setPassword}
              placeholder={PLACEHOLDERS.password}
              secureTextEntry
              autoComplete="password"
              style={styles.passwordInput}
            />

            {/* Forgot Password Link */}
            <TouchableOpacity
              onPress={handleForgotPassword}
              style={styles.forgotButton}
            >
              <Text style={styles.forgotText}>{BUTTON_LABELS.forgotPassword}</Text>
            </TouchableOpacity>

            {/* Sign In Button */}
            <View style={styles.submitButtonContainer}>
              <PrimaryActionButton
                label={BUTTON_LABELS.signIn}
                onPress={handleLogin}
                disabled={isLoading || !email || !password}
              />
            </View>
          </GlassCard>

          {/* Sign Up Link */}
          <View style={styles.signupContainer}>
            <Text style={styles.signupText}>{LINK_TEXT.noAccount} </Text>
            <TouchableOpacity onPress={handleSignUp}>
              <Text style={styles.signupLink}>{LINK_TEXT.signUp}</Text>
            </TouchableOpacity>
          </View>
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
  // Header
  // ========================================================================

  header: {
    alignItems: 'center',
    marginBottom: spacing.section * 2,
  },

  appName: {
    fontSize: 36,
    fontWeight: '700',
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
    marginBottom: spacing.card,
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

  passwordInput: {
    marginTop: spacing.card / 2,
  },

  // ========================================================================
  // Forgot Password
  // ========================================================================

  forgotButton: {
    alignSelf: 'flex-end',
    marginTop: spacing.card / 2,
    marginBottom: spacing.card,
    paddingVertical: spacing.card / 2, // A4: Touch target padding
    paddingHorizontal: spacing.card / 2,
  },

  forgotText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
  },

  // ========================================================================
  // Submit Button
  // ========================================================================

  submitButtonContainer: {
    marginTop: spacing.card,
  },

  // ========================================================================
  // Sign Up Link
  // ========================================================================

  signupContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: spacing.section * 2,
  },

  signupText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
  },

  signupLink: {
    fontSize: typography.body.fontSize,
    fontWeight: '600',
    color: colors.textPrimary,
  },
});
