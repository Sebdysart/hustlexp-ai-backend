/**
 * Instant Interrupt Card (Hustler View)
 * 
 * Full-width modal interrupt for Instant Execution Mode tasks.
 * MAX-tier UI: Authority, urgency, one-tap accept.
 * 
 * LOCKED: Spec matches 01-instant-interrupt-card-LOCKED.md
 */

import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { MaterialIcons } from '@expo/vector-icons';

interface InstantInterruptCardProps {
  visible: boolean;
  taskTitle: string;
  taskLocation: string;
  taskPay: string;
  countdown: string; // Format: "00:45"
  xpMultiplier: number; // e.g., 1.8
  trustTierRequired: number; // e.g., 2
  onAccept: () => void;
  onDismiss: () => void;
}

export default function InstantInterruptCard({
  visible,
  taskTitle,
  taskLocation,
  taskPay,
  countdown,
  xpMultiplier,
  trustTierRequired,
  onAccept,
  onDismiss,
}: InstantInterruptCardProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
    >
      <View style={styles.container}>
        {/* Backdrop Blur */}
        <BlurView intensity={12} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={styles.backdropOverlay} />

        {/* Content */}
        <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
          <View style={styles.card}>
            {/* Top Gradient Border */}
            <View style={styles.topBorder} />

            <View style={styles.content}>
              {/* Header Section */}
              <View style={styles.header}>
                {/* Instant Task Label */}
                <View style={styles.instantLabelRow}>
                  <MaterialIcons
                    name="bolt"
                    size={16}
                    color="#FF3B30"
                    style={styles.boltIcon}
                  />
                  <Text style={styles.instantLabel}>INSTANT TASK</Text>
                </View>

                {/* Eligibility */}
                <Text style={styles.eligibilityText}>
                  You are eligible for this task
                </Text>

                {/* Timer - De-emphasized (#F2F2F7, 90% opacity) */}
                <Text style={styles.timer}>{countdown}</Text>

                {/* Scarcity & Trust */}
                <Text style={styles.scarcityText}>
                  Limited to trusted hustlers nearby
                </Text>

                {/* XP Badge */}
                <View style={styles.xpBadge}>
                  <Text style={styles.xpBadgeText}>+{xpMultiplier}× XP</Text>
                </View>
              </View>

              {/* Divider */}
              <View style={styles.divider} />

              {/* Spacing between XP pill and task title (12px extra = 28px total) */}
              <View style={styles.spacer} />

              {/* Task Preview Section */}
              <View style={styles.taskPreview}>
                {/* Title */}
                <Text style={styles.taskTitle} numberOfLines={2}>
                  {taskTitle}
                </Text>

                {/* Location */}
                <View style={styles.locationRow}>
                  <MaterialIcons
                    name="location-on"
                    size={18}
                    color="#8E8E93"
                  />
                  <Text style={styles.locationText}>{taskLocation}</Text>
                </View>

                {/* Pay Amount */}
                <Text style={styles.payAmount}>{taskPay}</Text>

                {/* Safety/Trust Line */}
                <View style={styles.trustRow}>
                  <View style={styles.trustItem}>
                    <MaterialIcons
                      name="verified-user"
                      size={14}
                      color="#8E8E93"
                    />
                    <Text style={styles.trustText}>
                      Tier {trustTierRequired}+ required
                    </Text>
                  </View>
                  <View style={styles.trustDot} />
                  <Text style={styles.trustText}>Escrow protected</Text>
                  <View style={styles.trustDot} />
                  <Text style={styles.trustText}>Verified poster</Text>
                </View>
              </View>

              {/* Action Area */}
              <View style={styles.actions}>
                {/* Primary Button */}
                <TouchableOpacity
                  style={styles.acceptButton}
                  onPress={onAccept}
                  activeOpacity={0.9}
                >
                  <Text style={styles.acceptButtonText}>ACCEPT & GO</Text>
                </TouchableOpacity>

                {/* Skip Button - Subordinate (13px font, 85% opacity) */}
                <TouchableOpacity
                  onPress={onDismiss}
                  style={styles.skipButton}
                  activeOpacity={0.7}
                >
                  <Text style={styles.skipButtonText}>Skip this task</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  backdropOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  safeArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 24,
    backgroundColor: 'rgba(28, 28, 30, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 32,
    elevation: 8,
  },
  topBorder: {
    height: 4,
    backgroundColor: '#FF3B30',
    ...(Platform.OS === 'ios' && {
      background: 'linear-gradient(to right, #FF3B30, #FF9500)',
    }),
  },
  content: {
    padding: 24,
    paddingTop: 32,
    alignItems: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 24,
    width: '100%',
  },
  instantLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  boltIcon: {
    marginRight: 2,
  },
  instantLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2,
    color: '#FF3B30',
    textTransform: 'uppercase',
  },
  eligibilityText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#8E8E93',
    marginBottom: 8,
  },
  timer: {
    fontSize: 36,
    fontWeight: '800',
    letterSpacing: -1,
    color: '#F2F2F7',
    opacity: 0.9,
    fontVariant: ['tabular-nums'],
    marginBottom: 4,
  },
  scarcityText: {
    fontSize: 13,
    color: '#8E8E93',
    marginBottom: 12,
  },
  xpBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 9999,
    backgroundColor: 'rgba(255, 149, 0, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255, 149, 0, 0.2)',
  },
  xpBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: '#FF9500',
  },
  divider: {
    width: '100%',
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    marginBottom: 24,
  },
  spacer: {
    height: 12, // Extra spacing between XP pill and task title
  },
  taskPreview: {
    alignItems: 'center',
    width: '100%',
    marginBottom: 32,
  },
  taskTitle: {
    fontSize: 24,
    fontWeight: '700',
    lineHeight: 28.8,
    letterSpacing: -0.5,
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: 12,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 20,
  },
  locationText: {
    fontSize: 16,
    color: '#8E8E93',
  },
  payAmount: {
    fontSize: 42,
    fontWeight: '800',
    letterSpacing: -2,
    color: '#34C759',
    marginBottom: 12,
  },
  trustRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  trustItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  trustText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#8E8E93',
    opacity: 0.8,
  },
  trustDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(142, 142, 147, 0.4)',
  },
  actions: {
    width: '100%',
    gap: 16,
  },
  acceptButton: {
    width: '100%',
    height: 60,
    backgroundColor: '#34C759',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#34C759',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 8,
  },
  acceptButtonText: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: '#FFFFFF',
  },
  skipButton: {
    paddingVertical: 8,
    alignItems: 'center',
  },
  skipButtonText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#8E8E93',
    opacity: 0.85,
  },
});
