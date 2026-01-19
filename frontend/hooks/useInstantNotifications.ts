/**
 * useInstantNotifications - v1
 * 
 * Hook to listen for instant task notifications and manage interrupt state.
 * 
 * Notification Urgency Design v1:
 * - Listens for instant_task_available notifications
 * - Manages one-interrupt-at-a-time state
 * - Tracks dismissed tasks to prevent re-showing
 */

import { useEffect, useState, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { trpc } from '../utils/trpc';

interface InstantNotification {
  id: string;
  taskId: string;
  title: string;
  price: number;
  location?: string;
  metadata?: {
    instantMode?: boolean;
    riskLevel?: string;
    sensitive?: boolean;
  };
}

interface UseInstantNotificationsResult {
  currentInterrupt: InstantNotification | null;
  dismissedTaskIds: Set<string>;
  showInterrupt: (notification: InstantNotification) => void;
  dismissInterrupt: () => void;
  acceptInterrupt: () => void;
}

export const useInstantNotifications = (): UseInstantNotificationsResult => {
  const [currentInterrupt, setCurrentInterrupt] = useState<InstantNotification | null>(null);
  const [dismissedTaskIds, setDismissedTaskIds] = useState<Set<string>>(new Set());
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);

  // Listen for app state changes (foreground/background)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      setAppState(nextAppState);
    });
    return () => subscription.remove();
  }, []);

  // Poll for instant notifications (when app is foregrounded)
  // In production, this would use push notifications or WebSocket
  const { data: notifications } = trpc.notification.getList.useQuery(
    {
      unreadOnly: true,
      limit: 10,
    },
    {
      enabled: appState === 'active', // Only poll when app is active
      refetchInterval: 5000, // Poll every 5 seconds
    }
  );

  // Process notifications and show interrupt if eligible
  useEffect(() => {
    if (!notifications || appState !== 'active') return;

    // Find instant_task_available notifications
    const instantNotifications = notifications.filter(
      (n: any) => n.category === 'instant_task_available' && !dismissedTaskIds.has(n.taskId)
    );

    if (instantNotifications.length === 0) return;

    // ONE-INTERRUPT-AT-A-TIME: Only show the most recent
    const latestNotification = instantNotifications[0]; // Already sorted by created_at DESC

    // Only show if no current interrupt
    if (!currentInterrupt) {
      const notification: InstantNotification = {
        id: latestNotification.id,
        taskId: latestNotification.taskId,
        title: latestNotification.title,
        price: parseInt(latestNotification.metadata?.price || '0', 10),
        location: latestNotification.metadata?.location,
        metadata: latestNotification.metadata,
      };
      setCurrentInterrupt(notification);
    }
  }, [notifications, dismissedTaskIds, currentInterrupt, appState]);

  const showInterrupt = useCallback((notification: InstantNotification) => {
    // Only show if not dismissed
    if (!dismissedTaskIds.has(notification.taskId)) {
      setCurrentInterrupt(notification);
    }
  }, [dismissedTaskIds]);

  const dismissInterrupt = useCallback(() => {
    if (currentInterrupt) {
      // Mark as dismissed
      setDismissedTaskIds((prev) => new Set([...prev, currentInterrupt.taskId]));
      setCurrentInterrupt(null);
    }
  }, [currentInterrupt]);

  const acceptInterrupt = useCallback(() => {
    // Clear interrupt on accept (success handled by parent)
    setCurrentInterrupt(null);
  }, []);

  return {
    currentInterrupt,
    dismissedTaskIds,
    showInterrupt,
    dismissInterrupt,
    acceptInterrupt,
  };
};
