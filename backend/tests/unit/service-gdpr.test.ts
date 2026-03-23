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
const { mockPaymentIntentsCancel, mockCustomersDel } = vi.hoisted(() => ({
  mockPaymentIntentsCancel: vi.fn(),
  mockCustomersDel: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: class MockStripe {
    paymentIntents = {
      cancel: mockPaymentIntentsCancel,
    };
    customers = {
      del: mockCustomersDel,
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
import { invalidateAuthCacheForUser } from '../../src/auth-cache';
import { forceDisconnectUser } from '../../src/realtime/connection-registry';
import { revokeUserSessions } from '../../src/auth/middleware';

const mockDb = vi.mocked(db);
const mockNotification = vi.mocked(NotificationService);
const mockEscrowService = vi.mocked(EscrowService);
const mockTaskService = vi.mocked(TaskService);

beforeEach(() => {
  vi.resetAllMocks();
  // D53-4: reset the in-memory rate-limit Map so each test gets a fresh bucket
  _resetGDPRRateLimitMapForTesting();
  mockPaymentIntentsCancel.mockResolvedValue({ id: 'pi_test', status: 'canceled' });
  mockCustomersDel.mockResolvedValue({ id: 'cus_test', deleted: true });
  // Restore default mock implementations that vi.resetAllMocks() cleared
  vi.mocked(EscrowService.refund).mockResolvedValue({ success: true } as never);
  vi.mocked(EscrowService.partialRefund).mockResolvedValue({ success: true } as never);
  vi.mocked(TaskService.cancel).mockResolvedValue({ success: true } as never);
  vi.mocked(NotificationService.createNotification).mockResolvedValue({ success: true } as never);
  // Auth helpers must return Promises; vi.resetAllMocks() clears their implementations.
  // revokeUserSessions result has .catch() called on it — must be a Promise.
  vi.mocked(invalidateAuthCacheForUser).mockResolvedValue(undefined);
  vi.mocked(forceDisconnectUser).mockResolvedValue(undefined);
  vi.mocked(revokeUserSessions).mockResolvedValue(undefined);
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

    // 4d. D58-8: SELECT stripe_customer_id (before transaction)
    mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: null }], rowCount: 1 } as never);

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

    // 1. SELECT request
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'req-1', user_id: 'user-1', status: 'pending',
        request_type: 'deletion', deadline: pastDeadline,
      }],
      rowCount: 1,
    } as never);

    // 2. UPDATE to processing
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'req-1' }], rowCount: 1 } as never);

    // 3. SELECT firebase_uid
    mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: null }], rowCount: 1 } as never);

    // 4. SELECT email (idempotency check inside deleteAndAnonymizeUserData)
    mockDb.query.mockResolvedValueOnce({ rows: [{ email: 'user@example.com' }], rowCount: 1 } as never);

    // 5. SELECT open poster tasks (none)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    // 6. SELECT worker FUNDED/LOCKED_DISPUTE escrows (none)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    // 7. D58-8: SELECT stripe_customer_id (before transaction)
    mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: null }], rowCount: 1 } as never);

    // serializableTransaction throws
    mockDb.serializableTransaction.mockRejectedValue(new Error('DB transaction failed'));

    // 8. UPDATE to rejected (error path)
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
    mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: null }], rowCount: 1 } as never); // D58-8: stripe_customer_id
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
    // 6b. D58-8: SELECT stripe_customer_id (before transaction)
    mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: null }], rowCount: 1 } as never);
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
    mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: null }], rowCount: 1 } as never); // D58-8
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
    mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: null }], rowCount: 1 } as never); // D58-8
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
    mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: null }], rowCount: 1 } as never); // D58-8
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
  // 6b. D58-8: SELECT stripe_customer_id (before transaction; null = no Stripe customer)
  mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: null }], rowCount: 1 } as never);

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

// ===========================================================================
// D55: deleteAndAnonymizeUserData — missing table deletions (R55 batch)
// ===========================================================================

