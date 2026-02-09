/**
 * WorkerSkillService v1.0.0
 *
 * CONSTITUTIONAL: Worker Skill Tree system (Gap 1 fix)
 *
 * 100+ skills with hard/soft gates. Hard-gated skills (trades, care)
 * require license/background check verification. Soft-gated skills
 * unlock by trust tier and XP.
 *
 * @see migrations/20260208_001_worker_skills_system.sql
 */

import { db } from '../db';
import type { ServiceResult } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface SkillCategory {
  id: string;
  name: string;
  display_name: string;
  icon_name: string;
  sort_order: number;
}

interface Skill {
  id: string;
  category_id: string;
  name: string;
  display_name: string;
  description: string | null;
  icon_name: string | null;
  gate_type: 'soft' | 'hard';
  min_trust_tier: number;
  requires_license: boolean;
  requires_background_check: boolean;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';
  is_active: boolean;
  sort_order: number;
}

interface WorkerSkill {
  id: string;
  user_id: string;
  skill_id: string;
  verified: boolean;
  verified_at: Date | null;
  license_url: string | null;
  license_expiry: Date | null;
  tasks_completed: number;
  avg_rating: number | null;
  created_at: Date;
}

interface SkillWithDetails extends Skill {
  category_name: string;
  category_display_name: string;
  worker_verified?: boolean;
  worker_tasks_completed?: number;
}

interface SkillEligibility {
  eligible: boolean;
  reason?: string;
  requires_license: boolean;
  requires_background_check: boolean;
  min_trust_tier: number;
  user_trust_tier: number;
}

// ============================================================================
// SERVICE
// ============================================================================

