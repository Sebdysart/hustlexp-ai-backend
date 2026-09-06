import { describe, expect, it, vi } from 'vitest';

import { runTransactionOnClient, type TransactionClient } from '../../src/db-transaction-runner.js';

function createClient(
  queryImplementation: TransactionClient['query']
): TransactionClient & { release: ReturnType<typeof vi.fn> } {
  return {
    query: queryImplementation,
    release: vi.fn(),
  };
}

describe('runTransactionOnClient', () => {
  it('commits and returns a positively closed session to the pool', async () => {
    const statements: string[] = [];
    const client = createClient(async (sql) => {
      statements.push(sql);
      return { rows: sql === 'SELECT 1' ? [{ value: 1 }] : [], rowCount: 1 };
    });

    await expect(
      runTransactionOnClient({
        client,
        beginStatement: 'BEGIN ISOLATION LEVEL SERIALIZABLE',
        execute: async (query) => (await query<{ value: number }>('SELECT 1')).rows[0]!.value,
      })
    ).resolves.toBe(1);

    expect(statements).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', 'SELECT 1', 'COMMIT']);
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('preserves a callback error and reuses the session only after acknowledged rollback', async () => {
    const originalError = new Error('callback failed');
    const statements: string[] = [];
    const client = createClient(async (sql) => {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    });

    await expect(
      runTransactionOnClient({
        client,
        beginStatement: 'BEGIN',
        execute: async () => {
          throw originalError;
        },
      })
    ).rejects.toBe(originalError);

    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('destroys the session when rollback fails without masking the callback error', async () => {
    const originalError = new Error('callback failed');
    const rollbackError = new Error('connection lost during rollback');
    const onRollbackFailure = vi.fn();
    const client = createClient(async (sql) => {
      if (sql === 'ROLLBACK') throw rollbackError;
      return { rows: [], rowCount: 0 };
    });

    await expect(
      runTransactionOnClient({
        client,
        beginStatement: 'BEGIN',
        execute: async () => {
          throw originalError;
        },
        onRollbackFailure,
      })
    ).rejects.toBe(originalError);

    expect(onRollbackFailure).toHaveBeenCalledWith({ originalError, rollbackError });
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('destroys the session and sends no rollback after ambiguous BEGIN failure', async () => {
    const beginError = new Error('begin acknowledgement unknown');
    const statements: string[] = [];
    const client = createClient(async (sql) => {
      statements.push(sql);
      throw beginError;
    });

    await expect(
      runTransactionOnClient({
        client,
        beginStatement: 'BEGIN',
        execute: vi.fn(),
      })
    ).rejects.toBe(beginError);

    expect(statements).toEqual(['BEGIN']);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('destroys the session and sends no rollback after ambiguous COMMIT failure', async () => {
    const commitError = new Error('commit acknowledgement unknown');
    const statements: string[] = [];
    const client = createClient(async (sql) => {
      statements.push(sql);
      if (sql === 'COMMIT') throw commitError;
      return { rows: [], rowCount: 0 };
    });

    await expect(
      runTransactionOnClient({
        client,
        beginStatement: 'BEGIN ISOLATION LEVEL SERIALIZABLE',
        execute: async () => 'result-never-returned',
      })
    ).rejects.toBe(commitError);

    expect(statements).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', 'COMMIT']);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('does not let a failing diagnostic callback replace the original error', async () => {
    const originalError = new Error('callback failed');
    const client = createClient(async (sql) => {
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return { rows: [], rowCount: 0 };
    });

    await expect(
      runTransactionOnClient({
        client,
        beginStatement: 'BEGIN',
        execute: async () => {
          throw originalError;
        },
        onRollbackFailure: () => {
          throw new Error('logger failed');
        },
      })
    ).rejects.toBe(originalError);

    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('preserves the operation error when releasing the session also fails', async () => {
    const originalError = new Error('callback failed');
    const releaseError = new Error('pool release failed');
    const onReleaseFailure = vi.fn();
    const client = createClient(async () => ({ rows: [], rowCount: 0 }));
    client.release.mockImplementation(() => {
      throw releaseError;
    });

    await expect(
      runTransactionOnClient({
        client,
        beginStatement: 'BEGIN',
        execute: async () => {
          throw originalError;
        },
        onReleaseFailure,
      })
    ).rejects.toBe(originalError);

    expect(onReleaseFailure).toHaveBeenCalledWith({
      operationError: originalError,
      releaseError,
      destroyClient: false,
    });
  });

  it('surfaces a release failure when the transaction itself succeeded', async () => {
    const releaseError = new Error('pool release failed');
    const client = createClient(async () => ({ rows: [], rowCount: 0 }));
    client.release.mockImplementation(() => {
      throw releaseError;
    });

    await expect(
      runTransactionOnClient({
        client,
        beginStatement: 'BEGIN',
        execute: async () => 'committed',
      })
    ).rejects.toBe(releaseError);
  });
});
