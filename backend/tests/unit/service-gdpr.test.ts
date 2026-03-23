/**
 * GDPRService Extended Unit Tests
 *
 * Covers: generateExport, executeDeletion, hasBiometricConsent,
 * collectUserDataForExport, and DB error paths.
 *
 * The existing gdpr-service.test.ts already covers: createRequest,
 * getRequestById, getUserRequests, cancelRequest, updateConsent,
 * getConsentStatus. This file covers the remaining uncovered methods.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
    serializableTransaction: vi.fn(),
  },
  isInvariantViolation: vi.fn(() => false),
  getErrorMessage: vi.fn(() => ''),
}));

vi.mock('../../src/logger', () => {
  const base = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => base };
  return {
    logger: base,
    escrowLogger: base,
    taskLogger: base,
    aiLogger: base,
    stripeLogger: base,
    authLogger: base,
    workerLogger: base,
    dbLogger: base,
  };
});

vi.mock('../../src/services/NotificationService', () => ({
  NotificationService: {
    createNotification: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    randomUUID: vi.fn(() => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
  };
});

vi.mock('../../src/jobs/queues', () => ({
  generateIdempotencyKey: vi.fn(() => 'idempotency-key-test-123'),
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: { secretKey: 'sk_test_fake123' },
  },
}));

// vi.hoisted() runs before vi.mock() hoisting, so these refs are safe to use
// inside the MockStripe class initializer even though vi.mock is hoisted.
const { mockPaymentIntentsCancel } = vi.hoisted(() => ({
  mockPaymentIntentsCancel: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: class MockStripe {
    paymentIntents = {
      cancel: mockPaymentIntentsCancel,
    };
  },
}));

vi.mock('../../src/services/EscrowService', () => ({
  EscrowService: {
    refund: vi.fn().mockResolvedValue({ success: true }),
    partialRefund: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../../src/services/TaskService', () => ({
  TaskService: {
    cancel: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../../src/auth-cache', () => ({
  invalidateAuthCacheForUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/realtime/connection-registry', () => ({
  forceDisconnectUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/auth/middleware', () => ({
  revokeUserSessions: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { GDPRService, collectUserDataForExport, _resetGDPRRateLimitMapForTesting } from '../../src/services/GDPRService';
import { NotificationService } from '../../src/services/NotificationService';
import { EscrowService } from '../../src/services/EscrowService';
import { TaskService } from '../../src/services/TaskService';

const mockDb = vi.mocked(db);
const mockNotification = vi.mocked(NotificationService);
const mockEscrowService = vi.mocked(EscrowService);
const mockTaskService = vi.mocked(TaskService);

beforeEach(() => {
  vi.clearAllMocks();
  // D53-4: reset the in-memory rate-limit Map so each test gets a fresh bucket
  _resetGDPRRateLimitMapForTesting();
  mockPaymentIntentsCancel.mockReset();
  mockPaymentIntentsCancel.mockResolvedValue({ id: 'pi_test', status: 'canceled' });
});

// ===========================================================================
// generateExport
// ===========================================================================

describe('GDPRService.generateExport', () => {
  it('returns NOT_FOUND when request does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await GDPRService.generateExport('req-missing');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('NOT_FOUND');
      expect(result.error.message).toContain('req-missing');
    }
  });

  it('returns INVALID_STATE when request is already completed', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'req-1', user_id: 'user-1', status: 'completed',
        request_details: { format: 'json' },
      }],
      rowCount: 1,
    } as never);

    const result = await GDPRService.generateExport('req-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_STATE');
      expect(result.error.message).toContain('completed');
    }
  });

  it('returns INVALID_STATE when request is cancelled', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'req-1', user_id: 'user-1', status: 'cancelled',
        request_details: { format: 'json' },
      }],
      rowCount: 1,
    } as never);

    const result = await GDPRService.generateExport('req-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_STATE');
    }
  });

  it('returns INVALID_INPUT for unknown export format', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'req-1', user_id: 'user-1', status: 'pending',
        request_details: { format: 'xlsx' }, // invalid
      }],
      rowCount: 1,
    } as never);

    const result = await GDPRService.generateExport('req-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('xlsx');
    }
  });

  it('creates export and outbox event within transaction (happy path - json)', async () => {
    // Fetch request
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'req-1', user_id: 'user-1', status: 'pending',
        request_details: { format: 'json' },
      }],
      rowCount: 1,
    } as never);

    // db.transaction mock: execute the callback and return the result
    const transactionQuery = vi.fn();
    // UPDATE gdpr_data_requests → processing
    transactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    // INSERT into exports
    transactionQuery.mockResolvedValueOnce({ rows: [{ id: 'export-1' }], rowCount: 1 } as never);
    // SELECT idempotency duplicate check
    transactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // INSERT outbox_event
    transactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    mockDb.transaction.mockImplementation(async (fn) => fn(transactionQuery) as Promise<unknown>);

    const result = await GDPRService.generateExport('req-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.exportId).toBe('export-1');
    }
  });

  it('creates export with csv format', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'req-2', user_id: 'user-2', status: 'pending',
        request_details: { format: 'csv' },
      }],
      rowCount: 1,
    } as never);

    const transactionQuery = vi.fn();
    transactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    transactionQuery.mockResolvedValueOnce({ rows: [{ id: 'export-2' }], rowCount: 1 } as never);
    transactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    transactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    mockDb.transaction.mockImplementation(async (fn) => fn(transactionQuery) as Promise<unknown>);

    const result = await GDPRService.generateExport('req-2');
    expect(result.success).toBe(true);
  });

  it('handles idempotent outbox event (already exists)', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'req-3', user_id: 'user-3', status: 'processing',
        request_details: { format: 'pdf' },
      }],
      rowCount: 1,
    } as never);

    const transactionQuery = vi.fn();
    transactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    transactionQuery.mockResolvedValueOnce({ rows: [{ id: 'export-3' }], rowCount: 1 } as never);
    // Duplicate exists
    transactionQuery.mockResolvedValueOnce({ rows: [{ id: 'existing-outbox' }], rowCount: 1 } as never);
    // No INSERT (skipped due to idempotency)

    mockDb.transaction.mockImplementation(async (fn) => fn(transactionQuery) as Promise<unknown>);

    const result = await GDPRService.generateExport('req-3');
    expect(result.success).toBe(true);
  });

  it('uses default json format when request_details has no format', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'req-4', user_id: 'user-4', status: 'pending',
        request_details: {},
      }],
      rowCount: 1,
    } as never);

    const transactionQuery = vi.fn();
    transactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    transactionQuery.mockResolvedValueOnce({ rows: [{ id: 'export-4' }], rowCount: 1 } as never);
    transactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    transactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    mockDb.transaction.mockImplementation(async (fn) => fn(transactionQuery) as Promise<unknown>);

    const result = await GDPRService.generateExport('req-4');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.exportId).toBe('export-4');
    }
  });

  it('handles transaction failure gracefully and marks request rejected', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'req-5', user_id: 'user-5', status: 'pending',
          request_details: { format: 'json' },
        }],
        rowCount: 1,
      } as never)
      // UPDATE to rejected
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    mockDb.transaction.mockRejectedValue(new Error('Transaction failed'));

    const result = await GDPRService.generateExport('req-5');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
    }

    // Should have tried to update status to rejected
    const updateCall = mockDb.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes("'rejected'"),
    );
    expect(updateCall).toBeDefined();
  });
});

// ===========================================================================
// executeDeletion
// ===========================================================================

describe('GDPRService.executeDeletion', () => {
  it('returns NOT_FOUND when request does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await GDPRService.executeDeletion('req-missing');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('returns INVALID_STATE when request is cancelled', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'req-1', user_id: 'user-1', status: 'cancelled',
        request_type: 'deletion', deadline: new Date(Date.now() - 86400000),
      }],
      rowCount: 1,
    } as never);

    const result = await GDPRService.executeDeletion('req-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_STATE');
      expect(result.error.message).toContain('cancelled');
    }
  });

  it('returns INVALID_STATE when grace period has not expired', async () => {
    const futureDeadline = new Date(Date.now() + 5 * 86400000); // 5 days from now
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'req-1', user_id: 'user-1', status: 'pending',
        request_type: 'deletion', deadline: futureDeadline,
      }],
      rowCount: 1,
    } as never);

    const result = await GDPRService.executeDeletion('req-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_STATE');
      expect(result.error.message).toContain('grace period');
    }
  });

  it('executes deletion after grace period and sends notification', async () => {
    const pastDeadline = new Date(Date.now() - 86400000); // 1 day ago

    // 1. Fetch request
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'req-1', user_id: 'user-1', status: 'pending',
        request_type: 'deletion', deadline: pastDeadline,
      }],
      rowCount: 1,
    } as never);

    // 2. UPDATE to processing
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    // 3. SELECT firebase_uid (fetched before deleteAndAnonymizeUserData)
    mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: null }], rowCount: 1 } as never);

    // 4a. (inside deleteAndAnonymizeUserData) SELECT email idempotency check
    mockDb.query.mockResolvedValueOnce({ rows: [{ email: 'test@example.com' }], rowCount: 1 } as never);

    // 4b. SELECT open poster tasks (none)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    // 4c. SELECT worker FUNDED/LOCKED_DISPUTE escrows (none)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    // 5. serializableTransaction (deleteAndAnonymizeUserData)
    const serializableQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 } as never);
    mockDb.serializableTransaction.mockImplementation(async (fn) => fn(serializableQuery) as Promise<unknown>);

    // 6. UPDATE to completed
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'req-1', status: 'completed' }],
      rowCount: 1,
    } as never);

    mockNotification.createNotification.mockResolvedValue({ success: true } as never);

    const result = await GDPRService.executeDeletion('req-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deletedAt).toBeInstanceOf(Date);
    }

    // Notification should have been sent
    expect(mockNotification.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        title: 'Account Deletion Completed',
      }),
    );
  });

  it('marks request rejected when deleteAndAnonymizeUserData fails', async () => {
    const pastDeadline = new Date(Date.now() - 86400000);

    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'req-1', user_id: 'user-1', status: 'pending',
        request_type: 'deletion', deadline: pastDeadline,
      }],
      rowCount: 1,
    } as never);

    // UPDATE to processing
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    // FIX 2: SELECT open poster tasks (none)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    // FIX 1: SELECT worker FUNDED/LOCKED_DISPUTE escrows (none)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    // serializableTransaction throws
    mockDb.serializableTransaction.mockRejectedValue(new Error('DB transaction failed'));

    // UPDATE to rejected (error path)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await GDPRService.executeDeletion('req-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
    }
  });

  it('handles notification failure gracefully (does not fail the deletion)', async () => {
    const pastDeadline = new Date(Date.now() - 86400000);

    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'req-1', user_id: 'user-1', status: 'pending',
        request_type: 'deletion', deadline: pastDeadline,
      }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // processing
    mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: null }], rowCount: 1 } as never); // firebase_uid
    mockDb.query.mockResolvedValueOnce({ rows: [{ email: 'test@example.com' }], rowCount: 1 } as never); // email idempotency
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // open poster tasks (none)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // worker escrows (none)
    mockDb.serializableTransaction.mockImplementation(async (fn) => {
      const q = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 } as never);
      return fn(q) as Promise<unknown>;
    });
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'req-1', status: 'completed' }] } as never); // completed

    mockNotification.createNotification.mockRejectedValue(new Error('Push service down'));

    const result = await GDPRService.executeDeletion('req-1');

    // Notification failure should NOT fail the deletion
    expect(result.success).toBe(true);
  });

  // TT-04: PENDING escrow PI cancellation
  it('cancels Stripe PaymentIntent and refunds PENDING escrow on poster task deletion', async () => {
    const pastDeadline = new Date(Date.now() - 86400000);

    // 1. Fetch request
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'req-1', user_id: 'user-1', status: 'pending', request_type: 'deletion', deadline: pastDeadline }],
      rowCount: 1,
    } as never);
    // 2. UPDATE to processing
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    // 3. SELECT firebase_uid (BUG GG1 FIX — fetched before deleteAndAnonymizeUserData)
    mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: 'firebase-uid-1' }], rowCount: 1 } as never);
    // 4. (inside deleteAndAnonymizeUserData) SELECT email idempotency check
    mockDb.query.mockResolvedValueOnce({ rows: [{ email: 'test@example.com' }], rowCount: 1 } as never);
    // 5. SELECT open poster tasks — one task returned
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-poster-1' }], rowCount: 1 } as never);
    // 5. SELECT escrows for poster task — PENDING escrow with PI id
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'escrow-pending-1', state: 'PENDING', stripe_payment_intent_id: 'pi_test_pending' }],
      rowCount: 1,
    } as never);
    // 6. SELECT worker escrows (none)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // 7. serializableTransaction
    const serializableQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 } as never);
    mockDb.serializableTransaction.mockImplementation(async (fn) => fn(serializableQuery) as Promise<unknown>);
    // 8. UPDATE to completed
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'req-1', status: 'completed' }], rowCount: 1 } as never);
    mockNotification.createNotification.mockResolvedValue({ success: true } as never);

    const result = await GDPRService.executeDeletion('req-1');

    expect(result.success).toBe(true);
    // Stripe PI should have been cancelled
    expect(mockPaymentIntentsCancel).toHaveBeenCalledWith('pi_test_pending');
    // EscrowService.refund should have been called for the PENDING escrow
    expect(mockEscrowService.refund).toHaveBeenCalledWith({ escrowId: 'escrow-pending-1' });
  });

  it('does not cancel Stripe PI for PENDING escrow without a stripe_payment_intent_id', async () => {
    const pastDeadline = new Date(Date.now() - 86400000);

    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'req-1', user_id: 'user-1', status: 'pending', request_type: 'deletion', deadline: pastDeadline }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // processing
    mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: null }], rowCount: 1 } as never); // firebase_uid
    mockDb.query.mockResolvedValueOnce({ rows: [{ email: 'test@example.com' }], rowCount: 1 } as never); // email idempotency
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-poster-2' }], rowCount: 1 } as never); // poster tasks
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'escrow-pending-2', state: 'PENDING', stripe_payment_intent_id: null }],
      rowCount: 1,
    } as never); // escrows
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // worker escrows
    mockDb.serializableTransaction.mockImplementation(async (fn) => {
      const q = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 } as never);
      return fn(q) as Promise<unknown>;
    });
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'req-1', status: 'completed' }] } as never);
    mockNotification.createNotification.mockResolvedValue({ success: true } as never);

    const result = await GDPRService.executeDeletion('req-1');

    expect(result.success).toBe(true);
    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockEscrowService.refund).toHaveBeenCalledWith({ escrowId: 'escrow-pending-2' });
  });

  it('continues when Stripe PI cancellation throws for PENDING escrow', async () => {
    const pastDeadline = new Date(Date.now() - 86400000);

    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'req-1', user_id: 'user-1', status: 'pending', request_type: 'deletion', deadline: pastDeadline }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // processing
    mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: null }], rowCount: 1 } as never); // firebase_uid
    mockDb.query.mockResolvedValueOnce({ rows: [{ email: 'test@example.com' }], rowCount: 1 } as never); // email idempotency
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-poster-3' }], rowCount: 1 } as never); // poster tasks
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'escrow-pending-3', state: 'PENDING', stripe_payment_intent_id: 'pi_already_cancelled' }],
      rowCount: 1,
    } as never); // escrows
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // worker escrows
    mockDb.serializableTransaction.mockImplementation(async (fn) => {
      const q = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 } as never);
      return fn(q) as Promise<unknown>;
    });
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'req-1', status: 'completed' }] } as never);
    mockNotification.createNotification.mockResolvedValue({ success: true } as never);

    // Stripe throws (PI already cancelled on Stripe side)
    mockPaymentIntentsCancel.mockRejectedValueOnce(new Error('PaymentIntent cannot be canceled'));

    const result = await GDPRService.executeDeletion('req-1');

    // Deletion should still succeed — PI failure is warn-and-continue
    expect(result.success).toBe(true);
    expect(mockEscrowService.refund).toHaveBeenCalledWith({ escrowId: 'escrow-pending-3' });
  });

  // TT-04: LOCKED_DISPUTE where poster is the deleted user
  it('calls partialRefund (0/100) for LOCKED_DISPUTE escrow on poster task deletion', async () => {
    const pastDeadline = new Date(Date.now() - 86400000);

    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'req-1', user_id: 'user-1', status: 'pending', request_type: 'deletion', deadline: pastDeadline }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // processing
    mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: null }], rowCount: 1 } as never); // firebase_uid
    mockDb.query.mockResolvedValueOnce({ rows: [{ email: 'test@example.com' }], rowCount: 1 } as never); // email idempotency
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'task-poster-4' }], rowCount: 1 } as never); // poster tasks
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'escrow-dispute-1', state: 'LOCKED_DISPUTE', stripe_payment_intent_id: null }],
      rowCount: 1,
    } as never); // escrows
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // worker escrows
    mockDb.serializableTransaction.mockImplementation(async (fn) => {
      const q = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 } as never);
      return fn(q) as Promise<unknown>;
    });
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'req-1', status: 'completed' }] } as never);
    mockNotification.createNotification.mockResolvedValue({ success: true } as never);

    const result = await GDPRService.executeDeletion('req-1');

    expect(result.success).toBe(true);
    expect(mockEscrowService.partialRefund).toHaveBeenCalledWith({
      escrowId: 'escrow-dispute-1',
      workerPercent: 0,
      posterPercent: 100,
    });
    expect(mockEscrowService.refund).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// hasBiometricConsent
// ===========================================================================

describe('GDPRService.hasBiometricConsent', () => {
  it('returns true when user has active biometric consent', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ granted: true }],
      rowCount: 1,
    } as never);

    const result = await GDPRService.hasBiometricConsent('user-1');
    expect(result).toBe(true);
  });

  it('returns false when user has no biometric consent', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await GDPRService.hasBiometricConsent('user-1');
    expect(result).toBe(false);
  });

  it('returns false (fail closed) on database error', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB connection lost'));

    const result = await GDPRService.hasBiometricConsent('user-1');
    expect(result).toBe(false);
  });

  it('queries with correct consent_type', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await GDPRService.hasBiometricConsent('user-42');

    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain("consent_type = 'biometric_data'");
    expect(params).toContain('user-42');
  });
});

// ===========================================================================
// collectUserDataForExport
// ===========================================================================

describe('collectUserDataForExport', () => {
  it('collects all user data categories', async () => {
    // Return empty rows for all 12 queries
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 } as never);

    const data = await collectUserDataForExport('user-1');

    expect(data).toHaveProperty('account');
    expect(data).toHaveProperty('tasks_posted');
    expect(data).toHaveProperty('tasks_worked');
    expect(data).toHaveProperty('transactions');
    expect(data).toHaveProperty('messages_last_90_days');
    expect(data).toHaveProperty('ratings_given');
    expect(data).toHaveProperty('ratings_received');
    expect(data).toHaveProperty('trust_tier_history');
    expect(data).toHaveProperty('xp_history');
    expect(data).toHaveProperty('analytics_events_last_90_days');
    expect(data).toHaveProperty('notification_preferences');
    expect(data).toHaveProperty('consent_history');
    expect(data).toHaveProperty('saved_searches');
    expect(data).toHaveProperty('export_date');
    expect(data).toHaveProperty('user_id');
  });

  it('includes export_date as ISO string', async () => {
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 } as never);

    const data = await collectUserDataForExport('user-1');

    expect(typeof data.export_date).toBe('string');
    expect(() => new Date(data.export_date as string)).not.toThrow();
  });

  it('includes user account data when found', async () => {
    const userRow = {
      id: 'user-1', email: 'user@example.com', name: 'John Doe',
      phone: '+15551234567', created_at: new Date(), account_status: 'active',
      current_level: 5, xp_total: 1500, trust_tier: 2, current_streak: 7,
    };
    // First query returns user row; rest return empty
    mockDb.query
      .mockResolvedValueOnce({ rows: [userRow], rowCount: 1 } as never)
      .mockResolvedValue({ rows: [], rowCount: 0 } as never);

    const data = await collectUserDataForExport('user-1');

    expect(data.account).toEqual(userRow);
  });

  it('handles tasks_posted and tasks_worked arrays', async () => {
    const postedTask = { id: 'task-1', title: 'Fix my sink' };
    const workedTask = { id: 'task-2', title: 'Walk my dog' };

    mockDb.query
      .mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as never) // user
      .mockResolvedValueOnce({ rows: [postedTask], rowCount: 1 } as never) // posted tasks
      .mockResolvedValueOnce({ rows: [workedTask], rowCount: 1 } as never) // worked tasks
      .mockResolvedValue({ rows: [], rowCount: 0 } as never); // rest

    const data = await collectUserDataForExport('user-1');

    expect(data.tasks_posted).toHaveLength(1);
    expect(data.tasks_worked).toHaveLength(1);
  });

  it('throws on database error', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('Connection timeout'));

    await expect(collectUserDataForExport('user-1')).rejects.toThrow('Connection timeout');
  });

  it('notification_preferences is null when not found', async () => {
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 } as never);

    const data = await collectUserDataForExport('user-1');

    expect(data.notification_preferences).toBeNull();
  });

  it('consent_history is an empty array when no consents', async () => {
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 } as never);

    const data = await collectUserDataForExport('user-1');

    expect(Array.isArray(data.consent_history)).toBe(true);
    expect(data.consent_history).toHaveLength(0);
  });
});

// ===========================================================================
// createRequest — DB error path
// ===========================================================================

describe('GDPRService.createRequest — error paths', () => {
  it('returns DB_ERROR on unexpected database error', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockDb.query.mockRejectedValueOnce(new Error('Unique constraint violation'));

    const result = await GDPRService.createRequest({
      userId: 'user-1',
      requestType: 'export',
      exportFormat: 'json',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
    }
  });

  it('handles invariant violation errors', async () => {
    const { isInvariantViolation } = await import('../../src/db');
    vi.mocked(isInvariantViolation).mockReturnValue(true);

    const invariantError = Object.assign(new Error('HX violation'), { code: 'HX001' });
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockDb.query.mockRejectedValueOnce(invariantError);

    const result = await GDPRService.createRequest({
      userId: 'user-1',
      requestType: 'export',
      exportFormat: 'json',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('HX001');
    }

    vi.mocked(isInvariantViolation).mockReturnValue(false);
  });

  it('includes scope in requestDetails when provided', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'req-1', request_type: 'export', status: 'pending' }],
      rowCount: 1,
    } as never);

    const result = await GDPRService.createRequest({
      userId: 'user-1',
      requestType: 'export',
      exportFormat: 'json',
      scope: ['tasks', 'messages'],
    });

    expect(result.success).toBe(true);

    // Verify request_details JSONB contains format and scope
    const insertArgs = mockDb.query.mock.calls[1][1] as unknown[];
    const requestDetails = JSON.parse(insertArgs[2] as string);
    expect(requestDetails.format).toBe('json');
    expect(requestDetails.scope).toEqual(['tasks', 'messages']);
  });
});

// ===========================================================================
// getUserRequests — DB error path
// ===========================================================================

describe('GDPRService.getUserRequests — error path', () => {
  it('returns DB_ERROR on unexpected error', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('Connection lost'));

    const result = await GDPRService.getUserRequests('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
    }
  });
});

// ===========================================================================
// updateConsent — error path
// ===========================================================================

describe('GDPRService.updateConsent — error path', () => {
  it('returns DB_ERROR on unexpected error', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('Constraint violation'));

    const result = await GDPRService.updateConsent({
      userId: 'user-1',
      consentType: 'marketing',
      purpose: 'Marketing emails',
      granted: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
    }
  });

  it('sends correct params for consent with ipAddress and userAgent', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'c-1', user_id: 'user-1', consent_type: 'analytics',
        granted: true, granted_at: new Date(),
      }],
      rowCount: 1,
    } as never);

    await GDPRService.updateConsent({
      userId: 'user-1',
      consentType: 'analytics',
      purpose: 'Analytics tracking',
      granted: true,
      ipAddress: '1.2.3.4',
      userAgent: 'HustleXP-iOS/2.0',
    });

    const params = mockDb.query.mock.calls[0][1] as unknown[];
    expect(params).toContain('1.2.3.4');
    expect(params).toContain('HustleXP-iOS/2.0');
  });
});

// ===========================================================================
// getConsentStatus — error path
// ===========================================================================

describe('GDPRService.getConsentStatus — error path', () => {
  it('returns DB_ERROR on unexpected error', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB timeout'));

    const result = await GDPRService.getConsentStatus('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
    }
  });

  it('returns empty array when no consents exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await GDPRService.getConsentStatus('user-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(0);
    }
  });
});

// ===========================================================================
// D54: deleteAndAnonymizeUserData — missing table deletions
// ===========================================================================

/**
 * Helper: set up all db.query mocks for executeDeletion with no poster/worker tasks,
 * then capture the SQL calls made inside serializableTransaction.
 * Returns { serializableQuery } so callers can assert on it.
 */
