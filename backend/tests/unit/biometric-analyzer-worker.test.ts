import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/services/BiometricVerificationService', () => ({
  BiometricVerificationService: { analyzeProofSubmission: vi.fn() },
}));

vi.mock('../../src/services/AdminNotificationHelper', () => ({
  notifyAdmins: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/PrivateMediaDeliveryService', () => ({
  issueSingleSystemMediaAccess: vi.fn(),
}));

vi.mock('../../src/logger', () => ({
  workerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { db } from '../../src/db';
import { processBiometricAnalysisJob } from '../../src/jobs/biometric-analyzer-worker';
import { BiometricVerificationService } from '../../src/services/BiometricVerificationService';
import { issueSingleSystemMediaAccess } from '../../src/services/PrivateMediaDeliveryService';

const mockDb = vi.mocked(db);
const mockService = vi.mocked(BiometricVerificationService);
const mockSystemMediaAccess = vi.mocked(issueSingleSystemMediaAccess);
const CANONICAL_STORAGE_KEY = 'media/proof/task-1/worker-1/receipt.jpg';
const SIGNED_PRIVATE_URL = 'https://private.example/proof.jpg?signature=system';

function canonicalProofRow(biometricAnalysis: string | null = null) {
  return {
    biometric_analysis: biometricAnalysis,
    task_id: 'task-1',
    storage_key: CANONICAL_STORAGE_KEY,
  };
}

function job() {
  return {
    data: {
      proof_id: 'proof-1',
      photo_url: 'https://example.com/proof.jpg',
    },
  } as never;
}

describe('biometric analyzer worker proof identity contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.mockReset();
    mockService.analyzeProofSubmission.mockReset();
    mockSystemMediaAccess.mockReset();
    mockSystemMediaAccess.mockResolvedValue({
      downloadUrl: SIGNED_PRIVATE_URL,
      expiresAt: '2026-07-21T12:05:00.000Z',
    });
  });

  it('checks replay state by canonical proof ID', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [canonicalProofRow('{"recommendation":"approve"}')],
      rowCount: 1,
    } as never);

    await expect(processBiometricAnalysisJob(job())).resolves.toBeUndefined();

    const [sql, values] = mockDb.query.mock.calls[0];
    expect(String(sql)).toMatch(/WHERE\s+p\.id\s*=\s*\$1/i);
    expect(values).toEqual(['proof-1']);
    expect(mockSystemMediaAccess).not.toHaveBeenCalled();
    expect(mockService.analyzeProofSubmission).not.toHaveBeenCalled();
  });

  it('does not retry a truthfully persisted provider-unavailable outcome', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [canonicalProofRow()], rowCount: 1 } as never);
    mockService.analyzeProofSubmission.mockResolvedValueOnce({
      success: false,
      error: {
        code: 'BIOMETRIC_PROVIDER_UNAVAILABLE',
        message: 'Biometric analysis is unavailable; human review is required.',
      },
    } as never);

    await expect(processBiometricAnalysisJob(job())).resolves.toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledOnce();
    expect(mockSystemMediaAccess).toHaveBeenCalledWith({
      taskId: 'task-1',
      purpose: 'PROOF',
      accessReason: 'BIOMETRIC_ANALYSIS',
      consumerId: 'proof-1',
      storageKey: CANONICAL_STORAGE_KEY,
    });
  });

  it('persists advisory metadata against the canonical proof ID', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [canonicalProofRow()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'signal-1' }], rowCount: 1 } as never);
    mockService.analyzeProofSubmission.mockResolvedValueOnce({
      success: true,
      data: {
        recommendation: 'approve',
        flags: [],
        scores: {
          liveness_score: 0.9,
          deepfake_score: 0.1,
          risk_level: 'LOW',
          provider: 'AWS_REKOGNITION',
        },
        reasoning: 'Advisory signal available',
      },
    } as never);

    await expect(processBiometricAnalysisJob(job())).resolves.toBeUndefined();

    expect(mockService.analyzeProofSubmission).toHaveBeenCalledWith(
      'proof-1',
      SIGNED_PRIVATE_URL,
      undefined,
    );
    expect(mockService.analyzeProofSubmission).not.toHaveBeenCalledWith(
      'proof-1',
      'https://example.com/proof.jpg',
      expect.anything(),
    );
    const metadataWrite = mockDb.query.mock.calls[1];
    expect(String(metadataWrite[0])).toMatch(/WHERE\s+proof_id\s*=\s*\$2/i);
    expect(metadataWrite[1]?.[1]).toBe('proof-1');
  });

  it('fails the job when metadata cannot resolve a canonical proof target', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [canonicalProofRow()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockService.analyzeProofSubmission.mockResolvedValueOnce({
      success: true,
      data: {
        recommendation: 'approve', flags: [],
        scores: { risk_level: 'LOW' }, reasoning: 'Advisory signal available',
      },
    } as never);

    await expect(processBiometricAnalysisJob(job()))
      .rejects.toThrow('PROOF_SIGNAL_TARGET_NOT_FOUND');
  });

  it('rejects an attacker-controlled queue URL when no receipt-backed media can be issued', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [canonicalProofRow()], rowCount: 1 } as never);
    mockSystemMediaAccess.mockResolvedValueOnce(null);

    await expect(processBiometricAnalysisJob(job()))
      .rejects.toThrow('PROOF_MEDIA_RECEIPT_REQUIRED');

    expect(mockService.analyzeProofSubmission).not.toHaveBeenCalled();
    expect(mockDb.query).toHaveBeenCalledOnce();
  });
});
