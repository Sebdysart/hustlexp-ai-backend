/**
 * Signup Screen (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: AUTH_SIGNUP
 * Spec Authority: Standard authentication flow + BUILD_GUIDE requirements
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
 *    - BUILD_GUIDE: user_type (hustler/client), email, full_name required
 * 
 * 2. UI-ONLY: NO authentication logic.
 *    - Collects signup data only
 *    - Callback when signup attempted
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
 * User type for signup.
 * 
 * 'hustler' = Worker/earner role
 * 'client' = Poster/task creator role
 */
export type UserType = 'hustler' | 'client';

/**
 * Signup Screen Props
 * 
 * Props for signup screen navigation and callbacks.
 */
export interface SignupScreenProps {
  /** Callback when signup form is submitted */
  onSignup?: (data: {
    fullName: string;
    email: string;
    password: string;
    userType: UserType;
  }) => void;
  
  /** Callback when login link is pressed */
  onLogin?: () => void;
  
  /** Whether signup is in progress */
  isLoading?: boolean;
  
  /** Error message to display */
  error?: string | null;
}

// ============================================================================
// CONSTANTS (MAX-TIER: No Magic Values)
// ============================================================================

/**
 * Header text.
 */
const HEADER_TEXT = 'Create Account';

/**
 * Subtitle text.
 */
const SUBTITLE_TEXT = 'Join the hustle';

/**
 * Form labels.
 */
const LABELS = {
  fullName: 'Full Name',
  email: 'Email',
  password: 'Password',
  confirmPassword: 'Confirm Password',
  userType: 'I want to:',
} as const;

/**
 * Placeholders.
 */
const PLACEHOLDERS = {
  fullName: 'Your full name',
  email: 'your@email.com',
  password: 'Min 8 characters',
  confirmPassword: 'Re-enter password',
} as const;

/**
 * User type options.
 */
const USER_TYPE_OPTIONS: Array<{ value: UserType; label: string }> = [
  { value: 'hustler', label: 'Earn (Hustler)' },
  { value: 'client', label: 'Post Tasks (Client)' },
] as const;

/**
 * Button labels.
 */
const BUTTON_LABELS = {
  createAccount: 'Create Account',
} as const;

/**
 * Link text.
 */
const LINK_TEXT = {
  hasAccount: 'Already have an account?',
  signIn: 'Sign In',
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
  autoCapitalize = 'sentences',
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
 * Signup Screen
 * 
 * User registration screen with full name, email, password, and user type selection.
 * 
 * SPEC COMPLIANCE:
 * - A4: Touch targets minimum 44px
 * - C3: No gradients on buttons
 * - BUILD_GUIDE: user_type, email, full_name required
 * 
 * @param props - Signup screen props
 * @returns React component
 */
export function SignupScreen({
  onSignup,
  onLogin,
  isLoading = false,
  error,
}: SignupScreenProps) {
  // ========================================================================
  // State
  // ========================================================================

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [userType, setUserType] = useState<UserType>('hustler');

  // ========================================================================
  // Handlers
  // ========================================================================

  const handleSignup = () => {
    if (!fullName || !email || !password || !confirmPassword) {
      return; // Validation handled by parent if needed
    }
    onSignup?.({
      fullName,
      email,
      password,
      userType,
    });
  };

  const handleLogin = () => {
    onLogin?.();
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
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>{HEADER_TEXT}</Text>
            <Text style={styles.subtitle}>{SUBTITLE_TEXT}</Text>
          </View>

          {/* User Type Selection */}
          <View style={styles.typeContainer}>
            <Text style={styles.typeLabel}>{LABELS.userType}</Text>
            <View style={styles.typeButtons}>
              {USER_TYPE_OPTIONS.map((option) => {
                const isSelected = userType === option.value;
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[
                      styles.typeButton,
                      isSelected && styles.typeButtonActive,
                    ]}
                    onPress={() => setUserType(option.value)}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.typeButtonText,
                        isSelected && styles.typeButtonTextActive,
                      ]}
                    >
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Form */}
          <GlassCard style={styles.formCard}>
            {/* Error Message */}
            {error && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {/* Full Name Input */}
            <StyledTextInput
              label={LABELS.fullName}
              value={fullName}
              onChangeText={setFullName}
              placeholder={PLACEHOLDERS.fullName}
              autoCapitalize="words"
              autoComplete="name"
            />

            {/* Email Input */}
            <StyledTextInput
              label={LABELS.email}
              value={email}
              onChangeText={setEmail}
              placeholder={PLACEHOLDERS.email}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              style={styles.inputSpacing}
            />

            {/* Password Input */}
            <StyledTextInput
              label={LABELS.password}
              value={password}
              onChangeText={setPassword}
              placeholder={PLACEHOLDERS.password}
              secureTextEntry
              autoComplete="new-password"
              style={styles.inputSpacing}
            />

            {/* Confirm Password Input */}
            <StyledTextInput
              label={LABELS.confirmPassword}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder={PLACEHOLDERS.confirmPassword}
              secureTextEntry
              autoComplete="new-password"
              style={styles.inputSpacing}
            />

            {/* Create Account Button */}
            <View style={styles.submitButtonContainer}>
              <PrimaryActionButton
                label={BUTTON_LABELS.createAccount}
                onPress={handleSignup}
                disabled={
                  isLoading ||
                  !fullName ||
                  !email ||
                  !password ||
                  !confirmPassword
                }
              />
            </View>
          </GlassCard>

          {/* Login Link */}
          <View style={styles.loginContainer}>
            <Text style={styles.loginText}>{LINK_TEXT.hasAccount} </Text>
            <TouchableOpacity onPress={handleLogin}>
              <Text style={styles.loginLink}>{LINK_TEXT.signIn}</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
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

  scrollContent: {
    flexGrow: 1,
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
  // User Type Selection
  // ========================================================================

  typeContainer: {
    marginBottom: spacing.card,
  },

  typeLabel: {
    fontSize: typography.body.fontSize,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.card / 2,
  },

  typeButtons: {
    flexDirection: 'row',
    gap: spacing.card / 2,
  },

  typeButton: {
    flex: 1,
    paddingVertical: spacing.card,
    paddingHorizontal: spacing.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    backgroundColor: colors.glassSecondary,
    alignItems: 'center',
    minHeight: MIN_TOUCH_TARGET_HEIGHT, // A4: ≥44px
    justifyContent: 'center',
  },

  typeButtonActive: {
    borderColor: colors.textPrimary,
    borderWidth: 2,
    backgroundColor: colors.glassPrimary,
  },

  typeButtonText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
    textAlign: 'center',
  },

  typeButtonTextActive: {
    color: colors.textPrimary,
    fontWeight: '600',
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

  inputSpacing: {
    marginTop: spacing.card / 2,
  },

  // ========================================================================
  // Submit Button
  // ========================================================================

  submitButtonContainer: {
    marginTop: spacing.section,
  },

  // ========================================================================
  // Login Link
  // ========================================================================

  loginContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: spacing.section * 2,
  },

  loginText: {
    fontSize: typography.body.fontSize,
    color: colors.muted,
  },

  loginLink: {
    fontSize: typography.body.fontSize,
    fontWeight: '600',
    color: colors.textPrimary,
  },
});
