/**
 * AIJobService v1.0.0
 * 
 * CONSTITUTIONAL: Manages AI job orchestration
 * 
 * Tracks AI job lifecycle: PENDING → PROCESSING → COMPLETED/FAILED/TIMED_OUT/KILLED
 * Supports retry logic and timeout handling.
 * 
 * @see schema.sql §7.2 (ai_jobs table)
 * @see AI_INFRASTRUCTURE.md §6.2
 */

import { db } from '../db';
import type { ServiceResult, AIJob, AIJobStatus } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface CreateAIJobParams {
  eventId: string;
  subsystem: string;
  modelProvider?: string;
  modelId?: string;
  promptVersion?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

interface UpdateAIJobParams {
  jobId: string;
  status: AIJobStatus;
  lastError?: string;
}

// ============================================================================
// SERVICE
// ============================================================================

export const AIJobService = {
  /**
   * Create a new AI job
   */
  create: async (params: CreateAIJobParams): Promise<ServiceResult<AIJob>> => {
    const {
      eventId,
      subsystem,
      modelProvider,
      modelId,
      promptVersion,
      timeoutMs = 30000,
      maxAttempts = 3,
    } = params;
    
    try {
      const result = await db.query<AIJob>(
        `INSERT INTO ai_jobs (
          event_id, subsystem, status, model_provider, model_id,
          prompt_version, timeout_ms, max_attempts, attempt_count
        ) VALUES ($1, $2, 'PENDING', $3, $4, $5, $6, $7, 0)
        RETURNING *`,
        [eventId, subsystem, modelProvider, modelId, promptVersion, timeoutMs, maxAttempts]
      );
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Start processing a job
   */
  start: async (jobId: string): Promise<ServiceResult<AIJob>> => {
    try {
      const result = await db.query<AIJob>(
        `UPDATE ai_jobs
         SET status = 'PROCESSING',
             started_at = NOW(),
             attempt_count = attempt_count + 1
         WHERE id = $1
         RETURNING *`,
        [jobId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `AI job ${jobId} not found`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Complete a job successfully
   */
  complete: async (jobId: string): Promise<ServiceResult<AIJob>> => {
    try {
      const result = await db.query<AIJob>(
        `UPDATE ai_jobs
         SET status = 'COMPLETED',
             completed_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [jobId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `AI job ${jobId} not found`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Mark job as failed
   */
  fail: async (jobId: string, errorMessage: string): Promise<ServiceResult<AIJob>> => {
    try {
      const jobResult = await db.query<AIJob>(
        'SELECT * FROM ai_jobs WHERE id = $1',
        [jobId]
      );
      
      if (jobResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `AI job ${jobId} not found`,
          },
        };
      }
      
      const job = jobResult.rows[0];
      const newStatus: AIJobStatus = job.attempt_count < job.max_attempts ? 'PENDING' : 'FAILED';
      
      const result = await db.query<AIJob>(
        `UPDATE ai_jobs
         SET status = $1,
             last_error = $2,
             completed_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [newStatus, errorMessage, jobId]
      );
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Mark job as timed out
   */
  timeout: async (jobId: string): Promise<ServiceResult<AIJob>> => {
    try {
      const result = await db.query<AIJob>(
        `UPDATE ai_jobs
         SET status = 'TIMED_OUT',
             completed_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [jobId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `AI job ${jobId} not found`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Kill a job (admin action)
   */
  kill: async (jobId: string): Promise<ServiceResult<AIJob>> => {
    try {
      const result = await db.query<AIJob>(
        `UPDATE ai_jobs
         SET status = 'KILLED',
             completed_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [jobId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `AI job ${jobId} not found`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get job by ID
   */
  getById: async (jobId: string): Promise<ServiceResult<AIJob>> => {
    try {
      const result = await db.query<AIJob>(
        'SELECT * FROM ai_jobs WHERE id = $1',
        [jobId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `AI job ${jobId} not found`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
};

export default AIJobService;
