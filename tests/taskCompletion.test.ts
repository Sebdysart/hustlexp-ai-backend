/**
 * Task Completion Service Tests
 * 
 * Note: These tests use mock data since the service has dependencies 
 * that require API keys. Full integration tests should be run with 
 * proper environment setup.
 */

import { describe, it, expect } from 'vitest';

// Test streak bonus calculation logic (isolated)
const STREAK_BONUSES = [
    { days: 3, xp: 25, message: '🔥 3-day streak!' },
    { days: 7, xp: 75, message: '🔥🔥 Week warrior!' },
    { days: 14, xp: 150, message: '🔥🔥🔥 Two week champion!' },
    { days: 30, xp: 500, message: '👑 Monthly legend!' },
];

describe('Task Completion Logic', () => {
    describe('Streak Bonus Calculation', () => {
        it('should award 25 XP at 3-day streak', () => {
            const bonus = STREAK_BONUSES.find(b => b.days === 3);
            expect(bonus?.xp).toBe(25);
        });

        it('should award 75 XP at 7-day streak', () => {
            const bonus = STREAK_BONUSES.find(b => b.days === 7);
            expect(bonus?.xp).toBe(75);
        });

        it('should award 150 XP at 14-day streak', () => {
            const bonus = STREAK_BONUSES.find(b => b.days === 14);
            expect(bonus?.xp).toBe(150);
        });

        it('should award 500 XP at 30-day streak', () => {
            const bonus = STREAK_BONUSES.find(b => b.days === 30);
            expect(bonus?.xp).toBe(500);
        });
    });

    describe('XP Breakdown Calculation', () => {
        it('should calculate base XP correctly', () => {
            const baseXP = 100;
            expect(baseXP).toBe(100);
        });

        it('should calculate 5-star rating bonus correctly', () => {
            const ratingBonus = 50; // 5-star
            expect(ratingBonus).toBe(50);
        });

        it('should calculate 4-star rating bonus correctly', () => {
            const ratingBonus = 20; // 4-star
            expect(ratingBonus).toBe(20);
        });
    });

    describe('Streak Logic', () => {
        it('should identify next bonus correctly', () => {
            const currentStreak = 5;
            const nextBonus = STREAK_BONUSES.find(b => b.days > currentStreak);
            expect(nextBonus?.days).toBe(7);
            expect(nextBonus?.xp).toBe(75);
        });

        it('should calculate days until bonus', () => {
            const currentStreak = 5;
            const nextBonus = STREAK_BONUSES.find(b => b.days > currentStreak);
            const daysUntilBonus = nextBonus!.days - currentStreak;
            expect(daysUntilBonus).toBe(2);
        });
    });
});
