/**
 * Instant Mode Kill Switch Service
 * 
 * Launch Hardening v1: Feature flags for Instant Mode features.
 * Allows disabling Instant Mode without redeploying.
 * 
 * Flags:
 * - INSTANT_MODE_ENABLED: Master switch for Instant Mode
 * - INSTANT_SURGE_ENABLED: Controls surge escalation
 * - INSTANT_INTERRUPTS_ENABLED: Controls interrupt notifications
 */

import { db } from '../db';
import { logger } from '../logger';

const log = logger.child({ service: 'InstantModeKillSwitch' });

// Default to SAFE (disabled) if env vars not set
const getEnvFlag = (key: string, defaultValue: boolean = false): boolean => {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value === 'true' || value === '1';
};

export const InstantModeKillSwitch = {
  /**
   * Check if Instant Mode is globally enabled
   * Safe default: false (disabled)
   */
  isInstantModeEnabled: (): boolean => {
    return getEnvFlag('INSTANT_MODE_ENABLED', false);
  },

  /**
   * Check if Instant Surge escalation is enabled
   * Safe default: false (disabled)
   */
  isSurgeEnabled: (): boolean => {
    return getEnvFlag('INSTANT_SURGE_ENABLED', false);
  },

  /**
   * Check if Instant interrupt notifications are enabled
   * Safe default: false (disabled)
   */
  areInterruptsEnabled: (): boolean => {
    return getEnvFlag('INSTANT_INTERRUPTS_ENABLED', false);
  },

  /**
   * Check all flags and log if any are disabled
   */
  checkFlags: (context: { taskId?: string; operation: string }): {
    instantModeEnabled: boolean;
    surgeEnabled: boolean;
    interruptsEnabled: boolean;
    allEnabled: boolean;
  } => {
    const instantModeEnabled = InstantModeKillSwitch.isInstantModeEnabled();
    const surgeEnabled = InstantModeKillSwitch.isSurgeEnabled();
    const interruptsEnabled = InstantModeKillSwitch.areInterruptsEnabled();
    const allEnabled = instantModeEnabled && surgeEnabled && interruptsEnabled;

    if (!allEnabled) {
      log.info(
        { instantModeEnabled, surgeEnabled, interruptsEnabled, taskId: context.taskId, operation: context.operation },
        'Instant Mode kill switch active'
      );
    }

    return {
      instantModeEnabled,
      surgeEnabled,
      interruptsEnabled,
      allEnabled,
    };
  },
};
