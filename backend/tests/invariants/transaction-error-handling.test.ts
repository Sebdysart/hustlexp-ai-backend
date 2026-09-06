import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';

describe('Transaction Error Handling - Structural Verification', () => {
  let dbSource: string;
  let runnerSource: string;
  let planeSource: string;
  let disposableSource: string;

  beforeAll(async () => {
    [dbSource, runnerSource, planeSource, disposableSource] = await Promise.all([
      readFile(join(process.cwd(), 'backend/src/db.ts'), 'utf-8'),
      readFile(join(process.cwd(), 'backend/src/db-transaction-runner.ts'), 'utf-8'),
      readFile(join(process.cwd(), 'backend/src/jobs/runtime-database-data-plane.ts'), 'utf-8'),
      readFile(join(process.cwd(), 'backend/src/test/disposable-database-runtime.ts'), 'utf-8'),
    ]);
  });

  it('routes both facade transaction modes through the installed authority and guarded session executor', () => {
    expect(dbSource).toContain('runtime().transaction(fn)');
    expect(dbSource).toContain('runtime().serializableTransaction(fn)');
    expect(planeSource).toContain("const BEGIN_READ_WRITE = 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'");
    expect(planeSource).toContain("const BEGIN_SERIALIZABLE = 'BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE'");
    expect(planeSource).toContain('executeInTransaction(this, BEGIN_READ_WRITE, true, callback)');
    expect(planeSource).toContain('executeInTransaction(this, BEGIN_SERIALIZABLE, true, callback)');
    expect(planeSource).toContain('return cleanupFailure(session, phase, error)');
    expect(disposableSource).toContain("transaction('BEGIN', callback)");
    expect(disposableSource).toContain("transaction('BEGIN ISOLATION LEVEL SERIALIZABLE', callback)");
    expect(disposableSource.match(/runTransactionOnClient\(\{/g)).toHaveLength(1);
  });

  it('destroys sessions after ambiguous BEGIN, COMMIT, or ROLLBACK acknowledgement', () => {
    expect(runnerSource).toContain("phase = 'COMMIT_ATTEMPTED'");
    expect(runnerSource).toContain("else if (phase !== 'CLOSED')");
    expect(runnerSource).toContain('destroyClient = true');
    expect(runnerSource).toContain('client.release(destroyClient)');
  });

  it('preserves the original error even if rollback or diagnostics fail', () => {
    expect(runnerSource).toContain('catch (rollbackError)');
    expect(runnerSource).toContain('onRollbackFailure?.({ originalError, rollbackError })');
    expect(runnerSource).toContain('if (operationFailed) throw operationError');
    expect(runnerSource).not.toContain('throw rollbackError');
    expect(runnerSource).toContain('onReleaseFailure?.({');
    expect(runnerSource).toContain('releaseError: caughtReleaseError');
  });
});
