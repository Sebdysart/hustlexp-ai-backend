/**
 * InstantInterruptCard - v1
 * 
 * Full-width interrupt card for Instant Execution Mode tasks.
 * Blocks interaction with underlying UI until Accept or Dismiss.
 * 
 * Notification Urgency Design v1:
 * - Appears immediately when instant notification received
 * - One-tap Accept / Dismiss
 * - "First to accept" urgency label
 * - No task details, no scrolling
 */

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Dimensions,
} from 'react-native';
import { trpc } from '../utils/trpc';

interface InstantInterruptCardProps {
  taskId: string;
  title: string;
  price: number; // in cents
  location?: string;
  onAccept: () => void;
  onDismiss: () => void;
}

const { width } = Dimensions.get('window');

export const InstantInterruptCard: React.FC<InstantInterruptCardProps> = ({
  taskId,
  title,
  price,
  location,
  onAccept,
  onDismiss,
}) => {
  const [isAccepting, setIsAccepting] = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);
  const [renderTimestamp] = useState(Date.now());

  const acceptMutation = trpc.instant.accept.useMutation();
  const dismissMutation = trpc.instant.dismiss.useMutation();

  // Log render timestamp (dev-only metric)
  useEffect(() => {
    console.log(`[InstantInterrupt] Rendered at ${renderTimestamp}ms for task ${taskId}`);
  }, [taskId, renderTimestamp]);

  const handleAccept = async () => {
    const acceptTimestamp = Date.now();
    const latency = acceptTimestamp - renderTimestamp;
    console.log(`[InstantInterrupt] Accept tapped at ${acceptTimestamp}ms (latency: ${latency}ms)`);

    setIsAccepting(true);
    try {
      const result = await acceptMutation.mutateAsync({ taskId });
      
      // Log accept latency (dev-only metric)
      console.log(`[InstantInterrupt] Accept completed, time-to-accept: ${result.timeToAcceptSeconds}s`);
      
      onAccept();
    } catch (error: any) {
      // Task already accepted by someone else
      if (error?.data?.code === 'BAD_REQUEST' || error?.message?.includes('already accepted')) {
        console.log(`[InstantInterrupt] Task ${taskId} already taken`);
        onDismiss(); // Dismiss card, show "Task taken" state handled by parent
      } else {
        console.error(`[InstantInterrupt] Accept failed:`, error);
        // Keep card visible on error (user can retry or dismiss)
        setIsAccepting(false);
      }
    }
  };

  const handleDismiss = async () => {
    const dismissTimestamp = Date.now();
    const latency = dismissTimestamp - renderTimestamp;
    console.log(`[InstantInterrupt] Dismiss tapped at ${dismissTimestamp}ms (latency: ${latency}ms)`);

    setIsDismissing(true);
    try {
      await dismissMutation.mutateAsync({ taskId });
      onDismiss();
    } catch (error) {
      console.error(`[InstantInterrupt] Dismiss failed:`, error);
      // Still dismiss locally even if API call fails
      onDismiss();
    }
  };

  const priceDollars = (price / 100).toFixed(2);

  return (
    <Modal
      visible={true}
      transparent={false}
      animationType="slide"
      onRequestClose={handleDismiss} // Android back button
    >
      <View style={styles.container}>
        <View style={styles.card}>
          {/* Urgency Label */}
          <View style={styles.urgencyBadge}>
            <Text style={styles.urgencyText}>FIRST TO ACCEPT</Text>
          </View>

          {/* Task Title */}
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>

          {/* Price */}
          <Text style={styles.price}>${priceDollars}</Text>

          {/* Location (optional) */}
          {location && (
            <Text style={styles.location} numberOfLines={1}>
              📍 {location}
            </Text>
          )}

          {/* Actions */}
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.button, styles.acceptButton]}
              onPress={handleAccept}
              disabled={isAccepting || isDismissing}
            >
              <Text style={styles.acceptButtonText}>
                {isAccepting ? 'Accepting...' : 'Accept'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, styles.dismissButton]}
              onPress={handleDismiss}
              disabled={isAccepting || isDismissing}
            >
              <Text style={styles.dismissButtonText}>
                {isDismissing ? 'Dismissing...' : 'Dismiss'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)', // Semi-transparent overlay
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    width: width - 32, // Full width minus padding
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8, // Android shadow
  },
  urgencyBadge: {
    backgroundColor: '#FF3B30', // Red for urgency
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    marginBottom: 16,
  },
  urgencyText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 8,
    textAlign: 'center',
  },
  price: {
    fontSize: 32,
    fontWeight: '700',
    color: '#34C759', // Green for money
    marginBottom: 8,
  },
  location: {
    fontSize: 14,
    color: '#666666',
    marginBottom: 24,
  },
  actions: {
    width: '100%',
    gap: 12,
  },
  button: {
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
  },
  acceptButton: {
    backgroundColor: '#34C759', // Green
  },
  acceptButtonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  dismissButton: {
    backgroundColor: '#F2F2F7', // Light gray
  },
  dismissButtonText: {
    color: '#666666',
    fontSize: 16,
    fontWeight: '600',
  },
});
