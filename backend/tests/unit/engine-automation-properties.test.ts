import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
  taskLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../src/services/PlanService', () => ({
  PlanService: { canCreateTaskWithRisk: vi.fn(), canAcceptTaskWithRisk: vi.fn() },
}));

vi.mock('../../src/services/ScoperAIService', () => ({
  ScoperAIService: { analyzeTaskScope: vi.fn() },
}));

import { buildTaskCreateRequestHash } from '../../src/services/TaskService';
import { deriveRoughArea, redactPrivateLocation } from '../../src/services/TaskLocationService';
import { buildReservationRequestHash } from '../../src/services/TaskReservationService';
import { buildDispatchExpiryRequestHash, mapLifecycleRow, type RawLifecycleRow } from '../../src/services/AutomationLifecycleService';
import { isExactCanonicalPaymentAmount } from '../../src/services/EscrowPaymentPolicy';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('engine automation contract properties', () => {
  it('task-create fingerprints are deterministic and input-sensitive', () => {
    fc.assert(fc.property(
      fc.uuid(),
      fc.string({ minLength: 10, maxLength: 80 }),
      fc.integer({ min: 500, max: 100_000 }),
      (posterId, description, price) => {
        const request = {
          posterId,
          title: 'Property test task',
          description,
          price,
          clientIdempotencyKey: 'property-test-key',
        };
        expect(buildTaskCreateRequestHash(request)).toBe(buildTaskCreateRequestHash({ ...request }));
        expect(buildTaskCreateRequestHash(request)).not.toBe(
          buildTaskCreateRequestHash({ ...request, price: price + 1 })
        );
      }
    ));
  });

  it('reservation fingerprints change when either canonical identifier changes', () => {
    fc.assert(fc.property(
      fc.uuid(),
      fc.uuid(),
      fc.uuid(),
      fc.uuid(),
      (taskId, workerId, otherTaskId, otherWorkerId) => {
      fc.pre(workerId !== otherWorkerId && taskId !== otherTaskId);
      const original = buildReservationRequestHash({ engineTaskId: taskId, hustlerRef: workerId });
      expect(original).toBe(buildReservationRequestHash({ engineTaskId: taskId, hustlerRef: workerId }));
      expect(original).not.toBe(
        buildReservationRequestHash({ engineTaskId: taskId, hustlerRef: otherWorkerId })
      );
      expect(original).not.toBe(
        buildReservationRequestHash({ engineTaskId: otherTaskId, hustlerRef: workerId })
      );
    }));
  });

  it('reservation fingerprints match the independent WebCrypto SHA-256 oracle', async () => {
    await fc.assert(fc.asyncProperty(fc.uuid(), fc.uuid(), async (engineTaskId, hustlerRef) => {
      const canonical = JSON.stringify({ engineTaskId, hustlerRef });
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
      const oracle = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      expect(buildReservationRequestHash({ engineTaskId, hustlerRef })).toBe(oracle);
    }));
  });

  it('generated street addresses never survive in the rough-area field', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 99_999 }),
      fc.constantFrom('Bellevue', 'Redmond', 'Sammamish', 'Seattle'),
      fc.integer({ min: 10_000, max: 99_999 }),
      (streetNumber, city, zip) => {
        const exact = `${streetNumber} Main Street, Unit 4, ${city}, WA ${zip}`;
        const rough = deriveRoughArea(exact);
        expect(rough).toBe(`${city}, WA area`);
        expect(rough).not.toContain(String(streetNumber));
        expect(rough).not.toContain(String(zip));
        expect(rough).not.toMatch(/Main|Street|Unit/i);
      }
    ));
  });

  it('public text redaction removes generated exact address and GPS evidence', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 99_999 }),
      fc.double({ min: 40, max: 49, noNaN: true }),
      fc.double({ min: -124, max: -116, noNaN: true }),
      (streetNumber, latitude, longitude) => {
        const lat = latitude.toFixed(5);
        const lng = longitude.toFixed(5);
        const publicText = redactPrivateLocation(
          `Task at ${streetNumber} Main Street near ${lat}, ${lng}.`
        ) ?? '';
        expect(publicText).not.toContain(`${streetNumber} Main Street`);
        expect(publicText).not.toContain(`${lat}, ${lng}`);
      }
    ));
  });

  it('dispatch-expiry fingerprints are deterministic and task-sensitive', () => {
    fc.assert(fc.property(fc.uuid(), fc.uuid(), (taskId, otherTaskId) => {
      fc.pre(taskId !== otherTaskId);
      const original = buildDispatchExpiryRequestHash({ engineTaskId: taskId, idempotencyKey: 'expiry-key-one' });
      expect(original).toBe(buildDispatchExpiryRequestHash({ engineTaskId: taskId, idempotencyKey: 'expiry-key-two' }));
      expect(original).not.toBe(buildDispatchExpiryRequestHash({ engineTaskId: otherTaskId, idempotencyKey: 'expiry-key-one' }));
    }));
  });

  it('only exact canonical integer-cent amounts can reach Stripe', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 99_999_900 }),
      fc.integer({ min: -100_000, max: 100_000 }).filter((delta) => delta !== 0),
      (price, delta) => {
        expect(isExactCanonicalPaymentAmount(price, price)).toBe(true);
        expect(isExactCanonicalPaymentAmount(price, price + delta)).toBe(false);
      }
    ));
  });

  it('never reports payout RELEASED unless canonical escrow is RELEASED', () => {
    fc.assert(fc.property(
      fc.constantFrom('PENDING', 'FUNDED', 'LOCKED_DISPUTE', 'REFUNDED'),
      fc.boolean(),
      (escrowState, hasReadyEvidence) => {
        const base: RawLifecycleRow = {
          id: '11111111-1111-4111-8111-111111111111',
          task_state: 'COMPLETED',
          progress_state: 'COMPLETED',
          worker_id: '22222222-2222-4222-8222-222222222222',
          created_at: '2026-07-10T12:00:00.000Z',
          updated_at: '2026-07-10T13:00:00.000Z',
          dispatch_expires_at: null,
          expiration_reason: null,
          refund_state: 'NOT_REQUIRED',
          refund_blocker: null,
          started_at: '2026-07-10T12:05:00.000Z',
          completion_message_delivered_at: '2026-07-10T12:30:00.000Z',
          completion_confirmed_at: '2026-07-10T13:00:00.000Z',
          payout_ready_at: hasReadyEvidence ? '2026-07-10T13:00:00.000Z' : null,
          payout_ready_reason: hasReadyEvidence ? 'poster_confirmed' : null,
          escrow_state: escrowState,
          stripe_payment_intent_id: 'pi-test',
          stripe_refund_id: null,
          reservation_state: 'ACTIVE',
          reserved_hustler_ref: '22222222-2222-4222-8222-222222222222',
          proof_state: 'ACCEPTED',
        };
        expect(mapLifecycleRow(base).payoutState).not.toBe('RELEASED');
      }
    ));
  });
});
