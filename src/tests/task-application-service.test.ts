/**
 * TaskApplicationService Unit Tests
 *
 * Covers all public methods of TaskApplicationServiceClass (exported as singleton
 * `TaskApplicationService`):
 *
 *   applyForTask          — apply, self-apply guard, existing application guard,
 *                           price validation, task-not-active, task-not-found
 *   acceptApplication     — poster guard, state machine, price selection,
 *                           atomic transaction, task-not-found
 *   rejectApplication     — poster guard, state machine
 *   counterOffer          — poster guard, round limit, price validation
 *   respondToCounter      — accept path, reject-simple path, reject-with-reprice,
 *                           round-limit re-counter, hustler-ownership guard
 *   withdrawApplication   — ownership guard, state machine
 *   getApplicationsForTask — unauthorized guard
 *   getApplicationsByHustler
 *   getApplication        — found / not found
 *   expireStaleApplications
 *
 * Mocking strategy:
 *   - `../db/index.js` is mocked with `sql` and `transaction` as vi.fn()s.
 *   - `./TaskService.js` is mocked with a configurable `getTask` vi.fn().
 *   - Logger is mocked to a no-op so tests stay quiet.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------
vi.mock('../utils/logger.js', () => {
  const noop = (..._args: unknown[]) => {};
  const noopLogger = {
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    debug: noop,
    child: () => noopLogger,
  };
  return { createLogger: () => noopLogger, logger: noopLogger, serviceLogger: noopLogger };
});

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------
const mockSql = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../db/index.js', () => ({
  get sql() { return mockSql; },
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

// ---------------------------------------------------------------------------
// TaskService mock
// ---------------------------------------------------------------------------
const mockGetTask = vi.fn();

vi.mock('../services/TaskService.js', () => ({
  TaskService: {
    getTask: (...args: unknown[]) => mockGetTask(...args),
  },
}));

// ---------------------------------------------------------------------------
// uuid mock — return deterministic IDs to make assertions simpler
// ---------------------------------------------------------------------------
let uuidCounter = 0;
vi.mock('uuid', () => ({
  v4: () => `test-uuid-${++uuidCounter}`,
}));

// ---------------------------------------------------------------------------
// Import service after all mocks
// ---------------------------------------------------------------------------
import { TaskApplicationService } from '../services/TaskApplicationService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2024-06-01T12:00:00Z').toISOString();

function makeAppRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'app-1',
    task_id: 'task-1',
    hustler_id: 'hustler-1',
    proposed_price_cents: 5000,
    message: 'I can do this!',
    status: 'pending',
    rejection_reason: null,
    counter_offer_price_cents: null,
    counter_offer_message: null,
    counter_offer_round: 0,
    agreed_price_cents: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1',
    clientId: 'poster-1',
    status: 'active',
    recommendedPrice: 50, // dollars
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskApplicationService', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;
    mockSql.mockResolvedValue([]);
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockSql));
  });

  // =========================================================================
  // applyForTask
  // =========================================================================

  describe('applyForTask', () => {
    it('returns success when all validations pass', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask());
      mockSql
        .mockResolvedValueOnce([])      // existing check → none
        .mockResolvedValueOnce([makeAppRow()]); // INSERT RETURNING

      const result = await TaskApplicationService.applyForTask(
        'task-1', 'hustler-1', 50, 'Ready to work'
      );

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/submitted/i);
      expect(result.application).toBeDefined();
      expect(result.applicationId).toBeDefined();
    });

    it('returns failure when task is not found', async () => {
      mockGetTask.mockResolvedValueOnce(null);

      const result = await TaskApplicationService.applyForTask('task-404', 'hustler-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not found/i);
    });

    it('returns failure when task is not active', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ status: 'assigned' }));

      const result = await TaskApplicationService.applyForTask('task-1', 'hustler-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not accepting applications/i);
    });

    it('prevents self-application (poster === hustler)', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'hustler-1' }));

      const result = await TaskApplicationService.applyForTask('task-1', 'hustler-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/own task/i);
    });

    it('returns failure (INV-APP-1) when existing active application found', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask());
      mockSql.mockResolvedValueOnce([{ id: 'app-existing', status: 'pending' }]); // existing

      const result = await TaskApplicationService.applyForTask('task-1', 'hustler-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/already have an active application/i);
      expect(result.applicationId).toBe('app-existing');
    });

    it('rejects proposed price of zero or negative', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask());
      mockSql.mockResolvedValueOnce([]); // no existing app

      const result = await TaskApplicationService.applyForTask('task-1', 'hustler-1', 0);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/must be positive/i);
    });

    it('rejects proposed price exceeding 5x recommended price', async () => {
      // recommendedPrice = 50 → 5x = $250 = 25000 cents
      mockGetTask.mockResolvedValueOnce(makeTask({ recommendedPrice: 50 }));
      mockSql.mockResolvedValueOnce([]); // no existing app

      const result = await TaskApplicationService.applyForTask('task-1', 'hustler-1', 300);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/reasonable bounds/i);
    });

    it('returns internal error on DB exception', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask());
      mockSql
        .mockResolvedValueOnce([])                    // existing check
        .mockRejectedValueOnce(new Error('DB down')); // INSERT fails

      const result = await TaskApplicationService.applyForTask('task-1', 'hustler-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/internal error/i);
    });
  });

  // =========================================================================
  // acceptApplication
  // =========================================================================

  describe('acceptApplication', () => {
    it('accepts application and assigns task atomically', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));
      mockSql
        .mockResolvedValueOnce([makeAppRow({ status: 'pending' })])  // SELECT app
        .mockResolvedValueOnce([makeAppRow({ status: 'accepted', agreed_price_cents: 5000 })]);  // SELECT after update

      // transaction runs three tx queries (UPDATE app, UPDATE others, UPDATE task)
      const txMock = vi.fn().mockResolvedValue([]);
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(txMock));

      const result = await TaskApplicationService.acceptApplication(
        'task-1', 'app-1', 'poster-1'
      );

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/accepted/i);
      expect(result.application?.status).toBe('accepted');
    });

    it('returns failure when task not found', async () => {
      mockGetTask.mockResolvedValueOnce(null);

      const result = await TaskApplicationService.acceptApplication('task-1', 'app-1', 'poster-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/task not found/i);
    });

    it('returns failure when caller is not the poster (INV-APP-2)', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));

      const result = await TaskApplicationService.acceptApplication('task-1', 'app-1', 'hacker-99');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/only the task poster/i);
    });

    it('returns failure when task is not active', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1', status: 'completed' }));

      const result = await TaskApplicationService.acceptApplication('task-1', 'app-1', 'poster-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not in a state/i);
    });

    it('returns failure when application not found', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));
      mockSql.mockResolvedValueOnce([]); // no application row

      const result = await TaskApplicationService.acceptApplication('task-1', 'app-404', 'poster-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/application not found/i);
    });

    it('returns failure when application is in a terminal state (INV-APP-6)', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));
      mockSql.mockResolvedValueOnce([makeAppRow({ status: 'withdrawn' })]);

      const result = await TaskApplicationService.acceptApplication('task-1', 'app-1', 'poster-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/cannot accept/i);
    });

    it('uses task recommended price when no proposed price set', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1', recommendedPrice: 75 }));
      mockSql
        .mockResolvedValueOnce([makeAppRow({ status: 'pending', proposed_price_cents: null })])
        .mockResolvedValueOnce([makeAppRow({ status: 'accepted', agreed_price_cents: 7500 })]);

      const txMock = vi.fn().mockResolvedValue([]);
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(txMock));

      const result = await TaskApplicationService.acceptApplication('task-1', 'app-1', 'poster-1');

      expect(result.success).toBe(true);
    });

    it('returns internal error on DB exception', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));
      mockSql.mockRejectedValueOnce(new Error('DB error'));

      const result = await TaskApplicationService.acceptApplication('task-1', 'app-1', 'poster-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/internal error/i);
    });
  });

  // =========================================================================
  // rejectApplication
  // =========================================================================

  describe('rejectApplication', () => {
    it('rejects application with optional reason', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));
      mockSql
        .mockResolvedValueOnce([makeAppRow({ status: 'pending' })])  // SELECT app
        .mockResolvedValueOnce([makeAppRow({ status: 'rejected', rejection_reason: 'Not qualified' })]);  // UPDATE RETURNING

      const result = await TaskApplicationService.rejectApplication(
        'task-1', 'app-1', 'poster-1', 'Not qualified'
      );

      expect(result.success).toBe(true);
      expect(result.application?.status).toBe('rejected');
    });

    it('returns failure when task not found', async () => {
      mockGetTask.mockResolvedValueOnce(null);

      const result = await TaskApplicationService.rejectApplication('task-1', 'app-1', 'poster-1');

      expect(result.success).toBe(false);
    });

    it('returns failure when caller is not the poster', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));

      const result = await TaskApplicationService.rejectApplication('task-1', 'app-1', 'other-user');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/only the task poster/i);
    });

    it('returns failure when application not found', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));
      mockSql.mockResolvedValueOnce([]);

      const result = await TaskApplicationService.rejectApplication('task-1', 'app-404', 'poster-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/application not found/i);
    });

    it('returns failure when application already accepted (terminal state)', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));
      mockSql.mockResolvedValueOnce([makeAppRow({ status: 'accepted' })]);

      const result = await TaskApplicationService.rejectApplication('task-1', 'app-1', 'poster-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/cannot reject/i);
    });

    it('returns internal error on DB exception', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));
      mockSql.mockRejectedValueOnce(new Error('connection lost'));

      const result = await TaskApplicationService.rejectApplication('task-1', 'app-1', 'poster-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/internal error/i);
    });
  });

  // =========================================================================
  // counterOffer
  // =========================================================================

  describe('counterOffer', () => {
    it('sends counter-offer and increments round', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));
      mockSql
        .mockResolvedValueOnce([makeAppRow({ status: 'pending', counter_offer_round: 0 })])
        .mockResolvedValueOnce([makeAppRow({ status: 'countered', counter_offer_price_cents: 4000, counter_offer_round: 1 })]);

      const result = await TaskApplicationService.counterOffer('task-1', 'app-1', 'poster-1', 40);

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/counter-offer sent/i);
    });

    it('returns failure when task not found', async () => {
      mockGetTask.mockResolvedValueOnce(null);

      const result = await TaskApplicationService.counterOffer('task-1', 'app-1', 'poster-1', 30);

      expect(result.success).toBe(false);
    });

    it('returns failure when caller is not the poster', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));

      const result = await TaskApplicationService.counterOffer('task-1', 'app-1', 'non-poster', 30);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/only the task poster/i);
    });

    it('returns failure when application not found', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));
      mockSql.mockResolvedValueOnce([]);

      const result = await TaskApplicationService.counterOffer('task-1', 'app-404', 'poster-1', 30);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/application not found/i);
    });

    it('returns failure when max counter rounds reached (INV-APP-5)', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));
      mockSql.mockResolvedValueOnce([makeAppRow({ status: 'pending', counter_offer_round: 3 })]);

      const result = await TaskApplicationService.counterOffer('task-1', 'app-1', 'poster-1', 30);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/maximum counter-offer rounds/i);
    });

    it('returns failure when counter-offer price is zero or negative', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));
      mockSql.mockResolvedValueOnce([makeAppRow({ status: 'pending', counter_offer_round: 0 })]);

      const result = await TaskApplicationService.counterOffer('task-1', 'app-1', 'poster-1', 0);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/must be positive/i);
    });

    it('returns failure when application is in rejected (terminal) state', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));
      mockSql.mockResolvedValueOnce([makeAppRow({ status: 'rejected' })]);

      const result = await TaskApplicationService.counterOffer('task-1', 'app-1', 'poster-1', 30);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/cannot counter-offer/i);
    });

    it('returns internal error on DB exception', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));
      mockSql.mockRejectedValueOnce(new Error('timeout'));

      const result = await TaskApplicationService.counterOffer('task-1', 'app-1', 'poster-1', 30);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/internal error/i);
    });
  });

  // =========================================================================
  // respondToCounter
  // =========================================================================

  describe('respondToCounter', () => {
    it('accepts a counter-offer (accept=true)', async () => {
      mockSql
        .mockResolvedValueOnce([makeAppRow({ status: 'countered', counter_offer_price_cents: 4500 })])
        .mockResolvedValueOnce([makeAppRow({ status: 'counter_accepted', agreed_price_cents: 4500 })]);

      const result = await TaskApplicationService.respondToCounter('app-1', 'hustler-1', true);

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/counter-offer accepted/i);
    });

    it('rejects a counter-offer without re-counter (accept=false, no counterPrice)', async () => {
      mockSql
        .mockResolvedValueOnce([makeAppRow({ status: 'countered', counter_offer_round: 1 })])
        .mockResolvedValueOnce([makeAppRow({ status: 'counter_rejected' })]);

      const result = await TaskApplicationService.respondToCounter('app-1', 'hustler-1', false);

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/rejected/i);
    });

    it('rejects counter-offer with new price proposal (re-counter)', async () => {
      mockSql
        .mockResolvedValueOnce([makeAppRow({ status: 'countered', counter_offer_round: 1 })])
        .mockResolvedValueOnce([makeAppRow({ status: 'counter_rejected', proposed_price_cents: 4200 })]);

      const result = await TaskApplicationService.respondToCounter('app-1', 'hustler-1', false, 42);

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/new price has been submitted/i);
    });

    it('rejects with max-round message when at max rounds and counterPrice provided', async () => {
      mockSql
        .mockResolvedValueOnce([makeAppRow({ status: 'countered', counter_offer_round: 3 })])
        .mockResolvedValueOnce([makeAppRow({ status: 'counter_rejected' })]);

      const result = await TaskApplicationService.respondToCounter('app-1', 'hustler-1', false, 45);

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/maximum negotiation rounds/i);
    });

    it('returns failure when application not found', async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await TaskApplicationService.respondToCounter('app-404', 'hustler-1', true);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/application not found/i);
    });

    it('returns failure when caller is not the applying hustler (INV-APP-3)', async () => {
      mockSql.mockResolvedValueOnce([makeAppRow({ hustler_id: 'hustler-1', status: 'countered' })]);

      const result = await TaskApplicationService.respondToCounter('app-1', 'other-hustler', true);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/only the applying hustler/i);
    });

    it('returns failure when application is not in countered status', async () => {
      mockSql.mockResolvedValueOnce([makeAppRow({ status: 'pending' })]);

      const result = await TaskApplicationService.respondToCounter('app-1', 'hustler-1', true);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/cannot respond/i);
    });

    it('returns failure when re-counter price is zero or negative', async () => {
      mockSql.mockResolvedValueOnce([makeAppRow({ status: 'countered', counter_offer_round: 1 })]);

      const result = await TaskApplicationService.respondToCounter('app-1', 'hustler-1', false, 0);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/must be positive/i);
    });

    it('returns internal error on DB exception', async () => {
      mockSql.mockRejectedValueOnce(new Error('connection reset'));

      const result = await TaskApplicationService.respondToCounter('app-1', 'hustler-1', true);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/internal error/i);
    });
  });

  // =========================================================================
  // withdrawApplication
  // =========================================================================

  describe('withdrawApplication', () => {
    it('withdraws a pending application', async () => {
      mockSql
        .mockResolvedValueOnce([makeAppRow({ status: 'pending' })])
        .mockResolvedValueOnce([makeAppRow({ status: 'withdrawn' })]);

      const result = await TaskApplicationService.withdrawApplication('app-1', 'hustler-1');

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/withdrawn/i);
    });

    it('withdraws a countered application', async () => {
      mockSql
        .mockResolvedValueOnce([makeAppRow({ status: 'countered' })])
        .mockResolvedValueOnce([makeAppRow({ status: 'withdrawn' })]);

      const result = await TaskApplicationService.withdrawApplication('app-1', 'hustler-1');

      expect(result.success).toBe(true);
    });

    it('returns failure when application not found', async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await TaskApplicationService.withdrawApplication('app-404', 'hustler-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/application not found/i);
    });

    it('returns failure when caller is not the applicant', async () => {
      mockSql.mockResolvedValueOnce([makeAppRow({ hustler_id: 'hustler-1' })]);

      const result = await TaskApplicationService.withdrawApplication('app-1', 'other-user');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/only the applicant/i);
    });

    it('returns failure when application is already accepted (terminal)', async () => {
      mockSql.mockResolvedValueOnce([makeAppRow({ status: 'accepted' })]);

      const result = await TaskApplicationService.withdrawApplication('app-1', 'hustler-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/cannot withdraw/i);
    });

    it('returns internal error on DB exception', async () => {
      mockSql.mockRejectedValueOnce(new Error('DB down'));

      const result = await TaskApplicationService.withdrawApplication('app-1', 'hustler-1');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/internal error/i);
    });
  });

  // =========================================================================
  // getApplicationsForTask
  // =========================================================================

  describe('getApplicationsForTask', () => {
    it('returns applications when caller is the poster', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));
      mockSql.mockResolvedValueOnce([makeAppRow(), makeAppRow({ id: 'app-2' })]);

      const apps = await TaskApplicationService.getApplicationsForTask('task-1', 'poster-1');

      expect(apps).toHaveLength(2);
    });

    it('throws when caller is not the poster', async () => {
      mockGetTask.mockResolvedValueOnce(makeTask({ clientId: 'poster-1' }));

      await expect(
        TaskApplicationService.getApplicationsForTask('task-1', 'intruder-99')
      ).rejects.toThrow(/unauthorized/i);
    });

    it('throws when task not found', async () => {
      mockGetTask.mockResolvedValueOnce(null);

      await expect(
        TaskApplicationService.getApplicationsForTask('task-404', 'poster-1')
      ).rejects.toThrow(/unauthorized/i);
    });
  });

  // =========================================================================
  // getApplicationsByHustler
  // =========================================================================

  describe('getApplicationsByHustler', () => {
    it('returns applications for the given hustler', async () => {
      mockSql.mockResolvedValueOnce([makeAppRow(), makeAppRow({ id: 'app-2', task_id: 'task-2' })]);

      const apps = await TaskApplicationService.getApplicationsByHustler('hustler-1');

      expect(apps).toHaveLength(2);
      expect(apps[0].hustlerId).toBe('hustler-1');
    });

    it('returns empty array when hustler has no applications', async () => {
      mockSql.mockResolvedValueOnce([]);

      const apps = await TaskApplicationService.getApplicationsByHustler('hustler-new');

      expect(apps).toHaveLength(0);
    });
  });

  // =========================================================================
  // getApplication
  // =========================================================================

  describe('getApplication', () => {
    it('returns application when found', async () => {
      mockSql.mockResolvedValueOnce([makeAppRow()]);

      const app = await TaskApplicationService.getApplication('app-1');

      expect(app).not.toBeNull();
      expect(app?.id).toBe('app-1');
      expect(app?.status).toBe('pending');
    });

    it('returns null when application not found', async () => {
      mockSql.mockResolvedValueOnce([]);

      const app = await TaskApplicationService.getApplication('app-404');

      expect(app).toBeNull();
    });
  });

  // =========================================================================
  // expireStaleApplications
  // =========================================================================

  describe('expireStaleApplications', () => {
    it('returns count of expired applications', async () => {
      mockSql.mockResolvedValueOnce([{ id: 'app-old-1' }, { id: 'app-old-2' }]);

      const count = await TaskApplicationService.expireStaleApplications();

      expect(count).toBe(2);
    });

    it('returns 0 when no stale applications found', async () => {
      mockSql.mockResolvedValueOnce([]);

      const count = await TaskApplicationService.expireStaleApplications();

      expect(count).toBe(0);
    });
  });

  // =========================================================================
  // rowToApplication mapping (tested via getApplication)
  // =========================================================================

  describe('rowToApplication field mapping', () => {
    it('maps snake_case row to camelCase TaskApplication', async () => {
      const row = makeAppRow({
        id: 'app-mapping-test',
        task_id: 'task-99',
        hustler_id: 'hustler-99',
        proposed_price_cents: 12345,
        message: 'test message',
        status: 'pending',
        rejection_reason: null,
        counter_offer_price_cents: null,
        counter_offer_message: null,
        counter_offer_round: 2,
        agreed_price_cents: null,
      });

      mockSql.mockResolvedValueOnce([row]);

      const app = await TaskApplicationService.getApplication('app-mapping-test');

      expect(app).not.toBeNull();
      expect(app!.id).toBe('app-mapping-test');
      expect(app!.taskId).toBe('task-99');
      expect(app!.hustlerId).toBe('hustler-99');
      expect(app!.proposedPriceCents).toBe(12345);
      expect(app!.message).toBe('test message');
      expect(app!.counterOfferRound).toBe(2);
      expect(app!.agreedPriceCents).toBeNull();
      expect(app!.createdAt).toBeInstanceOf(Date);
      expect(app!.updatedAt).toBeInstanceOf(Date);
    });
  });
});
