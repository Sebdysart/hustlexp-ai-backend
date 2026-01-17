/**
 * Screen: 03_PINNED_INSTANT_CARD
 * Spec: HUSTLEXP-DOCS/ui-specs/stitch-prompts/03-pinned-instant-card.md
 * Version: v1
 * Status: NOT LOCKED (but implemented)
 * Components (required): GlassCard, PrimaryActionButton
 * Tokens (required): colors.json, spacing.json, typography.json
 */

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { GlassCard } from '../../ui/GlassCard';
import { PrimaryActionButton } from '../../ui/PrimaryActionButton';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';

interface PinnedInstantCardScreenProps {
  taskTitle: string;
  location: string;
  distance: string;
  payoutAmount: number;
  xpMultiplier: number;
  onAccept?: () => void;
}

export default function PinnedInstantCardScreen({
  taskTitle = 'Move furniture — 2nd floor',
  location = '0.8 mi away',
  distance,
  payoutAmount = 45.0,
  xpMultiplier = 1.8,
  onAccept,
}: PinnedInstantCardScreenProps) {
  const amberColor = '#FF9500';
  const successColor = '#34C759';

  return (
    <View style={styles.container}>
      <GlassCard style={styles.card}>
        {/* Left Amber Border */}
        <View style={styles.leftBorder} />

        {/* Card Header */}
        <View style={styles.header}>
          <View style={styles.instantLabelRow}>
            <MaterialIcons name="bolt" size={14} color={amberColor} />
            <Text style={styles.instantLabel}>INSTANT</Text>
          </View>
          <Text style={styles.availabilityText}>Limited availability</Text>
        </View>

        {/* Task Info */}
        <View style={styles.taskInfo}>
          <Text style={styles.taskTitle}>{taskTitle}</Text>
          <View style={styles.locationRow}>
            <MaterialIcons name="location-on" size={14} color={colors.muted} />
            <Text style={styles.locationText}>
              {distance || location}
            </Text>
          </View>
          <View style={styles.payoutRow}>
            <Text style={styles.payoutAmount}>${payoutAmount.toFixed(2)}</Text>
            <View style={styles.xpBadge}>
              <Text style={styles.xpBadgeText}>+{xpMultiplier}× XP</Text>
            </View>
          </View>
        </View>

        {/* Action Button */}
        <PrimaryActionButton
          label="Accept"
          onPress={onAccept || (() => {})}
        />
      </GlassCard>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.section,
    paddingTop: spacing.section,
  },
  card: {
    position: 'relative',
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 149, 0, 0.3)',
  },
  leftBorder: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: '#FF9500',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  instantLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  instantLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#FF9500',
    textTransform: 'uppercase',
  },
  availabilityText: {
    fontSize: 12,
    color: colors.muted,
  },
  taskInfo: {
    marginBottom: 16,
    gap: 8,
  },
  taskTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  locationText: {
    fontSize: 14,
    color: colors.muted,
  },
  payoutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  payoutAmount: {
    fontSize: 24,
    fontWeight: '800',
    color: '#34C759',
  },
  xpBadge: {
    backgroundColor: 'rgba(255, 149, 0, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(255, 149, 0, 0.3)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  xpBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FF9500',
  },
});
