/**
 * PinnedInstantCard - v1
 * 
 * Fallback pinned card for dismissed instant tasks.
 * Appears at top of feed with subtle urgency styling.
 * 
 * Notification Urgency Design v1:
 * - Pinned at top of task feed
 * - Subtle urgency border/badge
 * - Accept still available
 * - No interrupt behavior
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { trpc } from '../utils/trpc';

interface PinnedInstantCardProps {
  taskId: string;
  title: string;
  price: number; // in cents
  location?: string;
  onAccept: () => void;
}

export const PinnedInstantCard: React.FC<PinnedInstantCardProps> = ({
  taskId,
  title,
  price,
  location,
  onAccept,
}) => {
  const [isAccepting, setIsAccepting] = useState(false);
  const acceptMutation = trpc.instant.accept.useMutation();

  const handleAccept = async () => {
    setIsAccepting(true);
    try {
      await acceptMutation.mutateAsync({ taskId });
      onAccept();
    } catch (error: any) {
      console.error(`[PinnedInstant] Accept failed:`, error);
      setIsAccepting(false);
    }
  };

  const priceDollars = (price / 100).toFixed(2);

  return (
    <View style={styles.container}>
      {/* Urgency Badge */}
      <View style={styles.urgencyBadge}>
        <Text style={styles.urgencyText}>INSTANT</Text>
      </View>

      {/* Content */}
      <View style={styles.content}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.price}>${priceDollars}</Text>
        {location && (
          <Text style={styles.location} numberOfLines={1}>
            📍 {location}
          </Text>
        )}
      </View>

      {/* Accept Button */}
      <TouchableOpacity
        style={styles.acceptButton}
        onPress={handleAccept}
        disabled={isAccepting}
      >
        <Text style={styles.acceptButtonText}>
          {isAccepting ? 'Accepting...' : 'Accept'}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 8,
    borderWidth: 2,
    borderColor: '#FF3B30', // Red border for urgency
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  urgencyBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#FF3B30',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginBottom: 12,
  },
  urgencyText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  content: {
    marginBottom: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 4,
  },
  price: {
    fontSize: 24,
    fontWeight: '700',
    color: '#34C759',
    marginBottom: 4,
  },
  location: {
    fontSize: 12,
    color: '#666666',
  },
  acceptButton: {
    backgroundColor: '#34C759',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
  },
  acceptButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});
