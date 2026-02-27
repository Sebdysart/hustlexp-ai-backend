export const getSql = () => {}; export const transaction = async () => {}; export const safeSql = () => {}; export const sql = () => {}; export const isDatabaseAvailable = () => false;

/**
 * Type alias for a postgres.js tagged-template transaction callback parameter.
 * Use in service methods that accept a transaction: `async (tx: SqlTx) => { ... }`
 */
export type SqlTx = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
