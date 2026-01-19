export declare const sql: import("@neondatabase/serverless").NeonQueryFunction<false, false> | null;
/**
 * Execute a function within a transaction
 */
export declare function transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
/**
 * Execute a raw query with parameters
 */
export declare function query<T>(queryText: string, params?: unknown[]): Promise<T[]>;
/**
 * Check if database is available
 */
export declare function isDatabaseAvailable(): boolean;
/**
 * Test database connection
 */
export declare function testConnection(): Promise<boolean>;
export declare const db: {
    sql: import("@neondatabase/serverless").NeonQueryFunction<false, false> | null;
    query: typeof query;
    isDatabaseAvailable: typeof isDatabaseAvailable;
    testConnection: typeof testConnection;
};
export declare function getSql(): import("@neondatabase/serverless").NeonQueryFunction<false, false>;
export declare const safeSql: import("@neondatabase/serverless").NeonQueryFunction<false, false>;
//# sourceMappingURL=index.d.ts.map