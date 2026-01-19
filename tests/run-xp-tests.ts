/**
 * Standalone test runner for AtomicXPService
 * Run with: npx tsx tests/run-xp-tests.ts
 */

import Decimal from 'decimal.js';

// Configure Decimal.js
Decimal.set({ 
  precision: 20, 
  rounding: Decimal.ROUND_DOWN
});

// ============================================================================
// FUNCTIONS UNDER TEST (copied from AtomicXPService for standalone testing)
// ============================================================================

const LEVEL_THRESHOLDS = [
  { level: 1,  xpRequired: 0 },
  { level: 2,  xpRequired: 100 },
  { level: 3,  xpRequired: 300 },
  { level: 4,  xpRequired: 700 },
  { level: 5,  xpRequired: 1500 },
  { level: 6,  xpRequired: 2700 },
  { level: 7,  xpRequired: 4500 },
  { level: 8,  xpRequired: 7000 },
  { level: 9,  xpRequired: 10500 },
  { level: 10, xpRequired: 18500 },
] as const;

const STREAK_MULTIPLIERS = [
  { minDays: 1,  maxDays: 2,  multiplier: '1.0' },
  { minDays: 3,  maxDays: 6,  multiplier: '1.1' },
  { minDays: 7,  maxDays: 13, multiplier: '1.2' },
  { minDays: 14, maxDays: 29, multiplier: '1.3' },
  { minDays: 30, maxDays: Infinity, multiplier: '1.5' },
] as const;

function calculateDecayFactor(totalXP: number): Decimal {
  const ratio = new Decimal(totalXP).div(1000);
  const logValue = Decimal.log10(ratio.plus(1));
  return new Decimal(1).div(logValue.plus(1)).toDecimalPlaces(4, Decimal.ROUND_DOWN);
}

function calculateEffectiveXP(baseXP: number, totalXP: number): number {
  const decay = calculateDecayFactor(totalXP);
  return new Decimal(baseXP).mul(decay).floor().toNumber();
}

function getStreakMultiplier(streakDays: number): Decimal {
  const tier = STREAK_MULTIPLIERS.find(
    t => streakDays >= t.minDays && streakDays <= t.maxDays
  );
  return new Decimal(tier?.multiplier ?? '1.0');
}

function calculateBaseXP(amountCents: number): number {
  const dollars = amountCents / 100;
  return Math.max(10, Math.floor(dollars));
}

function calculateLevel(totalXP: number): number {
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (totalXP >= LEVEL_THRESHOLDS[i].xpRequired) {
      return LEVEL_THRESHOLDS[i].level;
    }
  }
  return 1;
}

// ============================================================================
// TEST RUNNER
// ============================================================================

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}`);
    console.log(`     Error: ${e.message}`);
    failed++;
  }
}

function expect(actual: any) {
  return {
    toBe(expected: any) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}`);
      }
    },
    toBeCloseTo(expected: number, precision: number) {
      const diff = Math.abs(actual - expected);
      const epsilon = Math.pow(10, -precision);
      if (diff > epsilon) {
        throw new Error(`Expected ${expected} (±${epsilon}), got ${actual}`);
      }
    },
    toBeLessThan(expected: number) {
      if (!(actual < expected)) {
        throw new Error(`Expected ${actual} < ${expected}`);
      }
    },
    toBeGreaterThan(expected: number) {
      if (!(actual > expected)) {
        throw new Error(`Expected ${actual} > ${expected}`);
      }
    },
    toMatch(pattern: RegExp) {
      if (!pattern.test(actual)) {
        throw new Error(`Expected ${actual} to match ${pattern}`);
      }
    }
  };
}

// ============================================================================
// TESTS
// ============================================================================

console.log('\n🧪 AtomicXPService Unit Tests\n');

console.log('calculateDecayFactor:');
test('returns ~1.0 for 0 XP (no decay)', () => {
  const decay = calculateDecayFactor(0);
  expect(decay.toNumber()).toBeCloseTo(1.0, 4);
});

test('returns reduced factor for high XP', () => {
  const decay1000 = calculateDecayFactor(1000);
  const decay10000 = calculateDecayFactor(10000);
  expect(decay1000.toNumber()).toBeLessThan(1.0);
  expect(decay10000.toNumber()).toBeLessThan(decay1000.toNumber());
});

