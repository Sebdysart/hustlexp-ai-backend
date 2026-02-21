/**
 * User Repository
 *
 * Data access layer for users table. Encapsulates all user-related SQL
 * so services never write raw queries directly.
 */

import { BaseRepository, type RepositoryContext } from './BaseRepository';
import type { User } from '../types';

export class UserRepository extends BaseRepository<User> {
  protected readonly tableName = 'users';

  /**
   * Find a user by Firebase UID.
   */
  async findByFirebaseUid(
    firebaseUid: string,
    ctx?: RepositoryContext
  ): Promise<User | null> {
    const query = this.getQuery(ctx);
    const result = await query<User>(
      `SELECT * FROM ${this.tableName} WHERE firebase_uid = $1`,
      [firebaseUid]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Find a user by email.
   */
  async findByEmail(
    email: string,
    ctx?: RepositoryContext
  ): Promise<User | null> {
    const query = this.getQuery(ctx);
    const result = await query<User>(
      `SELECT * FROM ${this.tableName} WHERE email = $1`,
      [email]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Register a new user. Returns the created user.
   */
  async register(
    data: {
      id: string;
      firebase_uid: string;
      email: string;
      full_name: string;
      default_mode?: string;
    },
    ctx?: RepositoryContext
  ): Promise<User> {
    const query = this.getQuery(ctx);
    const result = await query<User>(
      `INSERT INTO ${this.tableName} (
        id, firebase_uid, email, full_name, default_mode, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      RETURNING *`,
      [
        data.id,
        data.firebase_uid,
        data.email,
        data.full_name,
        data.default_mode ?? 'worker',
      ]
    );
    return result.rows[0];
  }

  /**
   * Update user profile fields. Returns the updated user.
   */
  async updateProfile(
    userId: string,
    data: {
      full_name?: string;
      bio?: string;
      avatar_url?: string;
      phone?: string;
      default_mode?: string;
    },
    ctx?: RepositoryContext
  ): Promise<User | null> {
    const query = this.getQuery(ctx);
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (data.full_name !== undefined) {
      setClauses.push(`full_name = $${paramIndex++}`);
      params.push(data.full_name);
    }
    if (data.bio !== undefined) {
      setClauses.push(`bio = $${paramIndex++}`);
      params.push(data.bio);
    }
    if (data.avatar_url !== undefined) {
      setClauses.push(`avatar_url = $${paramIndex++}`);
      params.push(data.avatar_url);
    }
    if (data.phone !== undefined) {
      setClauses.push(`phone = $${paramIndex++}`);
      params.push(data.phone);
    }
    if (data.default_mode !== undefined) {
      setClauses.push(`default_mode = $${paramIndex++}`);
      params.push(data.default_mode);
    }

    if (setClauses.length === 0) return this.findById(userId, ctx);

    setClauses.push(`updated_at = NOW()`);
    params.push(userId);

    const result = await query<User>(
      `UPDATE ${this.tableName} SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );
    return result.rows[0] ?? null;
  }

  /**
   * Complete onboarding for a user.
   */
  async completeOnboarding(
    userId: string,
    data: {
      version: string;
      role_confidence_worker: number;
      role_confidence_poster: number;
      role_certainty_tier: string;
      inconsistency_flags?: string[];
    },
    ctx?: RepositoryContext
  ): Promise<User | null> {
    const query = this.getQuery(ctx);
    const result = await query<User>(
      `UPDATE ${this.tableName} SET
        onboarding_version = $1,
        onboarding_completed_at = NOW(),
        role_confidence_worker = $2,
        role_confidence_poster = $3,
        role_certainty_tier = $4,
        inconsistency_flags = $5,
        updated_at = NOW()
      WHERE id = $6 RETURNING *`,
      [
        data.version,
        data.role_confidence_worker,
        data.role_confidence_poster,
        data.role_certainty_tier,
        data.inconsistency_flags ?? null,
        userId,
      ]
    );
    return result.rows[0] ?? null;
  }
}

/** Singleton instance */
export const userRepository = new UserRepository();