describe('D55-1: deleteAndAnonymizeUserData — dispute_evidence deletion', () => {
  it('deletes dispute_evidence rows uploaded_by the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM dispute_evidence/i.test(sql));
    expect(deletion, 'Expected DELETE FROM dispute_evidence to be called').toBeDefined();
    expect(deletion![0]).toMatch(/uploaded_by/i);
    expect(deletion![1]).toContain('user-d54');
  });
});

describe('D55-2: deleteAndAnonymizeUserData — poster_ratings deletion', () => {
  it('deletes poster_ratings rows where user is poster_id or rated_by', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM poster_ratings/i.test(sql));
    expect(deletion, 'Expected DELETE FROM poster_ratings to be called').toBeDefined();
    expect(deletion![0]).toMatch(/poster_id|rated_by/i);
    expect(deletion![1]).toContain('user-d54');
  });
});

describe('D55-3: deleteAndAnonymizeUserData — live_sessions deletion', () => {
  it('deletes live_sessions rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM live_sessions/i.test(sql));
    expect(deletion, 'Expected DELETE FROM live_sessions to be called').toBeDefined();
    expect(deletion![0]).toMatch(/user_id/i);
    expect(deletion![1]).toContain('user-d54');
  });
});

// ===========================================================================
// D57: deleteAndAnonymizeUserData — missing table deletions (R57 batch)
// ===========================================================================

describe('D57-1: deleteAndAnonymizeUserData — session_forecasts deletion', () => {
  it('deletes session_forecasts rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM session_forecasts/i.test(sql));
    expect(deletion, 'Expected DELETE FROM session_forecasts to be called').toBeDefined();
    expect(deletion![0]).toMatch(/user_id/i);
    expect(deletion![1]).toContain('user-d54');
  });
});

describe('D57-2: deleteAndAnonymizeUserData — content_appeals deletion', () => {
  it('deletes content_appeals rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM content_appeals/i.test(sql));
    expect(deletion, 'Expected DELETE FROM content_appeals to be called').toBeDefined();
    expect(deletion![0]).toMatch(/user_id/i);
    expect(deletion![1]).toContain('user-d54');
  });
});

describe('D57-3: deleteAndAnonymizeUserData — content_reports deletion', () => {
  it('deletes content_reports rows where user is reporter or reported content owner', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM content_reports/i.test(sql));
    expect(deletion, 'Expected DELETE FROM content_reports to be called').toBeDefined();
    expect(deletion![0]).toMatch(/reporter_user_id|reported_content_user_id/i);
    expect(deletion![1]).toContain('user-d54');
  });
});

describe('D57-4: deleteAndAnonymizeUserData — recurring_task_series and squads', () => {
  it('deletes recurring_task_series rows where user is the poster', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM recurring_task_series/i.test(sql));
    expect(deletion, 'Expected DELETE FROM recurring_task_series to be called').toBeDefined();
    expect(deletion![0]).toMatch(/poster_id/i);
    expect(deletion![1]).toContain('user-d54');
  });

  it('removes user as organizer from squads (NULL out or DELETE)', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    // Accept either DELETE or UPDATE NULL for squads organizer_id
    const squadCall = calls.find(
      ([sql]) =>
        /DELETE FROM squads/i.test(sql) ||
        /UPDATE squads\s+SET organizer_id\s*=\s*NULL/i.test(sql),
    );
    expect(squadCall, 'Expected squads organizer_id to be cleared (DELETE or UPDATE NULL)').toBeDefined();
    expect(squadCall![1]).toContain('user-d54');
  });
});

// ===========================================================================
// D58: deleteAndAnonymizeUserData — R58 batch of missing PII deletions
// ===========================================================================

describe('D58-1: deleteAndAnonymizeUserData — worker_tax_info deletion (CRITICAL — SSN/EIN)', () => {
  it('deletes worker_tax_info rows for the user inside the transaction', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM worker_tax_info/i.test(sql));
    expect(deletion, 'Expected DELETE FROM worker_tax_info to be called').toBeDefined();
    expect(deletion![1]).toContain('user-d54');
  });
});