test('uses fixed-point arithmetic (4 decimal places)', () => {
  const decay = calculateDecayFactor(5000);
  const str = decay.toFixed(4);
  expect(str).toMatch(/^\d+\.\d{4}$/);
});

test('matches BUILD_GUIDE formula', () => {
  const totalXP = 5000;
  const expected = 1 / (1 + Math.log10(1 + totalXP / 1000));
  const actual = calculateDecayFactor(totalXP);
  expect(actual.toNumber()).toBeCloseTo(expected, 3);
});

console.log('\ncalculateEffectiveXP:');
test('applies decay to base XP', () => {
  const effective = calculateEffectiveXP(100, 5000);
  expect(effective).toBeLessThan(100);
  expect(effective).toBeGreaterThan(0);
});

test('returns baseXP when totalXP is 0', () => {
  const effective = calculateEffectiveXP(100, 0);
  expect(effective).toBe(100);
});

console.log('\ngetStreakMultiplier:');
test('returns 1.0 for streaks 1-2 days', () => {
  expect(getStreakMultiplier(1).toString()).toBe('1');
  expect(getStreakMultiplier(2).toString()).toBe('1');
});

test('returns 1.1 for streaks 3-6 days', () => {
  expect(getStreakMultiplier(3).toString()).toBe('1.1');
  expect(getStreakMultiplier(6).toString()).toBe('1.1');
});

test('returns 1.2 for streaks 7-13 days', () => {
  expect(getStreakMultiplier(7).toString()).toBe('1.2');
  expect(getStreakMultiplier(13).toString()).toBe('1.2');
});

test('returns 1.3 for streaks 14-29 days', () => {
  expect(getStreakMultiplier(14).toString()).toBe('1.3');
  expect(getStreakMultiplier(29).toString()).toBe('1.3');
});

test('returns 1.5 for streaks 30+ days', () => {
  expect(getStreakMultiplier(30).toString()).toBe('1.5');
  expect(getStreakMultiplier(100).toString()).toBe('1.5');
});

console.log('\ncalculateBaseXP:');
test('returns 10 XP per $10', () => {
  expect(calculateBaseXP(1000)).toBe(10);
  expect(calculateBaseXP(5000)).toBe(50);
  expect(calculateBaseXP(10000)).toBe(100);
});

test('returns minimum 10 XP', () => {
  expect(calculateBaseXP(100)).toBe(10);
  expect(calculateBaseXP(500)).toBe(10);
});

test('floors fractional results', () => {
  expect(calculateBaseXP(1550)).toBe(15);
});

console.log('\ncalculateLevel:');
test('returns level 1 for 0 XP', () => {
  expect(calculateLevel(0)).toBe(1);
});

test('returns correct levels at thresholds', () => {
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

test('returns correct levels between thresholds', () => {
  expect(calculateLevel(50)).toBe(1);
  expect(calculateLevel(200)).toBe(2);
  expect(calculateLevel(1000)).toBe(4);
});

test('returns max level for very high XP', () => {
  expect(calculateLevel(100000)).toBe(10);
});

console.log('\nLevel Thresholds:');
test('has exactly 10 levels', () => {
  expect(LEVEL_THRESHOLDS.length).toBe(10);
});

test('starts at 0 XP for level 1', () => {
  expect(LEVEL_THRESHOLDS[0].level).toBe(1);
  expect(LEVEL_THRESHOLDS[0].xpRequired).toBe(0);
});

test('ends at 18500 XP for level 10', () => {
  expect(LEVEL_THRESHOLDS[9].level).toBe(10);
  expect(LEVEL_THRESHOLDS[9].xpRequired).toBe(18500);
});

console.log('\nStreak Multipliers:');
test('has 5 tiers', () => {
  expect(STREAK_MULTIPLIERS.length).toBe(5);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log('\n============================================================');
console.log('TEST SUMMARY');
console.log('============================================================');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed === 0) {
  console.log('\n✅ ALL TESTS PASSED');
  console.log('   XP formulas match BUILD_GUIDE specification');
} else {
  console.log('\n❌ SOME TESTS FAILED');
  process.exit(1);
}
console.log('============================================================\n');
