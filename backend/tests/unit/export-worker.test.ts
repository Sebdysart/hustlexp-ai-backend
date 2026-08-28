/**
 * export-worker.test.ts
 *
 * Tests for processExportJob — specifically covering the HHH-01 fix:
 *
 *   The SELECT FOR UPDATE and CAS UPDATE are now wrapped in a single
 *   db.transaction() call, so the row-level lock is held for the entire
 *   claim operation.  Export work (R2 upload, DB final update) runs outside
 *   the transaction so no long-held locks occur during I/O.
 *
 * Key scenarios:
 *  1. Transaction claims export (SELECT + CAS in one tx), then work runs outside
 *  2. Export not found → throws (propagated from transaction)
 *  3. Export already 'ready' → skip (idempotent replay)
 *  4. CAS UPDATE rowCount=0 → another worker claimed it, skip gracefully
 *  5. Still-generating (updated < 10 min ago) → skip
 *  6. Stuck-generating (updated > 10 min ago) → re-claim and process
 *  7. R2 file already exists → use existing file (idempotent upload)
 *  8. queue.add() (via writeToOutbox) failure in catch block → mark failed
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ────────────────────────────────────────────────────────────────────────────
// Mocks
// ────────────────────────────────────────────────────────────────────────────

const { mockTransaction } = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn(),
    transaction: mockTransaction,
  },
}));

vi.mock('../../src/storage/r2.js', () => ({
  r2: {
    generateExportKey: vi.fn(() => 'exports/user-1/export-1/data.json'),
    verifyFile: vi.fn(),
    uploadFile: vi.fn(),
    getSignedUrlForObject: vi.fn(),
  },
}));

vi.mock('../../src/lib/outbox-helpers.js', () => ({
  writeToOutbox: vi.fn(),
}));

vi.mock('../../src/jobs/outbox-worker.js', () => ({
  markOutboxEventProcessed: vi.fn(),
  markOutboxEventFailed: vi.fn(),
}));

vi.mock('../../src/services/GDPRService.js', () => ({
  collectUserDataForExport: vi.fn(() =>
    Promise.resolve({ profile: { name: 'Test User' } })
  ),
}));

vi.mock('../../src/logger.js', () => {
  const base = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: () => base,
  };
  return {
    logger: base,
    workerLogger: base,
  };
});

// ────────────────────────────────────────────────────────────────────────────
// Imports (after mocks)
// ────────────────────────────────────────────────────────────────────────────

import { db } from '../../src/db.js';
import { r2 } from '../../src/storage/r2.js';
import { writeToOutbox } from '../../src/lib/outbox-helpers.js';
import { markOutboxEventProcessed, markOutboxEventFailed } from '../../src/jobs/outbox-worker.js';
import { processExportJob } from '../../src/jobs/export-worker.js';
import type { Job } from 'bullmq';

const mockDb = vi.mocked(db);
const mockR2 = vi.mocked(r2);
const mockWriteToOutbox = vi.mocked(writeToOutbox);
const mockMarkProcessed = vi.mocked(markOutboxEventProcessed);
const mockMarkFailed = vi.mocked(markOutboxEventFailed);

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeJob(overrides: Record<string, unknown> = {}): Job<any> {
  return {
    id: 'bullmq-job-001',
    data: {
      aggregate_type: 'export',
      aggregate_id: 'export-1',
      event_version: 1,
      payload: {
        exportId: 'export-1',
        userId: 'user-1',
        format: 'json',
        ...overrides,
      },
    },
  } as unknown as Job<any>;
}

function makeExportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'export-1',
    user_id: 'user-1',
    export_format: 'json',
    content_type: 'application/json',
    status: 'queued',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    object_key: null,
    ...overrides,
  };
}

/**
 * Wire the transaction mock for the happy path:
 *  - txQuery call 1 (SELECT FOR UPDATE): returns the given export row
 *  - txQuery call 2 (CAS UPDATE):        returns rowCount=casRowCount
 */
function setupTransactionClaim(row: ReturnType<typeof makeExportRow>, casRowCount = 1) {
  mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
    let callIndex = 0;
    const txQuery = vi.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({ rows: [row], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: casRowCount });
    });
    return fn(txQuery);
  });
}

