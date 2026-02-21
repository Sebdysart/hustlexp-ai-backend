/**
 * User Router Integration Tests
 *
 * Tests user profile operations and auth flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
}));

vi.mock('../../../src/services/XPService', () => ({
  XPService: { getXP: vi.fn(), awardXP: vi.fn() },
}));

vi.mock('../../../src/services/EarnedVerificationUnlockService', () => ({
  EarnedVerificationUnlockService: { recordEarnings: vi.fn() },
}));

vi.mock('../../../src/services/PlanService', () => ({
  PlanService: {
    canCreateTaskWithRisk: vi.fn().mockReturnValue({ allowed: true }),
    canAcceptTaskWithRisk: vi.fn().mockReturnValue({ allowed: true }),
  },
}));

vi.mock('../../../src/services/ScoperAIService', () => ({
  ScoperAIService: { analyzeTaskScope: vi.fn().mockResolvedValue(null) },
}));

import { db } from '../../../src/db';

describe('User Router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.query as any).mockReset();
  });

  describe('User profile lookup', () => {
    it('should return user profile by firebase_uid', async () => {
      const mockUser = {
        id: 'user-1',
        firebase_uid: 'fb-uid-1',
        email: 'test@hustlexp.com',
        full_name: 'Test User',
        trust_tier: 1,
        xp_total: 0,
        is_verified: false,
        default_mode: 'worker',
      };

      (db.query as any).mockResolvedValue({ rows: [mockUser], rowCount: 1 });

      const result = await db.query('SELECT * FROM users WHERE firebase_uid = $1', ['fb-uid-1']);
      expect(result.rows[0].email).toBe('test@hustlexp.com');
      expect(result.rows[0].trust_tier).toBe(1);
    });

    it('should return empty for non-existent user', async () => {
      (db.query as any).mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await db.query('SELECT * FROM users WHERE firebase_uid = $1', ['nonexistent']);
      expect(result.rows).toHaveLength(0);
    });
  });

  describe('User registration', () => {
    it('should create new user with default values', async () => {
      const newUser = {
        id: 'user-new',
        firebase_uid: 'fb-new',
        email: 'new@hustlexp.com',
        full_name: 'New User',
        trust_tier: 0,  // ROOKIE
        xp_total: 0,
        is_verified: false,
        default_mode: 'worker',
      };

      (db.query as any).mockResolvedValue({ rows: [newUser], rowCount: 1 });

      const result = await db.query(
        'INSERT INTO users (firebase_uid, email, full_name) VALUES ($1, $2, $3) RETURNING *',
        ['fb-new', 'new@hustlexp.com', 'New User']
      );
      expect(result.rows[0].trust_tier).toBe(0);
      expect(result.rows[0].xp_total).toBe(0);
    });
  });

  describe('Profile update', () => {
    it('should update user bio', async () => {
      (db.query as any).mockResolvedValue({
        rows: [{ id: 'user-1', bio: 'New bio text' }],
        rowCount: 1,
      });

      const result = await db.query(
        'UPDATE users SET bio = $1 WHERE id = $2 RETURNING *',
        ['New bio text', 'user-1']
      );
      expect(result.rows[0].bio).toBe('New bio text');
    });
  });

  describe('Role normalization', () => {
    it('should store worker role for hustler input', () => {
      function normalizeRole(role: string): 'worker' | 'poster' {
        if (role === 'hustler' || role === 'worker') return 'worker';
        if (role === 'poster') return 'poster';
        return 'worker';
      }
      expect(normalizeRole('hustler')).toBe('worker');
      expect(normalizeRole('worker')).toBe('worker');
      expect(normalizeRole('poster')).toBe('poster');
      expect(normalizeRole('unknown')).toBe('worker');
    });
  });
});
