/** Driver-neutral database contracts shared by authority and application code. */
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export type QueryFn = <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
) => Promise<QueryResult<T>>;