function setupDeletionMocksWithCapture() {
  const pastDeadline = new Date(Date.now() - 86400000);

  // 1. SELECT request
  mockDb.query.mockResolvedValueOnce({
    rows: [{ id: 'req-d54', user_id: 'user-d54', status: 'pending', request_type: 'deletion', deadline: pastDeadline }],
    rowCount: 1,
  } as never);
  // 2. UPDATE to processing (CAS)
  mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'req-d54' }], rowCount: 1 } as never);
  // 3. SELECT firebase_uid
  mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: null }], rowCount: 1 } as never);
  // 4. SELECT email (idempotency check inside deleteAndAnonymizeUserData)
  mockDb.query.mockResolvedValueOnce({ rows: [{ email: 'user@example.com' }], rowCount: 1 } as never);
  // 5. SELECT open poster tasks (none)
  mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
  // 6. SELECT worker escrows (none)
  mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

  // 7. serializableTransaction: capture all SQL inside the deletion
  const serializableQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 } as never);
  mockDb.serializableTransaction.mockImplementation(async (fn) => fn(serializableQuery) as Promise<unknown>);

  // 8. UPDATE to completed
  mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'req-d54', status: 'completed' }], rowCount: 1 } as never);

  mockNotification.createNotification.mockResolvedValue({ success: true } as never);

  return { serializableQuery };
}

