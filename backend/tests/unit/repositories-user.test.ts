/**
 * UserRepository Unit Tests
 *
 * Tests all methods of UserRepository with mocked db.query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock DB (must use vi.fn() inline, no top-level variables before mock) ──
vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  default: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
  },
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────
import { db } from '../../src/db';
import { UserRepository } from '../../src/repositories/UserRepository';

const repo = new UserRepository();
const mockQuery = vi.mocked(db.query);

const mockUser = {
  id: 'user-1',
  firebase_uid: 'firebase-uid-1',
  email: 'test@example.com',
  full_name: 'Test User',
  default_mode: 'worker',
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// BaseRepository (inherited)
// ============================================================================

describe('UserRepository — BaseRepository methods', () => {
  it('findById returns user when found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
    const result = await repo.findById('user-1');
    expect(result).toEqual(mockUser);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM users WHERE id = $1'),
      ['user-1']
    );
  });

  it('findById returns null when not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.findById('nonexistent');
    expect(result).toBeNull();
  });

  it('exists returns true when record exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }], rowCount: 1 });
    const result = await repo.exists('user-1');
    expect(result).toBe(true);
  });

  it('exists returns false when record does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 });
    const result = await repo.exists('missing');
    expect(result).toBe(false);
  });

  it('exists returns false when query returns no rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.exists('missing');
    expect(result).toBe(false);
  });

  it('deleteById returns true when row deleted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const result = await repo.deleteById('user-1');
    expect(result).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM users WHERE id = $1'),
      ['user-1']
    );
  });

  it('deleteById returns false when no row deleted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.deleteById('nonexistent');
    expect(result).toBe(false);
  });

  it('count() no longer exists on repositories (AUDIT FIX L1 — raw WHERE interpolation removed)', () => {
    // The method interpolated `WHERE ${where}` unparameterized — deleted as a
    // latent injection sink. This test pins the removal.
    expect((repo as unknown as Record<string, unknown>).count).toBeUndefined();
  });

  it('uses transaction query when ctx is provided', async () => {
    const txQuery = vi.fn().mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
    const result = await repo.findById('user-1', { query: txQuery });
    expect(result).toEqual(mockUser);
    expect(txQuery).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ============================================================================
// findByFirebaseUid
// ============================================================================

describe('UserRepository.findByFirebaseUid', () => {
  it('returns user when found by firebase uid', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
    const result = await repo.findByFirebaseUid('firebase-uid-1');
    expect(result).toEqual(mockUser);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE firebase_uid = $1'),
      ['firebase-uid-1']
    );
  });

  it('returns null when firebase uid not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.findByFirebaseUid('nonexistent-uid');
    expect(result).toBeNull();
  });

  it('uses transaction context when provided', async () => {
    const txQuery = vi.fn().mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
    const result = await repo.findByFirebaseUid('firebase-uid-1', { query: txQuery });
    expect(result).toEqual(mockUser);
    expect(txQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE firebase_uid = $1'),
      ['firebase-uid-1']
    );
  });
});

// ============================================================================
// findByEmail
// ============================================================================

describe('UserRepository.findByEmail', () => {
  it('returns user when found by email', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
    const result = await repo.findByEmail('test@example.com');
    expect(result).toEqual(mockUser);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE email = $1'),
      ['test@example.com']
    );
  });

  it('returns null when email not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.findByEmail('notfound@example.com');
    expect(result).toBeNull();
  });
});

// ============================================================================
// register
// ============================================================================

describe('UserRepository.register', () => {
  it('creates a new user and returns it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

    const result = await repo.register({
      id: 'user-1',
      firebase_uid: 'firebase-uid-1',
      email: 'test@example.com',
      full_name: 'Test User',
      default_mode: 'worker',
    });

    expect(result).toEqual(mockUser);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      ['user-1', 'firebase-uid-1', 'test@example.com', 'Test User', 'worker']
    );
  });

  it('defaults default_mode to worker when not provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...mockUser, default_mode: 'worker' }], rowCount: 1 });

    await repo.register({
      id: 'user-2',
      firebase_uid: 'firebase-uid-2',
      email: 'user2@example.com',
      full_name: 'User Two',
    });

    const callArgs = mockQuery.mock.calls[0][1] as unknown[];
    expect(callArgs[4]).toBe('worker');
  });

  it('uses poster as default_mode when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...mockUser, default_mode: 'poster' }], rowCount: 1 });

    await repo.register({
      id: 'user-3',
      firebase_uid: 'firebase-uid-3',
      email: 'poster@example.com',
      full_name: 'Poster User',
      default_mode: 'poster',
    });

    const callArgs = mockQuery.mock.calls[0][1] as unknown[];
    expect(callArgs[4]).toBe('poster');
  });
});

// ============================================================================
// updateProfile
// ============================================================================

describe('UserRepository.updateProfile', () => {
  it('falls back to findById when no fields to update', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.updateProfile('user-1', {});
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM users WHERE id = $1'),
      ['user-1']
    );
    expect(result).toBeNull();
  });

  it('updates full_name', async () => {
    const updated = { ...mockUser, full_name: 'New Name' };
    mockQuery.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    const result = await repo.updateProfile('user-1', { full_name: 'New Name' });

    expect(result).toEqual(updated);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('full_name = $1');
    expect(sql).toContain('updated_at = NOW()');
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe('New Name');
  });

  it('updates bio', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
    await repo.updateProfile('user-1', { bio: 'I am a worker' });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('bio = $1');
  });

  it('updates avatar_url', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
    await repo.updateProfile('user-1', { avatar_url: 'https://example.com/avatar.jpg' });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('avatar_url = $1');
  });

  it('updates phone', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
    await repo.updateProfile('user-1', { phone: '+1234567890' });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('phone = $1');
  });

  it('updates default_mode', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
    await repo.updateProfile('user-1', { default_mode: 'poster' });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('default_mode = $1');
  });

  it('updates multiple fields at once', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
    await repo.updateProfile('user-1', { full_name: 'Bob', bio: 'My bio', phone: '555-1234' });

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('full_name = $1');
    expect(sql).toContain('bio = $2');
    expect(sql).toContain('phone = $3');

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe('Bob');
    expect(params[1]).toBe('My bio');
    expect(params[2]).toBe('555-1234');
  });

  it('returns null when user not found after update', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.updateProfile('user-1', { full_name: 'Updated' });
    expect(result).toBeNull();
  });
});

// ============================================================================
// completeOnboarding
// ============================================================================

describe('UserRepository.completeOnboarding', () => {
  it('completes onboarding with required fields', async () => {
    const updated = { ...mockUser, onboarding_version: '1.0.0' };
    mockQuery.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    const result = await repo.completeOnboarding('user-1', {
      version: '1.0.0',
      role_confidence_worker: 0.8,
      role_confidence_poster: 0.2,
      role_certainty_tier: 'HIGH',
    });

    expect(result).toEqual(updated);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users SET'),
      ['1.0.0', 0.8, 0.2, 'HIGH', null, 'user-1']
    );
  });

  it('includes inconsistency_flags when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

    await repo.completeOnboarding('user-1', {
      version: '1.0.0',
      role_confidence_worker: 0.7,
      role_confidence_poster: 0.3,
      role_certainty_tier: 'MEDIUM',
      inconsistency_flags: ['FLAG_A'],
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[4]).toEqual(['FLAG_A']);
  });

  it('passes null for inconsistency_flags when not provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

    await repo.completeOnboarding('user-1', {
      version: '1.0.0',
      role_confidence_worker: 1.0,
      role_confidence_poster: 0.0,
      role_certainty_tier: 'CERTAIN',
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[4]).toBeNull();
  });

  it('returns null when user not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await repo.completeOnboarding('nonexistent', {
      version: '1.0.0',
      role_confidence_worker: 0.5,
      role_confidence_poster: 0.5,
      role_certainty_tier: 'LOW',
    });

    expect(result).toBeNull();
  });
});

// ============================================================================
// Singleton export
// ============================================================================

describe('userRepository singleton', () => {
  it('exports a UserRepository instance', async () => {
    const { userRepository } = await import('../../src/repositories/UserRepository');
    expect(userRepository).toBeInstanceOf(UserRepository);
  });
});
