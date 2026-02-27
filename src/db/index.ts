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

export const getSql = () => {};
export const transaction = async () => {};
export const safeSql = () => {};
export const sql = () => {};
export const isDatabaseAvailable = () => false;

/**
 * Type alias for a postgres.js tagged-template transaction callback parameter.
 * Use in service methods that accept a transaction: `async (tx: SqlTx) => { ... }`
 */
export type SqlTx = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