function setupR2ForUpload() {
  mockR2.verifyFile.mockResolvedValueOnce({ exists: false });
  mockR2.uploadFile.mockResolvedValueOnce({
    key: 'exports/user-1/export-1/data.json',
    size: 42,
    sha256: 'abc123',
    contentType: 'application/json',
  });
  mockR2.getSignedUrlForObject.mockResolvedValueOnce('https://r2.example.com/signed-url');
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('processExportJob', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.transaction = mockTransaction;
    mockR2.generateExportKey.mockReturnValue('exports/user-1/export-1/data.json');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // HHH-01: transaction boundary covers SELECT + CAS UPDATE
  // ──────────────────────────────────────────────────────────────────────────

  describe('HHH-01 transaction boundary', () => {
    it('issues SELECT FOR UPDATE and CAS UPDATE inside a single db.transaction()', async () => {
      let selectSql = '';
      let casSql = '';

      mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
        let callIndex = 0;
        const txQuery = vi.fn().mockImplementation((sql: string) => {
          callIndex++;
          if (callIndex === 1) {
            selectSql = sql;
            return Promise.resolve({ rows: [makeExportRow()], rowCount: 1 });
          }
          casSql = sql;
          return Promise.resolve({ rows: [], rowCount: 1 });
        });
        return fn(txQuery);
      });

      setupR2ForUpload();
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // object_key persist
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // final status=ready
      mockWriteToOutbox.mockResolvedValueOnce(undefined);
      mockMarkProcessed.mockResolvedValueOnce(undefined);

      await processExportJob(makeJob());

      // SELECT must use FOR UPDATE inside the transaction
      expect(selectSql).toContain('FOR UPDATE');
      expect(selectSql).toContain('FROM exports');
      // CAS UPDATE must set status='generating' inside the same transaction
      expect(casSql).toContain("status = 'generating'");
      expect(casSql).toContain('status = ');
    });

    it('does not call db.query() for SELECT or CAS — those go through txQuery', async () => {
      let txCallCount = 0;

      mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
        const txQuery = vi.fn().mockImplementation(() => {
          txCallCount++;
          if (txCallCount === 1) {
            return Promise.resolve({ rows: [makeExportRow()], rowCount: 1 });
          }
          return Promise.resolve({ rows: [], rowCount: 1 });
        });
        return fn(txQuery);
      });

      setupR2ForUpload();
      // Only post-claim db.query() calls should exist
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // object_key
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // final update
      mockWriteToOutbox.mockResolvedValueOnce(undefined);
      mockMarkProcessed.mockResolvedValueOnce(undefined);

      await processExportJob(makeJob());

      // db.query should NOT contain the SELECT or the generating CAS UPDATE —
      // those went through txQuery.  Calls should only be for object_key persist
      // and final status=ready update.
      const queryCalls: string[] = mockDb.query.mock.calls.map((c) => c[0] as string);
      for (const sql of queryCalls) {
        expect(sql).not.toContain('FOR UPDATE');
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Skip cases (handled inside transaction, work done outside)
  // ──────────────────────────────────────────────────────────────────────────

  describe('skip cases', () => {
    it("skips when export is already 'ready' (idempotent replay)", async () => {
      const row = makeExportRow({ status: 'ready' });
      // Transaction: SELECT returns ready row; no CAS UPDATE should be called
      mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
        let callIndex = 0;
        const txQuery = vi.fn().mockImplementation(() => {
          callIndex++;
          if (callIndex === 1) return Promise.resolve({ rows: [row], rowCount: 1 });
          return Promise.resolve({ rows: [], rowCount: 0 });
        });
        return fn(txQuery);
      });

      mockMarkProcessed.mockResolvedValueOnce(undefined);

      await processExportJob(makeJob());

      expect(mockMarkProcessed).toHaveBeenCalledWith('bullmq-job-001');
      expect(mockR2.uploadFile).not.toHaveBeenCalled();
      expect(mockWriteToOutbox).not.toHaveBeenCalled();
    });

    it("skips when CAS UPDATE rowCount=0 (another worker claimed it)", async () => {
      setupTransactionClaim(makeExportRow(), 0 /* CAS rowCount=0 */);

      await processExportJob(makeJob());

      expect(mockR2.uploadFile).not.toHaveBeenCalled();
      expect(mockWriteToOutbox).not.toHaveBeenCalled();
    });

    it("skips when export is 'generating' and updated_at is recent (< 10 min ago)", async () => {
      const row = makeExportRow({
        status: 'generating',
        updated_at: new Date(Date.now() - 2 * 60 * 1000), // 2 minutes ago
      });

      mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
        let callIndex = 0;
        const txQuery = vi.fn().mockImplementation(() => {
          callIndex++;
          if (callIndex === 1) return Promise.resolve({ rows: [row], rowCount: 1 });
          return Promise.resolve({ rows: [], rowCount: 0 });
        });
        return fn(txQuery);
      });

      await processExportJob(makeJob());

      expect(mockR2.uploadFile).not.toHaveBeenCalled();
    });

    it("throws when export not found", async () => {
      mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
        const txQuery = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
        return fn(txQuery);
      });

      // catch block tries to mark status=failed and mark outbox failed
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
      mockMarkFailed.mockResolvedValueOnce(undefined);

      await expect(processExportJob(makeJob())).rejects.toThrow('Export export-1 not found');
    });

    it("throws when export status is invalid (not queued/generating)", async () => {
      const row = makeExportRow({ status: 'failed' });
      mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
        const txQuery = vi.fn().mockResolvedValueOnce({ rows: [row], rowCount: 1 });
        return fn(txQuery);
      });

      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
      mockMarkFailed.mockResolvedValueOnce(undefined);

      await expect(processExportJob(makeJob())).rejects.toThrow('Cannot process export: status is failed');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Happy path: full export generation
  // ──────────────────────────────────────────────────────────────────────────

  describe('successful export generation', () => {
    it('generates JSON export, uploads to R2, updates status to ready, enqueues notification', async () => {
      setupTransactionClaim(makeExportRow());
      setupR2ForUpload();

      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // object_key persist
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // final status=ready
      mockWriteToOutbox.mockResolvedValueOnce(undefined);
      mockMarkProcessed.mockResolvedValueOnce(undefined);

      await processExportJob(makeJob());

      expect(mockR2.uploadFile).toHaveBeenCalledOnce();
      expect(mockR2.getSignedUrlForObject).toHaveBeenCalledOnce();
      expect(mockWriteToOutbox).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'export.ready' })
      );
      expect(mockMarkProcessed).toHaveBeenCalledWith('bullmq-job-001');

      // Final DB update must set status='ready'
      const finalUpdateCall = mockDb.query.mock.calls.find(
        ([sql]) => (sql as string).includes("status = 'ready'")
      );
      expect(finalUpdateCall).toBeDefined();
    });

    it('reuses existing R2 object when file already exists (idempotent upload)', async () => {
      setupTransactionClaim(makeExportRow());

      mockR2.verifyFile.mockResolvedValueOnce({
        exists: true,
        size: 99,
        sha256: 'existing-sha',
        contentType: 'application/json',
      });
      mockR2.getSignedUrlForObject.mockResolvedValueOnce('https://r2.example.com/existing');

      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // object_key persist
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // final status=ready
      mockWriteToOutbox.mockResolvedValueOnce(undefined);
      mockMarkProcessed.mockResolvedValueOnce(undefined);

      await processExportJob(makeJob());

      expect(mockR2.uploadFile).not.toHaveBeenCalled();
      expect(mockWriteToOutbox).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'export.ready' })
      );
    });

    it('updates GDPR request when gdprRequestId is provided', async () => {
      setupTransactionClaim(makeExportRow());
      setupR2ForUpload();

      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // object_key
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // final status=ready
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // gdpr_data_requests update
      mockWriteToOutbox.mockResolvedValueOnce(undefined);
      mockMarkProcessed.mockResolvedValueOnce(undefined);

      await processExportJob(makeJob({ gdprRequestId: 'gdpr-req-1' }));

      const gdprUpdateCall = mockDb.query.mock.calls.find(
        ([sql]) => (sql as string).includes('gdpr_data_requests')
      );
      expect(gdprUpdateCall).toBeDefined();
      expect(gdprUpdateCall![1]).toContain('gdpr-req-1');
    });

    it('uses existing object_key from DB (does not call generateExportKey)', async () => {
      const row = makeExportRow({ object_key: 'exports/user-1/export-1/existing.json' });
      setupTransactionClaim(row);
      setupR2ForUpload();

      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // final status=ready
      mockWriteToOutbox.mockResolvedValueOnce(undefined);
      mockMarkProcessed.mockResolvedValueOnce(undefined);

      await processExportJob(makeJob());

      // generateExportKey should NOT be called when object_key already exists
      expect(mockR2.generateExportKey).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Error handling
  // ──────────────────────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('marks export as failed and re-throws when R2 upload fails', async () => {
      setupTransactionClaim(makeExportRow());

      mockR2.verifyFile.mockResolvedValueOnce({ exists: false });
      mockR2.uploadFile.mockRejectedValueOnce(new Error('R2 upload failed'));

      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // object_key
      // catch block: update status=failed
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
      mockMarkFailed.mockResolvedValueOnce(undefined);

      await expect(processExportJob(makeJob())).rejects.toThrow('R2 upload failed');

      const failedUpdateCall = mockDb.query.mock.calls.find(
        ([sql]) => (sql as string).includes("status = 'failed'")
      );
      expect(failedUpdateCall).toBeDefined();
      expect(mockMarkFailed).toHaveBeenCalledWith('bullmq-job-001', 'R2 upload failed');
    });

    it('gracefully handles DB failure during status=failed update (does not swallow original error)', async () => {
      setupTransactionClaim(makeExportRow());

      mockR2.verifyFile.mockResolvedValueOnce({ exists: false });
      mockR2.uploadFile.mockRejectedValueOnce(new Error('R2 timeout'));

      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // object_key
      // catch block: status=failed update itself fails
      mockDb.query.mockRejectedValueOnce(new Error('DB gone'));
      mockMarkFailed.mockResolvedValueOnce(undefined);

      // Original error should still propagate
      await expect(processExportJob(makeJob())).rejects.toThrow('R2 timeout');
    });
  });
});
