/**
 * Base Repository Pattern
 *
 * Provides a standard interface for data access, decoupling services from
 * direct database queries. Supports transaction injection via QueryFn.
 *
 * @see ARCHITECTURE.md
 */

import { db, type QueryFn, type QueryResult } from '../db';

/**
 * Context for repository operations.
 * Pass a transaction-scoped query function to run within a transaction.
 */
export interface RepositoryContext {
  query?: QueryFn;
}

/**
 * Abstract base repository with common CRUD operations.
 * Subclasses define the table name and implement domain-specific queries.
 */
export abstract class BaseRepository<T, ID = string> {
  protected abstract readonly tableName: string;

  /**
   * Get the query function — uses transaction query if provided, otherwise default db.query.
   */
  protected getQuery(ctx?: RepositoryContext): QueryFn {
    return ctx?.query ?? db.query;
  }

  /**
   * Find a single record by primary key.
   */
  async findById(id: ID, ctx?: RepositoryContext): Promise<T | null> {
    const query = this.getQuery(ctx);
    const result = await query<T>(
      `SELECT * FROM ${this.tableName} WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Check if a record exists by primary key.
   */
  async exists(id: ID, ctx?: RepositoryContext): Promise<boolean> {
    const query = this.getQuery(ctx);
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM ${this.tableName} WHERE id = $1) as exists`,
      [id]
    );
    return result.rows[0]?.exists ?? false;
  }

  /**
   * Delete a record by primary key. Returns true if a row was deleted.
   */
  async deleteById(id: ID, ctx?: RepositoryContext): Promise<boolean> {
    const query = this.getQuery(ctx);
    const result = await query(
      `DELETE FROM ${this.tableName} WHERE id = $1`,
      [id]
    );
    return result.rowCount > 0;
  }

  /**
   * Count all records in the table, optionally with a WHERE clause.
   */
  async count(
    where?: string,
    params?: unknown[],
    ctx?: RepositoryContext
  ): Promise<number> {
    const query = this.getQuery(ctx);
    const sql = where
      ? `SELECT COUNT(*)::int as count FROM ${this.tableName} WHERE ${where}`
      : `SELECT COUNT(*)::int as count FROM ${this.tableName}`;
    const result = await query<{ count: number }>(sql, params);
    return result.rows[0]?.count ?? 0;
  }
}
