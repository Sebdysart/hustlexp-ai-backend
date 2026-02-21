/**
 * Task Repository
 *
 * Data access layer for tasks table. Encapsulates all task-related SQL
 * so services never write raw queries directly.
 */

import { BaseRepository, type RepositoryContext } from './BaseRepository';
import type { Task, TaskState } from '../types';

export class TaskRepository extends BaseRepository<Task> {
  protected readonly tableName = 'tasks';

  /**
   * Find tasks by poster with optional state filter.
   */
  async findByPoster(
    posterId: string,
    state?: string,
    ctx?: RepositoryContext
  ): Promise<Task[]> {
    const query = this.getQuery(ctx);
    if (state) {
      const result = await query<Task>(
        `SELECT * FROM ${this.tableName} WHERE poster_id = $1 AND state = $2 ORDER BY created_at DESC`,
        [posterId, state]
      );
      return result.rows;
    }
    const result = await query<Task>(
      `SELECT * FROM ${this.tableName} WHERE poster_id = $1 ORDER BY created_at DESC`,
      [posterId]
    );
    return result.rows;
  }

  /**
   * Find tasks assigned to a worker with optional state filter.
   */
  async findByWorker(
    workerId: string,
    state?: string,
    ctx?: RepositoryContext
  ): Promise<Task[]> {
    const query = this.getQuery(ctx);
    if (state) {
      const result = await query<Task>(
        `SELECT * FROM ${this.tableName} WHERE worker_id = $1 AND state = $2 ORDER BY created_at DESC`,
        [workerId, state]
      );
      return result.rows;
    }
    const result = await query<Task>(
      `SELECT * FROM ${this.tableName} WHERE worker_id = $1 ORDER BY created_at DESC`,
      [workerId]
    );
    return result.rows;
  }

  /**
   * Find open tasks with pagination (for task feed).
   */
  async findOpen(
    limit: number = 20,
    offset: number = 0,
    ctx?: RepositoryContext
  ): Promise<Task[]> {
    const query = this.getQuery(ctx);
    const result = await query<Task>(
      `SELECT * FROM ${this.tableName} WHERE state = 'OPEN' ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows;
  }

  /**
   * Update task state. Returns the updated task or null if not found.
   */
  async updateState(
    taskId: string,
    newState: TaskState,
    ctx?: RepositoryContext
  ): Promise<Task | null> {
    const query = this.getQuery(ctx);
    const result = await query<Task>(
      `UPDATE ${this.tableName} SET state = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [newState, taskId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Assign a worker to a task.
   */
  async assignWorker(
    taskId: string,
    workerId: string,
    ctx?: RepositoryContext
  ): Promise<Task | null> {
    const query = this.getQuery(ctx);
    const result = await query<Task>(
      `UPDATE ${this.tableName} SET worker_id = $1, state = 'ACCEPTED', accepted_at = NOW(), updated_at = NOW() WHERE id = $2 RETURNING *`,
      [workerId, taskId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Create a new task. Returns the created task.
   */
  async create(
    data: {
      id: string;
      poster_id: string;
      title: string;
      description: string;
      price: number;
      requirements?: string;
      location?: string;
      category?: string;
      mode?: string;
      requires_proof?: boolean;
      deadline?: Date;
    },
    ctx?: RepositoryContext
  ): Promise<Task> {
    const query = this.getQuery(ctx);
    const result = await query<Task>(
      `INSERT INTO ${this.tableName} (
        id, poster_id, title, description, price, requirements,
        location, category, mode, requires_proof, deadline, state, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'OPEN', NOW(), NOW())
      RETURNING *`,
      [
        data.id,
        data.poster_id,
        data.title,
        data.description,
        data.price,
        data.requirements ?? null,
        data.location ?? null,
        data.category ?? null,
        data.mode ?? 'STANDARD',
        data.requires_proof ?? true,
        data.deadline ?? null,
      ]
    );
    return result.rows[0];
  }
}

/** Singleton instance */
export const taskRepository = new TaskRepository();
