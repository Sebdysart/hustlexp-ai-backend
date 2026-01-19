/**
 * TaskFeedScreen - v1
 * 
 * Main task feed screen with Instant interrupt integration.
 * 
 * Notification Urgency Design v1:
 * - Shows InstantInterruptCard when notification received
 * - Shows PinnedInstantCard for dismissed instant tasks
 * - Regular task feed below
 */

import React from 'react';
import {
  View,
  FlatList,
  StyleSheet,
  Text,
} from 'react-native';
import { InstantInterruptCard } from '../components/InstantInterruptCard';
import { PinnedInstantCard } from '../components/PinnedInstantCard';
import { useInstantNotifications } from '../hooks/useInstantNotifications';
import { trpc } from '../utils/trpc';

export const TaskFeedScreen: React.FC = () => {
  const {
    currentInterrupt,
    dismissedTaskIds,
    dismissInterrupt,
    acceptInterrupt,
  } = useInstantNotifications();

  // Fetch available instant tasks (for pinned cards)
  const { data: instantTasks } = trpc.instant.listAvailable.useQuery();

  // Filter out dismissed tasks
  const pinnedTasks = instantTasks?.filter(
    (task) => dismissedTaskIds.has(task.id)
  ) || [];

  // Handle interrupt accept
  const handleInterruptAccept = () => {
    acceptInterrupt();
    // Navigate to task detail or show success state
    // This is handled by your navigation system
  };

  // Handle interrupt dismiss
  const handleInterruptDismiss = () => {
    dismissInterrupt();
  };

  // Render task feed item (placeholder)
  const renderTaskItem = ({ item }: any) => (
    <View style={styles.taskItem}>
      <Text style={styles.taskTitle}>{item.title}</Text>
      <Text style={styles.taskPrice}>${(item.price / 100).toFixed(2)}</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      {/* Instant Interrupt Card (Modal) */}
      {currentInterrupt && (
        <InstantInterruptCard
          taskId={currentInterrupt.taskId}
          title={currentInterrupt.title}
          price={currentInterrupt.price}
          location={currentInterrupt.location}
          onAccept={handleInterruptAccept}
          onDismiss={handleInterruptDismiss}
        />
      )}

      {/* Task Feed */}
      <FlatList
        data={[]} // Replace with your actual task data
        renderItem={renderTaskItem}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={
          <>
            {/* Pinned Instant Cards (for dismissed tasks) */}
            {pinnedTasks.map((task) => (
              <PinnedInstantCard
                key={task.id}
                taskId={task.id}
                title={task.title}
                price={task.price}
                location={task.location || undefined}
                onAccept={handleInterruptAccept}
              />
            ))}
          </>
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No tasks available</Text>
          </View>
        }
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  taskItem: {
    backgroundColor: '#FFFFFF',
    padding: 16,
    marginHorizontal: 16,
    marginVertical: 8,
    borderRadius: 12,
  },
  taskTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  taskPrice: {
    fontSize: 18,
    fontWeight: '700',
    color: '#34C759',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyText: {
    fontSize: 16,
    color: '#666666',
  },
});
