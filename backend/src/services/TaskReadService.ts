import { db } from '../db.js';
import { taskLogger } from '../logger.js';
import type { ServiceResult, Task } from '../types.js';
import { ErrorCodes } from '../types.js';
import { buildTaskCreateRequestHash, type CreateTaskParams } from './TaskServiceShared.js';
const log = taskLogger.child({ service: 'TaskService' });

export const TaskReadService = {
getById: async (taskId: string): Promise<ServiceResult<Task>> => {
    try {
      const result = await db.query<Task>(
        'SELECT * FROM tasks WHERE id = $1',
        [taskId]
      );

      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Task ${taskId} not found`,
          },
        };
      }

      return { success: true, data: result.rows[0] };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'TaskService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },
getByPoster: async (
    posterId: string,
    options: { cursor?: string | null; limit?: number } = {}
  ): Promise<ServiceResult<{ tasks: Task[]; nextCursor: string | undefined }>> => {
    const { cursor, limit = 20 } = options;
    // Fetch one extra row to detect if there is a next page
    const fetchLimit = limit + 1;

    try {
      let result: Awaited<ReturnType<typeof db.query<Task>>>;
      if (cursor) {
        if (!cursor.includes('|')) {
          return {
            success: false,
            error: {
              code: 'BAD_REQUEST',
              message: 'Invalid cursor format',
            },
          };
        }
        const [cursorTs, cursorId] = cursor.split('|');
        result = await db.query<Task>(
          `SELECT * FROM tasks
           WHERE poster_id = $1
             AND (created_at, id) < ($2::timestamptz, $3::uuid)
           ORDER BY created_at DESC, id DESC
           LIMIT $4`,
          [posterId, cursorTs, cursorId, fetchLimit]
        );
      } else {
        result = await db.query<Task>(
          `SELECT * FROM tasks
           WHERE poster_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2`,
          [posterId, fetchLimit]
        );
      }

      const hasMore = result.rows.length > limit;
      const tasks = hasMore ? result.rows.slice(0, limit) : result.rows;
      const lastTask = tasks[tasks.length - 1] as Task & { created_at: string | Date };
      const nextCursor = hasMore
        ? `${new Date(lastTask.created_at).toISOString()}|${lastTask.id}`
        : undefined;

      return { success: true, data: { tasks, nextCursor } };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'TaskService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },
getByWorker: async (
    workerId: string,
    options: { cursor?: string | null; limit?: number } = {}
  ): Promise<ServiceResult<{ tasks: Task[]; nextCursor: string | undefined }>> => {
    const { cursor, limit = 20 } = options;
    const fetchLimit = limit + 1;

    try {
      let result: Awaited<ReturnType<typeof db.query<Task>>>;
      if (cursor) {
        if (!cursor.includes('|')) {
          return {
            success: false,
            error: {
              code: 'BAD_REQUEST',
              message: 'Invalid cursor format',
            },
          };
        }
        const [cursorTs, cursorId] = cursor.split('|');
        result = await db.query<Task>(
          `SELECT * FROM tasks
           WHERE worker_id = $1
             AND (created_at, id) < ($2::timestamptz, $3::uuid)
           ORDER BY created_at DESC, id DESC
           LIMIT $4`,
          [workerId, cursorTs, cursorId, fetchLimit]
        );
      } else {
        result = await db.query<Task>(
          `SELECT * FROM tasks
           WHERE worker_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2`,
          [workerId, fetchLimit]
        );
      }

      const hasMore = result.rows.length > limit;
      const tasks = hasMore ? result.rows.slice(0, limit) : result.rows;
      const lastTask = tasks[tasks.length - 1] as Task & { created_at: string | Date };
      const nextCursor = hasMore
        ? `${new Date(lastTask.created_at).toISOString()}|${lastTask.id}`
        : undefined;

      return { success: true, data: { tasks, nextCursor } };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'TaskService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },
listOpen: async (options: {
    limit?: number;
    offset?: number;
    category?: string;
  } = {}): Promise<ServiceResult<Task[]>> => {
    const { limit = 50, offset = 0, category } = options;

    try {
      // SCHEMA-DRIFT FIX (2026-06-12): the previous column list selected
      // trust_tier_required, expires_at, estimated_duration_minutes and is_remote
      // — none of which exist on the live tasks table — so this query threw on
      // every call and hustlers always got "A database error occurred". Select
      // only columns that exist in the live schema (verified against a live row).
      let sql = `
        SELECT id, title, description, price, state, category, location,
               template_slug, created_at, estimated_duration, requires_proof,
               deadline, expired_at
        FROM tasks
        WHERE state = 'OPEN'
      `;
      const params: unknown[] = [];

      if (category) {
        params.push(category);
        sql += ` AND category = $${params.length}`;
      }

      params.push(limit, offset);
      sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

      const result = await db.query<Task>(sql, params);
      return { success: true, data: result.rows };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'TaskService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },
lookupCreateRequest: async (
    params: CreateTaskParams
  ): Promise<ServiceResult<
    | { status: 'missing' }
    | { status: 'replay'; task: Task }
    | { status: 'conflict'; existingTaskId: string }
  >> => {
    if (!params.clientIdempotencyKey) {
      return { success: true, data: { status: 'missing' } };
    }
    try {
      const requestHash = buildTaskCreateRequestHash(params);
      const existing = await db.query<Task & { request_hash: string }>(
        `SELECT t.*, r.request_hash
         FROM task_create_requests r
         JOIN tasks t ON t.id = r.task_id
         WHERE r.poster_id = $1 AND r.idempotency_key = $2`,
        [params.posterId, params.clientIdempotencyKey]
      );
      if (!existing.rows[0]) {
        return { success: true, data: { status: 'missing' } };
      }
      if (existing.rows[0].request_hash !== requestHash) {
        return {
          success: true,
          data: { status: 'conflict', existingTaskId: existing.rows[0].id },
        };
      }
      const { request_hash: _requestHash, ...task } = existing.rows[0];
      void _requestHash;
      return { success: true, data: { status: 'replay', task } };
    } catch (cause) {
      log.error(
        { posterId: params.posterId, err: cause instanceof Error ? cause.message : String(cause) },
        'task.create idempotency preflight failed'
      );
      return {
        success: false,
        error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' },
      };
    }
  }
};
