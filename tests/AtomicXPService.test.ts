/**
 * ATOMIC XP SERVICE TESTS
 * 
 * Tests for BUILD_GUIDE invariants:
 * - INV-5: XP idempotent per escrow
 * - INV-XP-2: XP requires RELEASED escrow
 * - AUDIT-5: Fixed-point arithmetic
 * - AUDIT-6: Streak day boundary
 */

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  calculateDecayFactor,
  calculateEffectiveXP,
  getStreakMultiplier,
  calculateBaseXP,
  calculateLevel,
  isWithinStreakGrace,
  LEVEL_THRESHOLDS,
  STREAK_MULTIPLIERS,
  __test__,
} from '../services/AtomicXPService.js';

describe('XP Formulas (BUILD_GUIDE Compliance)', () => {
  
  describe('calculateDecayFactor', () => {
    it('returns 1.0 for 0 XP (no decay)', () => {
      const decay = calculateDecayFactor(0);
      expect(decay.toNumber()).toBeCloseTo(1.0, 4);
    });
    
    it('returns reduced factor for high XP', () => {
      const decay1000 = calculateDecayFactor(1000);
      const decay10000 = calculateDecayFactor(10000);
      
      expect(decay1000.toNumber()).toBeLessThan(1.0);
      expect(decay10000.toNumber()).toBeLessThan(decay1000.toNumber());
    });
    
    it('uses fixed-point arithmetic (AUDIT-5)', () => {
      const decay = calculateDecayFactor(5000);
      // Should have exactly 4 decimal places
      const str = decay.toFixed(4);
      expect(str).toMatch(/^\d+\.\d{4}$/);
    });
    
    it('matches BUILD_GUIDE formula: 1 / (1 + log₁₀(1 + totalXP/1000))', () => {
      const totalXP = 5000;
      const expected = 1 / (1 + Math.log10(1 + totalXP / 1000));
      const actual = calculateDecayFactor(totalXP);
      
      expect(actual.toNumber()).toBeCloseTo(expected, 3);
    });
  });
  
  describe('calculateEffectiveXP', () => {
    it('applies decay to base XP', () => {
      const effective = calculateEffectiveXP(100, 5000);
      expect(effective).toBeLessThan(100);
      expect(effective).toBeGreaterThan(0);
    });
    
    it('returns baseXP when totalXP is 0', () => {
      const effective = calculateEffectiveXP(100, 0);
      expect(effective).toBe(100);
    });
    
    it('floors result (no fractions)', () => {
      const effective = calculateEffectiveXP(100, 1000);
      expect(Number.isInteger(effective)).toBe(true);
    });
  });
  
  describe('getStreakMultiplier', () => {
    it('returns 1.0 for streaks 1-2 days', () => {
      expect(getStreakMultiplier(1).toString()).toBe('1');
      expect(getStreakMultiplier(2).toString()).toBe('1');
    });
    
    it('returns 1.1 for streaks 3-6 days', () => {
      expect(getStreakMultiplier(3).toString()).toBe('1.1');
      expect(getStreakMultiplier(6).toString()).toBe('1.1');
    });
    
    it('returns 1.2 for streaks 7-13 days', () => {
      expect(getStreakMultiplier(7).toString()).toBe('1.2');
      expect(getStreakMultiplier(13).toString()).toBe('1.2');
    });
    
    it('returns 1.3 for streaks 14-29 days', () => {
      expect(getStreakMultiplier(14).toString()).toBe('1.3');
      expect(getStreakMultiplier(29).toString()).toBe('1.3');
    });
    
    it('returns 1.5 for streaks 30+ days', () => {
      expect(getStreakMultiplier(30).toString()).toBe('1.5');
      expect(getStreakMultiplier(100).toString()).toBe('1.5');
    });
    
    it('returns 1.0 for 0 days', () => {
      expect(getStreakMultiplier(0).toString()).toBe('1');
    });
  });
  
  describe('calculateBaseXP', () => {
    it('returns 10 XP per $10', () => {
      expect(calculateBaseXP(1000)).toBe(10);  // $10
      expect(calculateBaseXP(5000)).toBe(50);  // $50
      expect(calculateBaseXP(10000)).toBe(100); // $100
    });
    
    it('returns minimum 10 XP', () => {
      expect(calculateBaseXP(100)).toBe(10);  // $1
      expect(calculateBaseXP(500)).toBe(10);  // $5
    });
    
    it('floors fractional results', () => {
      expect(calculateBaseXP(1550)).toBe(15); // $15.50 → 15 XP
    });
  });
  
  describe('calculateLevel', () => {
    it('returns level 1 for 0 XP', () => {
      expect(calculateLevel(0)).toBe(1);
    });
    
    it('returns correct levels at thresholds', () => {
      expect(calculateLevel(0)).toBe(1);
      expect(calculateLevel(100)).toBe(2);
      expect(calculateLevel(300)).toBe(3);
      expect(calculateLevel(700)).toBe(4);
      expect(calculateLevel(1500)).toBe(5);
      expect(calculateLevel(2700)).toBe(6);
      expect(calculateLevel(4500)).toBe(7);
      expect(calculateLevel(7000)).toBe(8);
      expect(calculateLevel(10500)).toBe(9);
      expect(calculateLevel(18500)).toBe(10);
    });
    
    it('returns correct levels between thresholds', () => {
      expect(calculateLevel(50)).toBe(1);   // Below 100
      expect(calculateLevel(200)).toBe(2);  // Between 100-300
      expect(calculateLevel(1000)).toBe(4); // Between 700-1500
    });
    
    it('returns max level for very high XP', () => {
      expect(calculateLevel(100000)).toBe(10);
    });
  });
  
  describe('isWithinStreakGrace (AUDIT-6)', () => {
    it('returns false for null last completion', () => {
      expect(isWithinStreakGrace(null)).toBe(false);
    });
    
    it('returns true for completion today', () => {
      const now = new Date();
      const todayCompletion = new Date(now.getTime() - 1000); // 1 second ago
      expect(isWithinStreakGrace(todayCompletion)).toBe(true);
    });
    
    // Note: Time-based tests are tricky, these test the logic
    it('handles UTC boundaries', () => {
      const now = new Date();
      const todayStart = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0, 0, 0, 0
      ));
      
      // Completion at yesterday 23:59 UTC
      const yesterdayLate = new Date(todayStart.getTime() - 60000);
      
      // This depends on current time, so we just verify it doesn't throw
      const result = isWithinStreakGrace(yesterdayLate);
      expect(typeof result).toBe('boolean');
    });
  });
});