export const WorkerSkillService = {
  // --------------------------------------------------------------------------
  // SKILL CATALOG (Read-only)
  // --------------------------------------------------------------------------

  /**
   * Get all skill categories
   */
  getCategories: async (): Promise<ServiceResult<SkillCategory[]>> => {
    try {
      const result = await db.query<SkillCategory>(
        `SELECT id, name, display_name, icon_name, sort_order
         FROM skill_categories
         ORDER BY sort_order ASC`
      );
      return { success: true, data: result.rows };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Get all skills, optionally filtered by category
   */
  getSkills: async (categoryId?: string): Promise<ServiceResult<SkillWithDetails[]>> => {
    try {
      let sql = `
        SELECT s.*, sc.name AS category_name, sc.display_name AS category_display_name
        FROM skills s
        JOIN skill_categories sc ON sc.id = s.category_id
        WHERE s.is_active = TRUE
      `;
      const params: unknown[] = [];

      if (categoryId) {
        params.push(categoryId);
        sql += ` AND s.category_id = $${params.length}`;
      }

      sql += ` ORDER BY sc.sort_order ASC, s.sort_order ASC`;

      const result = await db.query<SkillWithDetails>(sql, params);
      return { success: true, data: result.rows };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  // --------------------------------------------------------------------------
  // WORKER SKILL MANAGEMENT
  // --------------------------------------------------------------------------

  /**
   * Add skills to worker profile (onboarding "Skill Cloud" tap)
   * Soft-gated skills: added immediately
   * Hard-gated skills: added but unverified (need license upload)
   */
  addSkills: async (userId: string, skillIds: string[]): Promise<ServiceResult<{ added: number; pendingVerification: string[] }>> => {
    try {
      // Get user trust tier
      const userResult = await db.query<{ trust_tier: number; background_check_passed: boolean }>(
        `SELECT trust_tier, COALESCE(background_check_passed, FALSE) AS background_check_passed FROM users WHERE id = $1`,
        [userId]
      );

      if (userResult.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'User not found' } };
      }

      const user = userResult.rows[0];

      // Get skill details for all requested skills
      const skillsResult = await db.query<Skill>(
        `SELECT * FROM skills WHERE id = ANY($1) AND is_active = TRUE`,
        [skillIds]
      );

      let added = 0;
      const pendingVerification: string[] = [];

      for (const skill of skillsResult.rows) {
        // For hard-gated skills, check if they need license
        const needsVerification = skill.gate_type === 'hard';

        // Insert (or skip if already exists)
        const insertResult = await db.query(
          `INSERT INTO worker_skills (user_id, skill_id, verified)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, skill_id) DO NOTHING
           RETURNING id`,
          [userId, skill.id, !needsVerification] // soft-gated = auto-verified
        );

        if (insertResult.rowCount && insertResult.rowCount > 0) {
          added++;
          if (needsVerification) {
            pendingVerification.push(skill.display_name);
          }
        }
      }

      return {
        success: true,
        data: { added, pendingVerification },
      };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Remove a skill from worker profile
   */
  removeSkill: async (userId: string, skillId: string): Promise<ServiceResult<void>> => {
    try {
      await db.query(
        `DELETE FROM worker_skills WHERE user_id = $1 AND skill_id = $2`,
        [userId, skillId]
      );
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Get worker's selected skills with details
   */
  getWorkerSkills: async (userId: string): Promise<ServiceResult<(WorkerSkill & { skill: SkillWithDetails })[]>> => {
    try {
      const result = await db.query<WorkerSkill & { skill: SkillWithDetails }>(
        `SELECT ws.*,
                json_build_object(
                  'id', s.id, 'name', s.name, 'display_name', s.display_name,
                  'category_id', s.category_id, 'gate_type', s.gate_type,
                  'min_trust_tier', s.min_trust_tier, 'requires_license', s.requires_license,
                  'requires_background_check', s.requires_background_check,
                  'risk_level', s.risk_level, 'icon_name', s.icon_name,
                  'category_name', sc.name, 'category_display_name', sc.display_name
                ) AS skill
         FROM worker_skills ws
         JOIN skills s ON s.id = ws.skill_id
         JOIN skill_categories sc ON sc.id = s.category_id
         WHERE ws.user_id = $1
         ORDER BY sc.sort_order ASC, s.sort_order ASC`,
        [userId]
      );
      return { success: true, data: result.rows };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Upload license for hard-gated skill verification
   */
  submitLicense: async (
    userId: string,
    skillId: string,
    licenseUrl: string,
    licenseExpiry?: Date
  ): Promise<ServiceResult<void>> => {
    try {
      const result = await db.query(
        `UPDATE worker_skills
         SET license_url = $3,
             license_expiry = $4
         WHERE user_id = $1 AND skill_id = $2`,
        [userId, skillId, licenseUrl, licenseExpiry || null]
      );

      if (result.rowCount === 0) {
        return {
          success: false,
          error: { code: 'NOT_FOUND', message: 'Worker skill not found. Add the skill first.' },
        };
      }

      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Admin: Verify a hard-gated skill after license review
   */
  verifySkill: async (userId: string, skillId: string): Promise<ServiceResult<void>> => {
    try {
      await db.query(
        `UPDATE worker_skills
         SET verified = TRUE, verified_at = NOW()
         WHERE user_id = $1 AND skill_id = $2`,
        [userId, skillId]
      );
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  // --------------------------------------------------------------------------
  // SKILL-BASED TASK MATCHING (Gap 1 core fix)
  // --------------------------------------------------------------------------

  /**
   * Check if worker is eligible for a specific task based on skills
   */
  checkTaskEligibility: async (userId: string, taskId: string): Promise<ServiceResult<SkillEligibility>> => {
    try {
      // Get task required skills
      const taskSkillsResult = await db.query<{ skill_id: string }>(
        `SELECT skill_id FROM task_skills WHERE task_id = $1`,
        [taskId]
      );

      // If task has no skill requirements, anyone is eligible
      if (taskSkillsResult.rows.length === 0) {
        return {
          success: true,
          data: {
            eligible: true,
            requires_license: false,
            requires_background_check: false,
            min_trust_tier: 1,
            user_trust_tier: 1,
          },
        };
      }

      const requiredSkillIds = taskSkillsResult.rows.map(r => r.skill_id);

      // Get worker's matching skills (verified only for hard-gated)
      const workerSkillsResult = await db.query<{ skill_id: string; verified: boolean; gate_type: string }>(
        `SELECT ws.skill_id, ws.verified, s.gate_type
         FROM worker_skills ws
         JOIN skills s ON s.id = ws.skill_id
         WHERE ws.user_id = $1 AND ws.skill_id = ANY($2)`,
        [userId, requiredSkillIds]
      );

      const workerSkillMap = new Map(
        workerSkillsResult.rows.map(r => [r.skill_id, r])
      );

      // Check each required skill
      for (const requiredId of requiredSkillIds) {
        const workerSkill = workerSkillMap.get(requiredId);

        if (!workerSkill) {
          return {
            success: true,
            data: {
              eligible: false,
              reason: 'Missing required skill',
              requires_license: false,
              requires_background_check: false,
              min_trust_tier: 1,
              user_trust_tier: 1,
            },
          };
        }

        // Hard-gated skills must be verified
        if (workerSkill.gate_type === 'hard' && !workerSkill.verified) {
          return {
            success: true,
            data: {
              eligible: false,
              reason: 'Skill requires license verification',
              requires_license: true,
              requires_background_check: false,
              min_trust_tier: 3,
              user_trust_tier: 1,
            },
          };
        }
      }

      return {
        success: true,
        data: {
          eligible: true,
          requires_license: false,
          requires_background_check: false,
          min_trust_tier: 1,
          user_trust_tier: 1,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Get eligible task IDs for a worker based on their skills + trust tier
   * Used by task feed to filter to "eligible only" (conversation requirement)
   */
  getEligibleTaskFilter: async (userId: string): Promise<ServiceResult<string>> => {
    try {
      // Get user trust tier
      const userResult = await db.query<{ trust_tier: number }>(
        `SELECT trust_tier FROM users WHERE id = $1`,
        [userId]
      );

      if (userResult.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'User not found' } };
      }

      const trustTier = userResult.rows[0].trust_tier;

      // Build SQL fragment for eligible tasks:
      // 1. Tasks with NO skill requirements (open to all at trust tier)
      // 2. Tasks where worker has ALL required skills (verified for hard-gated)
      const filterSQL = `
        (
          -- Tasks with no skill requirements
          NOT EXISTS (SELECT 1 FROM task_skills ts2 WHERE ts2.task_id = t.id)
          OR
          -- Tasks where worker has ALL required skills (verified for hard-gated)
          NOT EXISTS (
            SELECT 1 FROM task_skills ts3
            JOIN skills s3 ON s3.id = ts3.skill_id
            WHERE ts3.task_id = t.id
            AND NOT EXISTS (
              SELECT 1 FROM worker_skills ws3
              WHERE ws3.user_id = '${userId}'
              AND ws3.skill_id = ts3.skill_id
              AND (s3.gate_type = 'soft' OR ws3.verified = TRUE)
            )
          )
        )
        AND (
          -- Trust tier check against task risk level
          CASE t.risk_level
            WHEN 'LOW' THEN ${trustTier} >= 1
            WHEN 'MEDIUM' THEN ${trustTier} >= 2
            WHEN 'HIGH' THEN ${trustTier} >= 3
            WHEN 'IN_HOME' THEN ${trustTier} >= 2
            ELSE TRUE
          END
        )
      `;

      return { success: true, data: filterSQL };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Increment task completion count for worker skill
   */
  recordTaskCompletion: async (userId: string, taskId: string): Promise<ServiceResult<void>> => {
    try {
      // Get task's skills
      const taskSkills = await db.query<{ skill_id: string }>(
        `SELECT skill_id FROM task_skills WHERE task_id = $1`,
        [taskId]
      );

      for (const { skill_id } of taskSkills.rows) {
        await db.query(
          `UPDATE worker_skills
           SET tasks_completed = tasks_completed + 1
           WHERE user_id = $1 AND skill_id = $2`,
          [userId, skill_id]
        );
      }

      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },
};

export default WorkerSkillService;
