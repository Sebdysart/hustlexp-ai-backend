/**
 * Database module stub (test/development environment).
 *
 * PRODUCTION ISOLATION STRATEGY:
 *   The `transaction()` helper wraps `sql.begin()` from postgres.js, which
 *   defaults to READ COMMITTED isolation. To prevent concurrent escrow
 *   transitions from racing, EscrowStateMachine.transition() issues a
 *   `SELECT ... FOR UPDATE` on `money_state_lock` as the FIRST statement
 *   inside every transaction callback. This acquires a row-level exclusive
 *   lock for the duration of the transaction, serialising all concurrent
 *   transitions for the same taskId without requiring SERIALIZABLE isolation
 *   (which carries a higher retry overhead).
 *
 *   Isolation strategy: READ COMMITTED + FOR UPDATE row lock (not SERIALIZABLE).
 *   Comments in EscrowStateMachine.ts that previously said "serializable" have
 *   been updated to reflect this.
 *
 * NOTE: This file is a stub. In production it re-exports the postgres.js
 *       `sql` instance and a `transaction` wrapper. The SqlTx type below
 *       matches the postgres.js tagged-template function signature.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Type alias for a postgres.js tagged-template transaction callback parameter.
 * Use in service methods that accept a transaction: `async (tx: SqlTx) => { ... }`
 *
 * NOTE: Using `any[]` matches the postgres.js runtime behaviour where row shapes
 * are determined at query time. Strict types require explicit generic parameters
 * which are not used in this legacy src/ layer.
 *
 * The overload signatures support:
 * - Tagged template: tx`SELECT ...` (TemplateStringsArray as first arg)
 * - Helper syntax:   tx(values) for array interpolation in postgres.js
 */
export interface SqlTx {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]>;
  (values: unknown[]): any;
}

// Tagged-template stub that returns an empty array
function taggedTemplate(
  strings: TemplateStringsArray | unknown[],
  ..._values: unknown[]
): Promise<any[]> | any {
  if (Array.isArray(strings) && !('raw' in (strings as object))) {
    // Helper call: sql(array) — return the array as-is (postgres.js interpolation)
    return strings;
  }
  // Tagged template call: sql`...`
  return Promise.resolve([]);
}

// Extend with postgres.js extras used by some services
interface SqlTemplate extends SqlTx {
  unsafe: (query: string, params?: unknown[]) => Promise<any[]>;
}

const extendedSql: SqlTemplate = Object.assign(taggedTemplate as unknown as SqlTemplate, {
  unsafe: async (_query: string, _params?: unknown[]) => [] as any[],
});

export const sql: SqlTemplate = extendedSql;
export const safeSql: SqlTemplate = extendedSql;
export const getSql = (): SqlTemplate => extendedSql;
export const isDatabaseAvailable = (): boolean => false;
export const testConnection = async (): Promise<boolean> => false;

export const transaction = async <T>(
  callback: (tx: SqlTx) => Promise<T>
): Promise<T> => {
  return callback(taggedTemplate as unknown as SqlTx);
};
