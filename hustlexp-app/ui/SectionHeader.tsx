/**
 * SectionHeader Component
 * 
 * MAX-tier section header typography.
 * Visual law for sectioning. No variants yet.
 */

import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { colors } from './colors';

type SectionHeaderProps = {
  title: string;
};

export function SectionHeader({ title }: SectionHeaderProps) {
  return <Text style={styles.header}>{title}</Text>;
}

const styles = StyleSheet.create({
  header: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: colors.muted,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
});