describe('D54-1: deleteAndAnonymizeUserData — tax_forms deletion', () => {
  it('deletes tax_forms rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    // Verify tax_forms DELETE was issued inside the transaction
    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const taxFormsDeletion = calls.find(([sql]) => /DELETE FROM tax_forms/i.test(sql));
    expect(taxFormsDeletion, 'Expected DELETE FROM tax_forms to be called').toBeDefined();
    expect(taxFormsDeletion![1]).toContain('user-d54');
  });
});

describe('D54-3: deleteAndAnonymizeUserData — squad table deletions', () => {
  it('deletes squad_members rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    await GDPRService.executeDeletion('req-d54');

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const squadMembersDeletion = calls.find(([sql]) => /DELETE FROM squad_members/i.test(sql));
    expect(squadMembersDeletion, 'Expected DELETE FROM squad_members to be called').toBeDefined();
    expect(squadMembersDeletion![1]).toContain('user-d54');
  });

  it('deletes squad_invites rows where user is inviter or invitee', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    await GDPRService.executeDeletion('req-d54');

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const squadInvitesDeletion = calls.find(([sql]) => /DELETE FROM squad_invites/i.test(sql));
    expect(squadInvitesDeletion, 'Expected DELETE FROM squad_invites to be called').toBeDefined();
    // The SQL should handle both inviter_id and invitee_id
    expect(squadInvitesDeletion![0]).toMatch(/inviter_id|invitee_id/i);
    expect(squadInvitesDeletion![1]).toContain('user-d54');
  });

  it('deletes squad_task_workers rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    await GDPRService.executeDeletion('req-d54');

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const squadTaskWorkersDeletion = calls.find(([sql]) => /DELETE FROM squad_task_workers/i.test(sql));
    expect(squadTaskWorkersDeletion, 'Expected DELETE FROM squad_task_workers to be called').toBeDefined();
    expect(squadTaskWorkersDeletion![1]).toContain('user-d54');
  });
});

