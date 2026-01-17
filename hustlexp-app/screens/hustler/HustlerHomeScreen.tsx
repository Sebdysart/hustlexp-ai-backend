/**
 * Hustler Home Screen (MAX Tier Dashboard)
 * 
 * First screen hustlers see. Sets tone for entire app.
 * MAX-tier UI: Authority, trust visibility, earnings prominence.
 * 
 * LOCKED: Spec matches 02-hustler-home-LOCKED.md
 */

import React from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';

interface HustlerHomeScreenProps {
  currentXP?: number;
  level?: number;
  trustTier?: string;
  streakDays?: number;
  todayEarnings?: string;
  todayTasks?: number;
  instantMode?: boolean;
  onToggleInstantMode?: () => void;
}

export default function HustlerHomeScreen({
  currentXP = 2847,
  level = 12,
  trustTier = 'Trusted Tier',
  streakDays = 7,
  todayEarnings = '$142.00',
  todayTasks = 3,
  instantMode = true,
  onToggleInstantMode,
}: HustlerHomeScreenProps) {
  // Calculate XP ring progress (75% for example)
  const progress = 0.75;
  const radius = 45;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Top App Bar */}
        <View style={styles.header}>
          <View style={styles.userRow}>
            <View style={styles.avatarContainer}>
              <View style={styles.avatar} />
              <View style={styles.onlineIndicator} />
            </View>
            <View style={styles.userInfo}>
              <Text style={styles.welcomeText}>WELCOME BACK</Text>
              <Text style={styles.username}>Alex_Hustles</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.notificationButton}>
            <MaterialIcons name="notifications" size={20} color="#FFFFFF" />
            <View style={styles.notificationDot} />
          </TouchableOpacity>
        </View>

        {/* Status Header Widget */}
        <View style={styles.statusCard}>
          <View style={styles.xpRingContainer}>
            <Svg width="96" height="96" style={styles.xpRing}>
              {/* Track */}
              <Circle
                cx="48"
                cy="48"
                r={radius}
                fill="none"
                stroke="#2a2a2c"
                strokeWidth="8"
              />
              {/* Progress */}
              <Circle
                cx="48"
                cy="48"
                r={radius}
                fill="none"
                stroke="#1fad7e"
                strokeWidth="8"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                transform="rotate(-90 48 48)"
              />
            </Svg>
            <View style={styles.xpRingContent}>
              <Text style={styles.levelLabel}>Level</Text>
              <Text style={styles.levelNumber}>{level}</Text>
            </View>
          </View>

          <View style={styles.statsColumn}>
            {/* Trust Tier Badge */}
            <View style={styles.tierBadge}>
              <MaterialIcons name="verified-user" size={16} color="#1fad7e" />
              <Text style={styles.tierBadgeText}>Trusted Tier</Text>
            </View>

            {/* Streak */}
            <View style={styles.streakRow}>
              <MaterialIcons name="local-fire-department" size={20} color="#FF9500" />
              <Text style={styles.streakText}>{streakDays}-day streak</Text>
            </View>

            {/* Streak Progress Bar */}
            <View style={styles.streakProgress}>
              <View style={[styles.streakProgressFill, { width: '100%' }]} />
            </View>
          </View>
        </View>

        {/* Today Snapshot */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Today's Snapshot</Text>
          <View style={styles.earningsCard}>
            <View style={styles.earningsHeader}>
              <View>
                <Text style={styles.earningsLabel}>Total Earnings</Text>
                <Text style={styles.earningsAmount}>
                  {todayEarnings.split('.')[0]}
                  <Text style={styles.earningsDecimal}>.{todayEarnings.split('.')[1]}</Text>
                </Text>
              </View>
              <View style={styles.earningsIcon}>
                <MaterialIcons name="payments" size={24} color="#1fad7e" />
              </View>
            </View>
            <View style={styles.divider} />
            <View style={styles.earningsFooter}>
              <View style={styles.earningsStat}>
                <MaterialIcons name="bolt" size={18} color="#1fad7e" />
                <Text style={styles.earningsStatText}>+450 XP Gained</Text>
              </View>
              <View style={styles.earningsStat}>
                <MaterialIcons name="check-circle" size={18} color="#8E8E93" />
                <Text style={styles.earningsStatText}>{todayTasks} Tasks Done</Text>
              </View>
            </View>
          </View>
        </View>

        {/* Instant Mode */}
        <View style={styles.section}>
          <TouchableOpacity
            style={[
              styles.instantModeCard,
              instantMode && styles.instantModeActive,
            ]}
            onPress={onToggleInstantMode}
            activeOpacity={0.8}
          >
            <View style={styles.instantModeContent}>
              <View style={styles.instantModeIcon}>
                <MaterialIcons name="broadcast-on-personal" size={28} color="#1fad7e" />
              </View>
              <View style={styles.instantModeText}>
                <View style={styles.instantModeTitleRow}>
                  <Text style={styles.instantModeTitle}>
                    Instant Mode: {instantMode ? 'ON' : 'OFF'}
                  </Text>
                  {instantMode && <View style={styles.instantModeIndicator} />}
                </View>
                <Text style={styles.instantModeSubtitle}>
                  High-priority tasks active
                </Text>
              </View>
            </View>
            <View style={[styles.toggle, instantMode && styles.toggleActive]} />
          </TouchableOpacity>
        </View>

        {/* Progression Preview */}
        <View style={styles.section}>
          <View style={styles.progressionHeader}>
            <Text style={styles.sectionTitle}>Career Progression</Text>
            <TouchableOpacity>
              <Text style={styles.viewRoadmap}>View Roadmap</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.progressionCard}>
            <View style={styles.progressionCardHeader}>
              <View>
                <Text style={styles.progressionLabel}>Current Goal</Text>
                <Text style={styles.progressionGoal}>In-Home Cleared</Text>
              </View>
              <MaterialIcons name="lock-open" size={24} color="#8E8E93" />
            </View>

            <View style={styles.progressionRequirements}>
              <View style={styles.progressionRequirement}>
                <View style={styles.progressionRequirementHeader}>
                  <Text style={styles.progressionRequirementLabel}>Tasks Completed</Text>
                  <Text style={styles.progressionRequirementValue}>18/25</Text>
                </View>
                <View style={styles.progressionBar}>
                  <View style={[styles.progressionBarFill, { width: '72%' }]} />
                </View>
              </View>

              <View style={styles.progressionRequirement}>
                <View style={styles.progressionRequirementHeader}>
                  <Text style={styles.progressionRequirementLabel}>Days Active</Text>
                  <Text style={styles.progressionRequirementValue}>22/30</Text>
                </View>
                <View style={styles.progressionBar}>
                  <View style={[styles.progressionBarFill, { width: '73%' }]} />
                </View>
              </View>
            </View>
          </View>

          {/* Locked Next Tier */}
          <View style={[styles.progressionCard, styles.progressionCardLocked]}>
            <View style={styles.progressionCardHeader}>
              <View>
                <Text style={styles.progressionLabel}>Next Tier</Text>
                <Text style={styles.progressionGoal}>Commercial Licensed</Text>
              </View>
              <MaterialIcons name="lock" size={24} color="#8E8E93" />
            </View>
          </View>
        </View>

        {/* Bottom Spacer for Navigation */}
        <View style={styles.bottomSpacer} />
      </ScrollView>

      {/* Bottom Navigation */}
      <View style={styles.bottomNav}>
        <TouchableOpacity style={styles.navItem}>
          <MaterialIcons name="home" size={24} color="#1fad7e" />
          <Text style={[styles.navLabel, styles.navLabelActive]}>Home</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem}>
          <MaterialIcons name="assignment" size={24} color="#8E8E93" />
          <Text style={styles.navLabel}>Tasks</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navFab}>
          <MaterialIcons name="add" size={28} color="#000000" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem}>
          <MaterialIcons name="account-balance-wallet" size={24} color="#8E8E93" />
          <Text style={styles.navLabel}>Wallet</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem}>
          <MaterialIcons name="person" size={24} color="#8E8E93" />
          <Text style={styles.navLabel}>Profile</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  scrollView: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 32,
    paddingBottom: 120,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatarContainer: {
    position: 'relative',
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  onlineIndicator: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#1fad7e',
    borderWidth: 2,
    borderColor: '#000000',
  },
  userInfo: {
    gap: 2,
  },
  welcomeText: {
    fontSize: 10,
    fontWeight: '500',
    letterSpacing: 1,
    color: 'rgba(255, 255, 255, 0.7)',
  },
  username: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: '#FFFFFF',
  },
  notificationButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(28, 28, 30, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  notificationDot: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FF3B30',
  },
  statusCard: {
    backgroundColor: 'rgba(28, 28, 30, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 16,
    padding: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
    marginBottom: 24,
  },
  xpRingContainer: {
    width: 96,
    height: 96,
    position: 'relative',
  },
  xpRing: {
    position: 'absolute',
  },
  xpRingContent: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  levelLabel: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
    color: '#8E8E93',
    textTransform: 'uppercase',
  },
  levelNumber: {
    fontSize: 24,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  statsColumn: {
    flex: 1,
    gap: 12,
  },
  tierBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 9999,
    backgroundColor: 'rgba(31, 173, 126, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(31, 173, 126, 0.3)',
  },
  tierBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: '#1fad7e',
    textTransform: 'uppercase',
  },
  streakRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 4,
  },
  streakText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  streakProgress: {
    width: 96,
    height: 4,
    backgroundColor: '#1C1C1E',
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: 4,
  },
  streakProgressFill: {
    height: '100%',
    backgroundColor: '#FF9500',
    borderRadius: 2,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1.5,
    color: '#8E8E93',
    textTransform: 'uppercase',
    marginBottom: 12,
    paddingLeft: 4,
  },
  earningsCard: {
    backgroundColor: 'rgba(28, 28, 30, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 16,
    padding: 24,
    gap: 16,
  },
  earningsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  earningsLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#8E8E93',
    marginBottom: 4,
  },
  earningsAmount: {
    fontSize: 48,
    fontWeight: '800',
    letterSpacing: -1,
    color: '#FFFFFF',
  },
  earningsDecimal: {
    fontSize: 24,
    color: '#8E8E93',
  },
  earningsIcon: {
    backgroundColor: 'rgba(31, 173, 126, 0.1)',
    padding: 8,
    borderRadius: 12,
  },
  divider: {
    width: '100%',
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  earningsFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  earningsStat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  earningsStatText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#E5E5EA',
  },
  instantModeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(28, 28, 30, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 12,
    padding: 4,
    paddingRight: 16,
  },
  instantModeActive: {
    borderColor: 'rgba(31, 173, 126, 0.2)',
  },
  instantModeContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    flex: 1,
  },
  instantModeIcon: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: 'rgba(31, 173, 126, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  instantModeText: {
    gap: 4,
  },
  instantModeTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  instantModeTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1fad7e',
  },
  instantModeIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#1fad7e',
  },
  instantModeSubtitle: {
    fontSize: 12,
    color: '#8E8E93',
    lineHeight: 16,
  },
  toggle: {
    width: 44,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#1C1C1E',
  },
  toggleActive: {
    backgroundColor: '#1fad7e',
  },
  progressionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingLeft: 4,
  },
  viewRoadmap: {
    fontSize: 12,
    fontWeight: '700',
    color: '#1fad7e',
  },
  progressionCard: {
    backgroundColor: 'rgba(28, 28, 30, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderLeftWidth: 4,
    borderLeftColor: '#1fad7e',
    borderRadius: 16,
    padding: 20,
    marginBottom: 12,
  },
  progressionCardLocked: {
    opacity: 0.5,
    borderLeftColor: 'rgba(255, 255, 255, 0.1)',
  },
  progressionCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  progressionLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: '#1fad7e',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  progressionGoal: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  progressionRequirements: {
    gap: 16,
  },
  progressionRequirement: {
    gap: 6,
  },
  progressionRequirementHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  progressionRequirementLabel: {
    fontSize: 12,
    color: '#E5E5EA',
  },
  progressionRequirementValue: {
    fontSize: 12,
    fontWeight: '500',
    color: '#FFFFFF',
  },
  progressionBar: {
    width: '100%',
    height: 8,
    backgroundColor: '#1C1C1E',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressionBarFill: {
    height: '100%',
    backgroundColor: '#1fad7e',
    borderRadius: 4,
  },
  bottomSpacer: {
    height: 24,
  },
  bottomNav: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    backgroundColor: 'rgba(28, 28, 30, 0.9)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
    paddingVertical: 16,
    paddingBottom: 32,
  },
  navItem: {
    alignItems: 'center',
    gap: 4,
  },
  navLabel: {
    fontSize: 10,
    fontWeight: '500',
    color: '#8E8E93',
  },
  navLabelActive: {
    color: '#FFFFFF',
  },
  navFab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#1fad7e',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: -32,
    borderWidth: 4,
    borderColor: '#000000',
    shadowColor: '#1fad7e',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 8,
  },
});
