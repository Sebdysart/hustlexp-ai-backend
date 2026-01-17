/**
 * PrimaryActionButton Component
 * 
 * MAX-tier neutral action button.
 * No icon slot. No variants. Keep it boring.
 */

import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { colors } from './colors';

type PrimaryActionButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
};

export function PrimaryActionButton({
  label,
  onPress,
  disabled = false,
}: PrimaryActionButtonProps) {
  return (
    <TouchableOpacity
      style={[styles.button, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.9}
    >
      <Text style={styles.label}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    width: '100%',
    height: 52,
    backgroundColor: colors.primaryAction,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: colors.primaryAction,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 8,
  },
  disabled: {
    opacity: 0.5,
  },
  label: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
  },
});