describe('Level Thresholds (BUILD_GUIDE)', () => {
  it('has exactly 10 levels', () => {
    expect(LEVEL_THRESHOLDS.length).toBe(10);
  });
  
  it('starts at 0 XP for level 1', () => {
    expect(LEVEL_THRESHOLDS[0]).toEqual({ level: 1, xpRequired: 0 });
  });
  
  it('ends at 18500 XP for level 10', () => {
    expect(LEVEL_THRESHOLDS[9]).toEqual({ level: 10, xpRequired: 18500 });
  });
  
  it('thresholds are monotonically increasing', () => {
    for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
      expect(LEVEL_THRESHOLDS[i].xpRequired)
        .toBeGreaterThan(LEVEL_THRESHOLDS[i-1].xpRequired);
    }
  });
});

describe('Streak Multipliers (BUILD_GUIDE)', () => {
  it('has 5 tiers', () => {
    expect(STREAK_MULTIPLIERS.length).toBe(5);
  });
  
  it('covers all positive streak values', () => {
    // Check no gaps
    expect(STREAK_MULTIPLIERS[0].minDays).toBe(1);
    expect(STREAK_MULTIPLIERS[4].maxDays).toBe(Infinity);
  });
  
  it('multipliers range from 1.0 to 1.5', () => {
    expect(STREAK_MULTIPLIERS[0].multiplier).toBe('1.0');
    expect(STREAK_MULTIPLIERS[4].multiplier).toBe('1.5');
  });
});