describe('D58-2: deleteAndAnonymizeUserData — worker_stripe_accounts deletion (CRITICAL)', () => {
  it('deletes worker_stripe_accounts rows for the user inside the transaction', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM worker_stripe_accounts/i.test(sql));
    expect(deletion, 'Expected DELETE FROM worker_stripe_accounts to be called').toBeDefined();
    expect(deletion![1]).toContain('user-d54');
  });
});

describe('D58-3: deleteAndAnonymizeUserData — worker_payout_settings and worker_earnings_1099 deletion', () => {
  it('deletes worker_payout_settings rows for the user inside the transaction', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM worker_payout_settings/i.test(sql));
    expect(deletion, 'Expected DELETE FROM worker_payout_settings to be called').toBeDefined();
    expect(deletion![1]).toContain('user-d54');
  });

  it('deletes worker_earnings_1099 rows for the user inside the transaction', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM worker_earnings_1099/i.test(sql));
    expect(deletion, 'Expected DELETE FROM worker_earnings_1099 to be called').toBeDefined();
    expect(deletion![1]).toContain('user-d54');
  });
});

describe('D58-4: deleteAndAnonymizeUserData — expertise table deletions', () => {
  it('deletes expertise_change_log rows for the user inside the transaction', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM expertise_change_log/i.test(sql));
    expect(deletion, 'Expected DELETE FROM expertise_change_log to be called').toBeDefined();
    expect(deletion![1]).toContain('user-d54');
  });

  it('deletes expertise_waitlist rows for the user inside the transaction', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM expertise_waitlist/i.test(sql));
    expect(deletion, 'Expected DELETE FROM expertise_waitlist to be called').toBeDefined();
    expect(deletion![1]).toContain('user-d54');
  });

  it('deletes user_expertise rows for the user inside the transaction', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM user_expertise/i.test(sql));
    expect(deletion, 'Expected DELETE FROM user_expertise to be called').toBeDefined();
    expect(deletion![1]).toContain('user-d54');
  });
});

describe('D58-5: deleteAndAnonymizeUserData — featured_listings deletion', () => {
  it('deletes featured_listings rows where user is the poster inside the transaction', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM featured_listings/i.test(sql));
    expect(deletion, 'Expected DELETE FROM featured_listings to be called').toBeDefined();
    expect(deletion![0]).toMatch(/poster_id/i);
    expect(deletion![1]).toContain('user-d54');
  });
});

describe('D58-6: deleteAndAnonymizeUserData — task_matching_scores deletion', () => {
  it('deletes task_matching_scores rows for the user inside the transaction', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM task_matching_scores/i.test(sql));
    expect(deletion, 'Expected DELETE FROM task_matching_scores to be called').toBeDefined();
    expect(deletion![0]).toMatch(/hustler_id/i);
    expect(deletion![1]).toContain('user-d54');
  });
});

describe('D58-7: deleteAndAnonymizeUserData — proof_submissions photo_url nulled', () => {
  it('nulls photo_url in the proof_submissions UPDATE inside the transaction', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const proofSubmissionsUpdate = calls.find(([sql]) => /UPDATE proof_submissions/i.test(sql));
    expect(proofSubmissionsUpdate, 'Expected UPDATE proof_submissions to be called').toBeDefined();
    expect(proofSubmissionsUpdate![0]).toMatch(/photo_url\s*=\s*NULL/i);
  });
});

