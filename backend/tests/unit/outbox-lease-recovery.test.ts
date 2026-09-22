import { beforeEach, describe, expect, it, vi } from 'vitest';
const { query, enqueueJob } = vi.hoisted(() => ({ query: vi.fn(), enqueueJob: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query, transaction: (fn: (q: typeof query) => unknown) => fn(query) } }));
vi.mock('../../src/jobs/queues.js', () => ({ enqueueJob, signJobPayload: () => 'signature' }));
vi.mock('../../src/services/AnalyticsService.js', () => ({ AnalyticsService: { observeOutbox: vi.fn() } }));
vi.mock('../../src/logger.js', () => { const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn() }; return { logger: log, workerLogger: log }; });
import { recoverExpiredOutboxLeases, processOutboxEvents, markOutboxEventProcessed, markOutboxEventFailed } from '../../src/jobs/outbox-worker.js';

describe('outbox DB commit to queue crash recovery', () => {
  beforeEach(() => { query.mockReset(); enqueueJob.mockReset(); });
  it('recovers expired enqueued rows for every event class with bounded attempts and backoff', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    await recoverExpiredOutboxLeases();
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("status = 'enqueued'");
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("ELSE 'failed'");
    expect(sql).toContain('available_at');
    expect(sql).not.toContain('event_type =');
    expect(sql).not.toContain('provider_os');
    expect(params).toContain(5);
  });
  it('re-enqueues the same financial event using one deterministic logical job identity', async () => {
    const event = { id: 'e', event_type: 'escrow.completion_release_requested', idempotency_key: 'completion:t:1', aggregate_id: 't', aggregate_type: 'task', event_version: 1, queue_name: 'critical_payments', payload: { task_id: 't' }, attempts: 1 };
    enqueueJob.mockResolvedValue({ id: 'queue-job' });
    for (let attempt = 0; attempt < 2; attempt++) {
      query.mockResolvedValueOnce({ rows: [event], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await processOutboxEvents();
    }
    expect(enqueueJob).toHaveBeenCalledTimes(2);
    expect(enqueueJob.mock.calls[0][3].jobId).toBe(enqueueJob.mock.calls[1][3].jobId);
    expect(enqueueJob.mock.calls[0][3].retryTerminal).toBe(true);
  });
  it('recovers a committed enqueue with no queue job, then acknowledges one logical delivery', async () => {
    // Simulate process death after the DB claim commits: no queue job exists.
    let status = 'enqueued';
    let leaseExpired = false;
    let available = false;
    const jobs = new Map<string, object>();
    const event = { id: 'crashed', event_type: 'escrow.completion_release_requested',
      idempotency_key: 'completion:task:1', aggregate_id: 'task', aggregate_type: 'task',
      event_version: 1, queue_name: 'critical_payments', payload: { task_id: 'task' }, attempts: 1 };
    query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('WITH expired')) {
        if (leaseExpired && status === 'enqueued') { status = 'pending'; available = false; }
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT * FROM outbox_events')) {
        return { rows: status === 'pending' && available ? [event] : [], rowCount: 1 };
      }
      if (sql.includes("SET status = 'enqueued'")) status = 'enqueued';
      if (sql.includes("SET status = 'processed'")) status = 'processed';
      return { rows: [], rowCount: 1 };
    });
    enqueueJob.mockImplementation(async (_queue, _name, _data, options) => {
      if (!jobs.has(options.jobId)) jobs.set(options.jobId, { id: options.jobId });
      return jobs.get(options.jobId);
    });
    await recoverExpiredOutboxLeases();
    await processOutboxEvents();
    expect(jobs.size).toBe(0);
    leaseExpired = true;
    await recoverExpiredOutboxLeases();
    expect(status).toBe('pending');
    await processOutboxEvents(); // Backoff has not elapsed yet.
    expect(jobs.size).toBe(0);
    available = true;
    await processOutboxEvents();
    expect(jobs.size).toBe(1);
    await recoverExpiredOutboxLeases();
    available = true;
    await processOutboxEvents(); // At-least-once dispatch keeps its logical ID.
    expect(jobs.size).toBe(1);
    await markOutboxEventProcessed(event.idempotency_key);
    await recoverExpiredOutboxLeases();
    await processOutboxEvents();
    expect(status).toBe('processed');
    expect(jobs.size).toBe(1);
  });
  it('does not regress processed rows if a late queue failure races completion', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await markOutboxEventFailed('completed-event', 'late failure');
    expect(query.mock.calls[0][0]).toContain("status = 'enqueued'");
  });
});
