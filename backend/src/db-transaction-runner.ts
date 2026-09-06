export interface TransactionClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(destroy?: boolean | Error): Promise<void> | void;
}

export interface TransactionQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export type TransactionQueryFn = <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
) => Promise<TransactionQueryResult<T>>;

type TransactionPhase = 'BEGIN_ATTEMPTED' | 'ACTIVE' | 'COMMIT_ATTEMPTED' | 'CLOSED';

export interface RunTransactionOptions<T> {
  client: TransactionClient;
  beginStatement: 'BEGIN' | 'BEGIN ISOLATION LEVEL SERIALIZABLE';
  execute: (query: TransactionQueryFn) => Promise<T>;
  onRollbackFailure?: (evidence: { originalError: unknown; rollbackError: unknown }) => void;
  onReleaseFailure?: (evidence: {
    operationError: unknown;
    releaseError: unknown;
    destroyClient: boolean;
  }) => void;
}

/**
 * Run one transaction and return the physical session to the pool only when its
 * state is known. BEGIN and COMMIT failures are ambiguous: no later statement
 * is sent on that session and release(true) destroys it. A callback failure may
 * reuse the session only after ROLLBACK is positively acknowledged.
 */
export async function runTransactionOnClient<T>(options: RunTransactionOptions<T>): Promise<T> {
  const { client, beginStatement, execute, onRollbackFailure, onReleaseFailure } = options;
  let phase: TransactionPhase = 'BEGIN_ATTEMPTED';
  let destroyClient = false;
  let operationFailed = false;
  let operationError: unknown;
  let operationResult: T | undefined;

  const transactionQuery: TransactionQueryFn = async <R = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<TransactionQueryResult<R>> => {
    const result = await client.query(sql, params);
    return {
      rows: result.rows as R[],
      rowCount: result.rowCount ?? 0,
    };
  };

  try {
    await client.query(beginStatement);
    phase = 'ACTIVE';

    operationResult = await execute(transactionQuery);

    phase = 'COMMIT_ATTEMPTED';
    await client.query('COMMIT');
    phase = 'CLOSED';
  } catch (originalError) {
    operationFailed = true;
    operationError = originalError;
    if (phase === 'ACTIVE') {
      try {
        await client.query('ROLLBACK');
        phase = 'CLOSED';
      } catch (rollbackError) {
        destroyClient = true;
        try {
          onRollbackFailure?.({ originalError, rollbackError });
        } catch {
          // Diagnostic callbacks must never replace the transaction error.
        }
      }
    } else if (phase !== 'CLOSED') {
      // BEGIN/COMMIT acknowledgement is unknown. Sending another statement or
      // returning this physical session to the pool would be unsafe.
      destroyClient = true;
    }
  }

  let releaseFailed = false;
  let releaseError: unknown;
  try {
    await client.release(destroyClient);
  } catch (caughtReleaseError) {
    releaseFailed = true;
    releaseError = caughtReleaseError;
    if (operationFailed) {
      try {
        onReleaseFailure?.({
          operationError,
          releaseError: caughtReleaseError,
          destroyClient,
        });
      } catch {
        // Preserve the transaction error even when diagnostics also fail.
      }
    }
  }

  if (operationFailed) throw operationError;
  if (releaseFailed) throw releaseError;
  return operationResult as T;
}