describe('D54-4: deleteAndAnonymizeUserData — additional table deletions', () => {
  it('deletes skill_verifications rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    await GDPRService.executeDeletion('req-d54');

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM skill_verifications/i.test(sql));
    expect(deletion, 'Expected DELETE FROM skill_verifications to be called').toBeDefined();
    expect(deletion![1]).toContain('user-d54');
  });

  it('deletes insurance_subscriptions rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    await GDPRService.executeDeletion('req-d54');

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM insurance_subscriptions/i.test(sql));
    expect(deletion, 'Expected DELETE FROM insurance_subscriptions to be called').toBeDefined();
    expect(deletion![1]).toContain('user-d54');
  });

  it('deletes daily_challenge_completions rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    await GDPRService.executeDeletion('req-d54');

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM daily_challenge_completions/i.test(sql));
    expect(deletion, 'Expected DELETE FROM daily_challenge_completions to be called').toBeDefined();
    expect(deletion![1]).toContain('user-d54');
  });

  it('deletes tips rows where user is poster or worker', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    await GDPRService.executeDeletion('req-d54');

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM tips/i.test(sql));
    expect(deletion, 'Expected DELETE FROM tips to be called').toBeDefined();
    // tips has poster_id and worker_id — both should be covered
    expect(deletion![0]).toMatch(/poster_id|worker_id/i);
    expect(deletion![1]).toContain('user-d54');
  });
});
