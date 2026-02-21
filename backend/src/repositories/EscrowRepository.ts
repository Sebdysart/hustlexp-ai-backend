/**
 * Escrow Repository
 *
 * Data access layer for escrow table. Encapsulates all escrow-related SQL
 * so services never write raw queries directly.
 *
 * INV-4: Escrow amount is immutable after creation (enforced by DB trigger).
 */

import { BaseRepository, type RepositoryContext } from './BaseRepository';
import type { Escrow, EscrowState } from '../types';

export class EscrowRepository extends BaseRepository<Escrow> {
  protected readonly tableName = 'escrow';

  /**
   * Find escrow by task ID.
   */
  async findByTaskId(
    taskId: string,
    ctx?: RepositoryContext
  ): Promise<Escrow | null> {
    const query = this.getQuery(ctx);
    const result = await query<Escrow>(
      `SELECT e.*, t.poster_id, t.worker_id
       FROM ${this.tableName} e
       JOIN tasks t ON t.id = e.task_id
       WHERE e.task_id = $1`,
      [taskId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Find escrows by state.
   */
  async findByState(
    state: EscrowState,
    limit: number = 50,
    ctx?: RepositoryContext
  ): Promise<Escrow[]> {
    const query = this.getQuery(ctx);
    const result = await query<Escrow>(
      `SELECT * FROM ${this.tableName} WHERE state = $1 ORDER BY created_at DESC LIMIT $2`,
      [state, limit]
    );
    return result.rows;
  }

  /**
   * Create a new escrow record. Returns the created escrow.
   */
  async create(
    data: {
      id: string;
      task_id: string;
      amount: number;
      stripe_payment_intent_id?: string;
    },
    ctx?: RepositoryContext
  ): Promise<Escrow> {
    const query = this.getQuery(ctx);
    const result = await query<Escrow>(
      `INSERT INTO ${this.tableName} (
        id, task_id, amount, stripe_payment_intent_id, state, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'PENDING', NOW(), NOW())
      RETURNING *`,
      [
        data.id,
        data.task_id,
        data.amount,
        data.stripe_payment_intent_id ?? null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Update escrow state. Returns the updated escrow or null if not found.
   * Note: amount is immutable (INV-4 enforced by DB trigger).
   */
  async updateState(
    escrowId: string,
    newState: EscrowState,
    ctx?: RepositoryContext
  ): Promise<Escrow | null> {
    const query = this.getQuery(ctx);
    const result = await query<Escrow>(
      `UPDATE ${this.tableName} SET state = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [newState, escrowId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Mark escrow as funded.
   */
  async markFunded(
    escrowId: string,
    stripePaymentIntentId: string,
    ctx?: RepositoryContext
  ): Promise<Escrow | null> {
    const query = this.getQuery(ctx);
    const result = await query<Escrow>(
      `UPDATE ${this.tableName} SET
        state = 'FUNDED',
        stripe_payment_intent_id = $1,
        funded_at = NOW(),
        updated_at = NOW()
      WHERE id = $2 RETURNING *`,
      [stripePaymentIntentId, escrowId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Release escrow to worker.
   */
  async markReleased(
    escrowId: string,
    stripeTransferId?: string,
    ctx?: RepositoryContext
  ): Promise<Escrow | null> {
    const query = this.getQuery(ctx);
    const result = await query<Escrow>(
      `UPDATE ${this.tableName} SET
        state = 'RELEASED',
        stripe_transfer_id = $1,
        released_at = NOW(),
        updated_at = NOW()
      WHERE id = $2 RETURNING *`,
      [stripeTransferId ?? null, escrowId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Lock escrow for dispute.
   */
  async lockForDispute(
    escrowId: string,
    ctx?: RepositoryContext
  ): Promise<Escrow | null> {
    return this.updateState(escrowId, 'LOCKED_DISPUTE', ctx);
  }

  /**
   * Get escrow history for a user (as poster).
   */
  async findByPoster(
    posterId: string,
    limit: number = 50,
    ctx?: RepositoryContext
  ): Promise<Escrow[]> {
    const query = this.getQuery(ctx);
    const result = await query<Escrow>(
      `SELECT e.*, t.poster_id, t.worker_id
       FROM ${this.tableName} e
       JOIN tasks t ON t.id = e.task_id
       WHERE t.poster_id = $1
       ORDER BY e.created_at DESC
       LIMIT $2`,
      [posterId, limit]
    );
    return result.rows;
  }
}

/** Singleton instance */
export const escrowRepository = new EscrowRepository();