describe('D58-8: deleteAndAnonymizeUserData — Stripe customer deleted via API', () => {
  it('calls stripe.customers.del with the customer id before nulling stripe_customer_id in DB', async () => {
    const pastDeadline = new Date(Date.now() - 86400000);

    // 1. SELECT request
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'req-d58', user_id: 'user-d58', status: 'pending', request_type: 'deletion', deadline: pastDeadline }],
      rowCount: 1,
    } as never);
    // 2. UPDATE to processing
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'req-d58' }], rowCount: 1 } as never);
    // 3. SELECT firebase_uid
    mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: null }], rowCount: 1 } as never);
    // 4. SELECT email (idempotency check inside deleteAndAnonymizeUserData)
    mockDb.query.mockResolvedValueOnce({ rows: [{ email: 'user@example.com' }], rowCount: 1 } as never);
    // 5. SELECT open poster tasks (none)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // 6. SELECT worker escrows (none)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // 7. SELECT stripe_customer_id (fetched before transaction for D58-8)
    mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_test_123' }], rowCount: 1 } as never);

    // 8. serializableTransaction
    const serializableQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 } as never);
    mockDb.serializableTransaction.mockImplementation(async (fn) => fn(serializableQuery) as Promise<unknown>);

    // 9. UPDATE to completed
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'req-d58', status: 'completed' }], rowCount: 1 } as never);

    mockCustomersDel.mockResolvedValue({ id: 'cus_test_123', deleted: true });

    const result = await GDPRService.executeDeletion('req-d58');

    expect(result.success).toBe(true);
    expect(mockCustomersDel).toHaveBeenCalledWith('cus_test_123');
  });

  it('continues deletion even when stripe.customers.del throws (best-effort)', async () => {
    const pastDeadline = new Date(Date.now() - 86400000);

    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'req-d58', user_id: 'user-d58', status: 'pending', request_type: 'deletion', deadline: pastDeadline }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'req-d58' }], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: null }], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [{ email: 'user@example.com' }], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // poster tasks
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // worker escrows
    mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_err_123' }], rowCount: 1 } as never);

    mockDb.serializableTransaction.mockImplementation(async (fn) => {
      const q = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 } as never);
      return fn(q) as Promise<unknown>;
    });

    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'req-d58', status: 'completed' }], rowCount: 1 } as never);

    mockCustomersDel.mockRejectedValue(new Error('Stripe API error'));

    const result = await GDPRService.executeDeletion('req-d58');

    // Must still succeed — Stripe deletion is best-effort
    expect(result.success).toBe(true);
  });

  it('skips stripe.customers.del when no stripe_customer_id exists', async () => {
    const pastDeadline = new Date(Date.now() - 86400000);

    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'req-d58', user_id: 'user-d58', status: 'pending', request_type: 'deletion', deadline: pastDeadline }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'req-d58' }], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: null }], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [{ email: 'user@example.com' }], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // poster tasks
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // worker escrows
    mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: null }], rowCount: 1 } as never);

    mockDb.serializableTransaction.mockImplementation(async (fn) => {
      const q = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 } as never);
      return fn(q) as Promise<unknown>;
    });

    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'req-d58', status: 'completed' }], rowCount: 1 } as never);

    const result = await GDPRService.executeDeletion('req-d58');

    expect(result.success).toBe(true);
    expect(mockCustomersDel).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// D60: deleteAndAnonymizeUserData — R60 batch of GDPR bug fixes
// ===========================================================================

describe('D60-A: deleteAndAnonymizeUserData — dispute_jury_votes uses juror_id (not voter_id)', () => {
  it('uses juror_id column (not voter_id) and DELETEs the row (NOT NULL column)', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    // Must use DELETE (juror_id is NOT NULL — cannot SET NULL)
    const juryVotesDeletion = calls.find(([sql]) => /DELETE FROM dispute_jury_votes/i.test(sql));
    expect(juryVotesDeletion, 'Expected DELETE FROM dispute_jury_votes with juror_id to be called').toBeDefined();
    expect(juryVotesDeletion![0]).toMatch(/juror_id/i);
    expect(juryVotesDeletion![0]).not.toMatch(/voter_id/i);
    expect(juryVotesDeletion![1]).toContain('user-d54');
  });
});

describe('D60-B: deleteAndAnonymizeUserData — referral_redemptions DELETEd (NOT NULL FKs)', () => {
  it('DELETEs referral_redemptions rows where referrer_id OR referred_id matches (not SET NULL)', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    // Must be DELETE (both FKs are NOT NULL — SET NULL would violate constraint)
    const referralDeletion = calls.find(([sql]) => /DELETE FROM referral_redemptions/i.test(sql));
    expect(referralDeletion, 'Expected DELETE FROM referral_redemptions to be called').toBeDefined();
    expect(referralDeletion![0]).toMatch(/referrer_id|referred_id/i);
    expect(referralDeletion![1]).toContain('user-d54');

    // Verify no UPDATE SET NULL remains for referral_redemptions
    const referralUpdate = calls.find(([sql]) =>
      /UPDATE referral_redemptions/i.test(sql) &&
      /SET (referrer_id|referred_id)\s*=\s*NULL/i.test(sql)
    );
    expect(referralUpdate, 'Expected no UPDATE referral_redemptions SET NULL (FK is NOT NULL)').toBeUndefined();
  });
});

