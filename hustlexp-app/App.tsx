/**
 * HustleXP App Entry Point
 * 
 * Phase C.0 - Mount E1 screen as smoke anchor
 */

import React from 'react';
import { StyleSheet, View, Text, Button, ScrollView } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

// Temporary E1 screen (simplified for smoke anchor)
// Full E1 implementation will be integrated from frontend/screens
function EdgeStateE1NoTasksAvailable() {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>No Tasks Available</Text>
        <Text style={styles.subtitle}>
          No tasks are available right now. New tasks typically appear within 24 hours.
        </Text>
      </View>
      
      <View style={styles.statusCard}>
        <Text style={styles.statusTitle}>Current Settings</Text>
        <Text style={styles.statusItem}>Instant Mode: OFF</Text>
        <Text style={styles.statusItem}>Trust Tier: 0</Text>
      </View>

      <Button
        title="Return to Dashboard"
        onPress={() => {
          // Navigation will be wired later
          console.log('Return to Dashboard pressed');
        }}
      />
    </ScrollView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <EdgeStateE1NoTasksAvailable />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  content: {
    padding: 16,
    paddingTop: 24,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#8E8E93',
    lineHeight: 20,
  },
  statusCard: {
    backgroundColor: 'rgba(28, 28, 30, 0.6)',
    padding: 16,
    borderRadius: 12,
    marginBottom: 24,
  },
  statusTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#8E8E93',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  statusItem: {
    fontSize: 14,
    color: '#FFFFFF',
    marginBottom: 4,
  },
});
