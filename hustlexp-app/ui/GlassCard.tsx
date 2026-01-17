/**
 * GlassCard Component
 * 
 * MAX-tier glassmorphic container.
 * Primary and secondary variants only. No speculative props.
 */

import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { colors } from './colors';

type GlassCardProps = {
  variant?: 'primary' | 'secondary';
  children: React.ReactNode;
  style?: ViewStyle;
};

export function GlassCard({
  variant = 'primary',
  children,
  style,
}: GlassCardProps) {
  return (
    <View
      style={[
        variant === 'primary' ? styles.primary : styles.secondary,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  primary: {
    backgroundColor: colors.glassPrimary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 16,
    padding: 20,
  },
  secondary: {
    backgroundColor: colors.glassSecondary,
    borderWidth: 1,
    borderColor: colors.glassBorderSecondary,
    borderRadius: 12,
    padding: 16,
  },
});