describe('D60-C: deleteAndAnonymizeUserData — shadow_score_events deleted', () => {
  it('DELETEs shadow_score_events rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM shadow_score_events/i.test(sql));
    expect(deletion, 'Expected DELETE FROM shadow_score_events to be called').toBeDefined();
    expect(deletion![0]).toMatch(/user_id/i);
    expect(deletion![1]).toContain('user-d54');
  });
});

describe('D60-D: deleteAndAnonymizeUserData — license_verifications deleted', () => {
  it('DELETEs license_verifications rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM license_verifications/i.test(sql));
    expect(deletion, 'Expected DELETE FROM license_verifications to be called').toBeDefined();
    expect(deletion![0]).toMatch(/user_id/i);
    expect(deletion![1]).toContain('user-d54');
  });
});

describe('D60-E: deleteAndAnonymizeUserData — insurance_verifications deleted', () => {
  it('DELETEs insurance_verifications rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM insurance_verifications/i.test(sql));
    expect(deletion, 'Expected DELETE FROM insurance_verifications to be called').toBeDefined();
    expect(deletion![0]).toMatch(/user_id/i);
    expect(deletion![1]).toContain('user-d54');
  });
});

describe('D60-F: deleteAndAnonymizeUserData — background_checks deleted', () => {
  it('DELETEs background_checks rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM background_checks/i.test(sql));
    expect(deletion, 'Expected DELETE FROM background_checks to be called').toBeDefined();
    expect(deletion![0]).toMatch(/user_id/i);
    expect(deletion![1]).toContain('user-d54');
  });
});

describe('D60-G: deleteAndAnonymizeUserData — compliance_violations PII scrubbed', () => {
  it('NULLs ip_address, device_fingerprint, and user_id in compliance_violations', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const complianceCall = calls.find(([sql]) => /compliance_violations/i.test(sql));
    expect(complianceCall, 'Expected compliance_violations to be scrubbed').toBeDefined();
    // Either DELETE or UPDATE that NULLs ip_address and device_fingerprint
    const sqlStr = complianceCall![0];
    const isDelete = /DELETE FROM compliance_violations/i.test(sqlStr);
    const isUpdate = /UPDATE compliance_violations/i.test(sqlStr) &&
      /ip_address\s*=\s*NULL/i.test(sqlStr) &&
      /device_fingerprint\s*=\s*NULL/i.test(sqlStr);
    expect(isDelete || isUpdate, 'compliance_violations must be DELETEd or have PII NULLed').toBe(true);
    expect(complianceCall![1]).toContain('user-d54');
  });
});

describe('D60-H: deleteAndAnonymizeUserData — fraud_detection_events user_id NULLed', () => {
  it('NULLs user_id in fraud_detection_events (nullable FK)', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const fraudEventCall = calls.find(([sql]) => /fraud_detection_events/i.test(sql));
    expect(fraudEventCall, 'Expected fraud_detection_events to be scrubbed').toBeDefined();
    const sqlStr = fraudEventCall![0];
    const isDelete = /DELETE FROM fraud_detection_events/i.test(sqlStr);
    const isUpdate = /UPDATE fraud_detection_events/i.test(sqlStr) && /user_id\s*=\s*NULL/i.test(sqlStr);
    expect(isDelete || isUpdate, 'fraud_detection_events must be DELETEd or user_id NULLed').toBe(true);
    expect(fraudEventCall![1]).toContain('user-d54');
  });
});

