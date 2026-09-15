import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/analytics/database.js', () => ({ analyticsQuery: vi.fn(), AnalyticsCapacityError: class extends Error {} }));
vi.mock('../../src/buildIdentity.js', () => ({ buildIdentity: { revision: 'test-build', environment: 'test' } }));
import { analyticsQuery } from '../../src/services/analytics/database.js';
import { behaviorEventSchema, optionalCausalitySchema, sanitizeAnalyticsRoute, sanitizeAnalyticsReferrer } from '../../src/services/analytics/contract.js';
import { collectBehaviorEvent, trackProductEvent, observeAnalyticsOutbox } from '../../src/services/analytics/store.js';
import { analyticsRangeSchema, getProductAnalytics } from '../../src/services/analytics/metrics.js';

const id = '11111111-1111-4111-8111-111111111111';
const event = () => behaviorEventSchema.parse({ id, event_name: 'page_viewed', event_version: 1,
  occurred_at: new Date().toISOString(), anonymous_id: id, session_id: id, properties: {} });
describe('product analytics trust boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(analyticsQuery).mockResolvedValue({ rows: [], rowCount: 0 } as never);
  });
  it('rejects browser-authored business success and trust/identity claims', () => {
    for (const extra of [{ event_name: 'payment_succeeded' }, { event_name: 'task_draft_created' }, { user_id: id },
      { evidence_type: 'observed' }, { source: 'backend' }, { environment: 'production' }, { is_internal: false }]) {
      expect(behaviorEventSchema.safeParse({ ...event(), ...extra }).success).toBe(false);
    }
  });
  it('rejects narrative data, arbitrary objects, and unknown event versions', () => {
    for (const key of ['answer', 'raw_input', 'message', 'password', 'token', 'email']) {
      expect(behaviorEventSchema.safeParse({ ...event(), properties: { [key]: 'private text' } }).success).toBe(false);
    }
    expect(behaviorEventSchema.safeParse({ ...event(), event_version: 2 }).success).toBe(false);
  });
  it('accepts question state without an answer value', () => {
    expect(behaviorEventSchema.safeParse({ ...event(), event_name: 'task_intake_question_answered', properties: {
      question_key: 'surface_area', question_importance: 'recommended', answered: true, edited: true, intake_attempt_id: id,
    } }).success).toBe(true);
  });
  it('removes tokens, query strings and unknown paths', () => {
    expect(sanitizeAnalyticsRoute('/claim/secret-token?email=private#secret')).toBe('/claim/:token');
    expect(sanitizeAnalyticsRoute('/auth/callback?oobCode=secret')).toBe('/auth/callback');
    expect(sanitizeAnalyticsRoute('/unexpected/private-value')).toBe('/:unknown');
    expect(sanitizeAnalyticsReferrer('https://search.example/private?q=secret')).toBe('https://search.example');
    expect(sanitizeAnalyticsReferrer('https://user:password@example.com')).toBeNull();
  });
  it('drops malformed optional analytics without rejecting business input', () => {
    expect(optionalCausalitySchema.parse({ session_id: 'broken', raw_input: 'private' })).toBeUndefined();
    expect(optionalCausalitySchema.parse(undefined)).toBeUndefined();
  });
  it('deduplicates collection while keeping server and browser namespaces separate', async () => {
    const inserts: unknown[][] = [];
    const seen = new Set<string>();
    vi.mocked(analyticsQuery).mockImplementation(async (sql, args) => {
      if (String(sql).includes('INSERT INTO analytics_events')) {
        const values = args as unknown[]; inserts.push(values);
        const key = String(values.at(-1));
        const duplicate = seen.has(key); seen.add(key);
        return { rows: duplicate ? [] : [{ id }], rowCount: duplicate ? 0 : 1 } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    });
    expect((await collectBehaviorEvent(event(), {})).accepted).toBe(true);
    expect((await collectBehaviorEvent(event(), {})).duplicate).toBe(true);
    await trackProductEvent({ event_name: 'task_draft_created', deduplication_key: id, task_draft_id: id });
    expect(String(inserts[0].at(-1))).toBe(`browser:${id}:${id}`);
    expect(String(inserts[2].at(-1))).toBe(`backend:task_draft_created:${id}`);
  });
  it('does not reject business operations on analytics database failures', async () => {
    vi.mocked(analyticsQuery).mockRejectedValue(new Error('offline'));
    await expect(trackProductEvent({ event_name: 'quote_approved', quote_id: id })).resolves.toBeUndefined();
    expect((await collectBehaviorEvent(event(), {})).accepted).toBe(false);
  });
  it('honors explicit opt-out and fails closed if consent is unavailable', async () => {
    vi.mocked(analyticsQuery).mockRejectedValue(new Error('consent unavailable'));
    expect((await collectBehaviorEvent(event(), { userId: id })).reason).toBe('unavailable');
    expect(vi.mocked(analyticsQuery).mock.calls.some(([sql]) => String(sql).includes('INSERT INTO analytics_events'))).toBe(false);
  });
  it('respects an explicit denied analytics consent', async () => {
    vi.mocked(analyticsQuery).mockResolvedValue({ rows: [{ granted: false }], rowCount: 1 } as never);
    expect((await collectBehaviorEvent(event(), { userId: id })).reason).toBe('consent');
    expect(analyticsQuery).toHaveBeenCalledTimes(1);
  });
  it('classifies linked test-task telemetry as internal without trusting a browser flag', async () => {
    vi.mocked(analyticsQuery).mockImplementation(async (sql) => {
      if (String(sql).includes('AS internal')) return { rows: [{ internal: false, test: true }] } as never;
      return { rows: [{ id }], rowCount: 1 } as never;
    });
    await trackProductEvent({ event_name: 'task_started', task_id: id });
    const insert = vi.mocked(analyticsQuery).mock.calls.find(([sql]) => String(sql).includes('INSERT INTO analytics_events'));
    expect(insert?.[1]?.[10]).toBe(true);
  });
  it('does not call an escrow release request proof of completion', async () => {
    await observeAnalyticsOutbox({ id, aggregate_id: id, event_type: 'escrow.completion_release_requested',
      payload: { task_id: id }, created_at: new Date() });
    expect(vi.mocked(analyticsQuery).mock.calls.some(([sql]) => String(sql).includes('INSERT INTO analytics_events'))).toBe(false);
  });
  it('reports unavailable sections rather than fabricated zero counts', async () => {
    vi.mocked(analyticsQuery).mockRejectedValue(new Error('missing migration'));
    const report = await getProductAnalytics(analyticsRangeSchema.parse({ days: 30 }));
    expect(report.overview.available).toBe(false);
    expect(report.marketplace.available).toBe(false);
    expect(report.marketplace.rows).toEqual([]);
  });
  it('omits selection latency instead of treating mutable send-ready state as acceptance time', async () => {
    const report = await getProductAnalytics(analyticsRangeSchema.parse({ days: 30 }));
    const marketplaceSql = vi.mocked(analyticsQuery).mock.calls.map(([sql]) => sql)
      .find((sql) => sql.includes("'mean_selected_quote_cents'"));
    expect(marketplaceSql).toBeDefined();
    expect(marketplaceSql).not.toContain('mean_draft_to_selection_seconds');
    expect(marketplaceSql).not.toContain('quote_send_ready_at');
    expect(report.version).toBe(report.definitions.version);
    expect(report.definitions.marketplace).toContain('Selection/approval latency is omitted');
  });
  it('requires bounded, ordered date ranges', () => {
    expect(analyticsRangeSchema.safeParse({ start: '2026-01-01T00:00:00Z' }).success).toBe(false);
    expect(analyticsRangeSchema.safeParse({ start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' }).success).toBe(false);
  });
  it('does not let a browser route mark an external actor internal', async () => {
    vi.mocked(analyticsQuery).mockImplementation(async (sql) => {
      if (sql.includes('AS internal')) return { rows: [{ internal: false, test: false }], rowCount: 1 } as never;
      return { rows: [{ id }], rowCount: 1 } as never;
    });
    await collectBehaviorEvent({ ...event(), route: '/ops/analytics' }, {});
    const insert = vi.mocked(analyticsQuery).mock.calls.find(([sql]) => sql.includes('INSERT INTO analytics_events'));
    expect(insert?.[1]?.[10]).toBe(false);
  });
});