describe('D60-I: deleteAndAnonymizeUserData — verification_earnings tables deleted', () => {
  it('DELETEs verification_earnings_ledger rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM verification_earnings_ledger/i.test(sql));
    expect(deletion, 'Expected DELETE FROM verification_earnings_ledger to be called').toBeDefined();
    expect(deletion![0]).toMatch(/user_id/i);
    expect(deletion![1]).toContain('user-d54');
  });

  it('DELETEs verification_earnings_tracking rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const deletion = calls.find(([sql]) => /DELETE FROM verification_earnings_tracking/i.test(sql));
    expect(deletion, 'Expected DELETE FROM verification_earnings_tracking to be called').toBeDefined();
    expect(deletion![1]).toContain('user-d54');
  });
});

// ===========================================================================
// D61: deleteAndAnonymizeUserData — column name / type bugs
// ===========================================================================

describe('D61-1: deleteAndAnonymizeUserData — admin_actions uses target_user_id (not target_id)', () => {
  it('UPDATEs admin_actions using WHERE target_user_id (not target_id)', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const adminActionsCall = calls.find(([sql]) => /admin_actions/i.test(sql));
    expect(adminActionsCall, 'Expected admin_actions SQL to be issued').toBeDefined();
    expect(adminActionsCall![0]).toMatch(/target_user_id/i);
    expect(adminActionsCall![0]).not.toMatch(/WHERE\s+target_id\b/i);
    expect(adminActionsCall![1]).toContain('user-d54');
  });
});

describe('D61-2: deleteAndAnonymizeUserData — content_moderation_queue uses DELETE (not SET NULL)', () => {
  it('DELETEs content_moderation_queue rows instead of setting user_id = NULL', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const cmqCall = calls.find(([sql]) => /content_moderation_queue/i.test(sql));
    expect(cmqCall, 'Expected content_moderation_queue SQL to be issued').toBeDefined();
    expect(cmqCall![0]).toMatch(/DELETE FROM content_moderation_queue/i);
    expect(cmqCall![0]).not.toMatch(/SET\s+user_id\s*=\s*NULL/i);
    expect(cmqCall![1]).toContain('user-d54');
  });
});

describe('D61-7: deleteAndAnonymizeUserData — insurance_contributions uses hustler_id (not user_id)', () => {
  it('DELETEs insurance_contributions using WHERE hustler_id (not user_id)', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const insContribCall = calls.find(([sql]) => /DELETE FROM insurance_contributions/i.test(sql));
    expect(insContribCall, 'Expected DELETE FROM insurance_contributions to be called').toBeDefined();
    expect(insContribCall![0]).toMatch(/hustler_id/i);
    expect(insContribCall![0]).not.toMatch(/WHERE\s+user_id/i);
    expect(insContribCall![1]).toContain('user-d54');
  });
});

describe('D61-8: deleteAndAnonymizeUserData — fraud_patterns uses $1::UUID (not $1::TEXT)', () => {
  it('uses $1::UUID cast when removing user from fraud_patterns user_ids array', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const fraudPatternCall = calls.find(([sql]) => /fraud_patterns/i.test(sql));
    expect(fraudPatternCall, 'Expected fraud_patterns SQL to be issued').toBeDefined();
    expect(fraudPatternCall![0]).toMatch(/\$1::UUID/i);
    expect(fraudPatternCall![0]).not.toMatch(/\$1::TEXT/i);
    expect(fraudPatternCall![1]).toContain('user-d54');
  });
});

describe('D61-9: deleteAndAnonymizeUserData — admin_roles deleted', () => {
  it('DELETEs admin_roles rows for the user', async () => {
    const { serializableQuery } = setupDeletionMocksWithCapture();

    const result = await GDPRService.executeDeletion('req-d54');

    expect(result.success).toBe(true);

    const calls = serializableQuery.mock.calls as [string, unknown[]][];
    const adminRolesCall = calls.find(([sql]) => /DELETE FROM admin_roles/i.test(sql));
    expect(adminRolesCall, 'Expected DELETE FROM admin_roles to be called').toBeDefined();
    expect(adminRolesCall![0]).toMatch(/user_id/i);
    expect(adminRolesCall![1]).toContain('user-d54');
  });
});
