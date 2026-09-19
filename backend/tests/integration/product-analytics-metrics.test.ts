import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
vi.mock('../../src/services/analytics/database.js', () => ({ analyticsQuery: vi.fn() }));
vi.mock('../../src/services/analytics/store.js', () => ({ analyticsEnvironment: 'analytics-test', internalAnalyticsUsers: () => [] }));
import { analyticsQuery } from '../../src/services/analytics/database.js';
import { analyticsRangeSchema, getProductAnalytics } from '../../src/services/analytics/metrics.js';

// Explicit opt-in to a dedicated local test DB. Only connection-private TEMP
// tables are used; each fixture transaction rolls back. Never uses DATABASE_URL.
const url = process.env.ANALYTICS_TEST_DATABASE_URL;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
describe.skipIf(!url)('product analytics SQL semantics', () => {
  let client: pg.Client;
  let sequence = 1000;
  let base: number;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`SET search_path TO pg_temp;
      CREATE TEMP TABLE analytics_events(id uuid, event_version int DEFAULT 1, environment text DEFAULT 'analytics-test',
        event_type text, source text, outcome text, properties jsonb, event_timestamp timestamptz, ingested_at timestamptz,
        session_id uuid, anonymous_id uuid, user_id uuid, is_internal boolean DEFAULT false,
        device_type text, utm_source text, utm_campaign text, build_id text, task_draft_id uuid, task_id uuid,
        quote_id uuid, proposal_id uuid, task_category text, intake_profile text, reason_code text);
      CREATE TEMP TABLE admin_roles(user_id uuid);
      CREATE TEMP TABLE business_task_proposals(id uuid,quote_id uuid);
      CREATE TEMP TABLE task_drafts(id uuid,poster_user_id uuid,created_at timestamptz,quote_id uuid,task_id uuid,
        scheduled_service_date date,quote_send_ready_at timestamptz);
      CREATE TEMP TABLE quotes(id uuid,task_draft_id uuid,task_id uuid,is_test boolean DEFAULT false,
        environment text DEFAULT 'PRODUCTION',active_version_id uuid);
      CREATE TEMP TABLE quote_versions(id uuid,total_cents int);
      CREATE TEMP TABLE quote_payments(quote_id uuid,task_id uuid,status text);
      CREATE TEMP TABLE tasks(id uuid,state text,worker_id uuid,completed_at timestamptz);
      CREATE TEMP TABLE escrows(task_id uuid,state text);
      CREATE TEMP TABLE support_threads(status text,created_at timestamptz,resolved_at timestamptz,
        opened_by_user_id uuid,quote_id uuid,task_id uuid,task_draft_id uuid,proposal_id uuid);
      CREATE TEMP TABLE analytics_ingestion_health(hour timestamptz,environment text,counter text,count bigint);`);
    vi.mocked(analyticsQuery).mockImplementation(async (sql, params) => {
      const result = await client.query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 } as never;
    });
  });
  beforeEach(async () => { base = Date.now() - 86400000; sequence = 1000; await client.query('BEGIN'); });
  afterEach(async () => { await client.query('ROLLBACK'); });
  afterAll(async () => { await client?.end(); });
  async function event(attempt: number, name: string, options: {
    user?: number; anonymous?: number; draft?: number; build?: string; category?: string;
    profile?: string; question?: string; at?: number;
  } = {}) {
    const time = new Date(base + (options.at ?? ++sequence));
    await client.query(`INSERT INTO analytics_events(id,event_type,source,outcome,properties,event_timestamp,ingested_at,
      session_id,anonymous_id,user_id,task_draft_id,build_id,task_category,intake_profile)
      VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13)`, [id(++sequence), name,
      name === 'task_draft_created' ? 'backend' : 'browser', name === 'task_draft_created' ? 'committed' : null,
      JSON.stringify({ intake_attempt_id: id(attempt), ...(options.question ? { question_key: options.question, question_importance: 'required' } : {}) }),
      time,id(900),id(options.anonymous ?? 800),options.user ? id(options.user) : null,
      options.draft ? id(options.draft) : null,options.build ?? 'A',options.category ?? null,options.profile ?? null]);
  }
  async function draft(n: number, owner = 500, approved = false) {
    await client.query(`INSERT INTO task_drafts(id,poster_user_id,created_at,scheduled_service_date,quote_send_ready_at)
      VALUES($1,$2,$3,$4,$3)`, [id(n), id(owner),new Date(base),approved ? '2026-09-20' : null]);
  }
  async function link(attempt: number, n: number, user = 500) {
    await event(attempt, 'task_intake_started');
    await event(attempt, 'task_draft_created', { draft: n, user });
  }
  async function paid(n: number, state = 'FUNDED', status = 'SUCCEEDED') {
    await client.query('UPDATE task_drafts SET quote_id=$2,task_id=$3 WHERE id=$1',[id(n),id(n+100),id(n+200)]);
    await client.query('INSERT INTO quotes(id,task_draft_id,task_id) VALUES($1,$2,$3)',[id(n+100),id(n),id(n+200)]);
    await client.query('INSERT INTO tasks(id,state) VALUES($1,\'ACCEPTED\')',[id(n+200)]);
    await client.query('INSERT INTO quote_payments VALUES($1,$2,$3)',[id(n+100),id(n+200),status]);
    await client.query('INSERT INTO escrows VALUES($1,$2)',[id(n+200),state]);
  }
  async function report(build?: string) {
    const r = await getProductAnalytics(analyticsRangeSchema.parse({ days: 7, build }));
    for (const section of [r.overview,r.intake,r.questions,r.funnel,r.marketplace,r.support,r.health,r.provider,r.coverage,r.friction]) {
      expect(section.available).toBe(true); // SQL errors must not masquerade as passing empty fixtures.
    }
    return r;
  }
  it('links a single draft, preserving anonymous-to-authenticated continuity and repeat observations', async () => {
    await draft(1); await link(1,1); await event(1,'task_draft_created',{ draft: 1,user: 500 });
    expect((await report()).funnel.rows[0]).toMatchObject({ started: 1,draft_created: 1,unlinked: 0,linkage: { resolved: 1 } });
  });
  it('does not select either draft when a duplicated/reused attempt creates two', async () => {
    await draft(1); await draft(2); await paid(1); await link(1,1);
    await event(1,'task_draft_created',{ draft: 2,user: 500 });
    expect((await report()).funnel.rows[0]).toMatchObject({ started: 1,draft_created: 0,paid: 0,unlinked: 1,linkage: { multiple_drafts: 1 } });
  });
  it('detects conflicting users, anonymous identities, and canonical ownership mismatches', async () => {
    await draft(1); await link(1,1); await event(1,'task_preview_viewed',{ user: 501 });
    await draft(2); await link(2,2); await event(2,'task_preview_viewed',{ anonymous: 801 });
    await draft(3,502); await link(3,3,500);
    expect((await report()).funnel.rows[0]).toMatchObject({ draft_created: 0,unlinked: 3,
      linkage: { conflicting_users: 2, conflicting_anonymous: 1 } });
  });
  it('does not hide conflicting evidence with the internal filter', async () => {
    await draft(1); await link(1,1); await event(1,'task_preview_viewed',{ user: 501 });
    await client.query('UPDATE analytics_events SET is_internal=true WHERE user_id=$1',[id(501)]);
    expect((await report()).funnel.rows[0]).toMatchObject({ draft_created: 0,linkage: { conflicting_users: 1 } });
  });
  it('counts full/partial refunds through escrow, ignoring paid-unrefunded/pending and duplicate joins', async () => {
    for (const n of [1,2,3,4]) await draft(n);
    await paid(1,'REFUNDED'); await paid(2,'REFUND_PARTIAL'); await paid(3); await paid(4,'REFUNDED','PENDING');
    await client.query('INSERT INTO quote_payments SELECT * FROM quote_payments WHERE quote_id=$1',[id(101)]);
    expect((await report()).marketplace.rows[0]).toMatchObject({ fully_refunded_quotes: 1,partially_refunded_quotes: 1,paid_tasks: 3 });
  });
  it('never exposes operational send-ready timestamps as selection latency', async () => {
    await draft(1,500,true); await paid(1);
    const before = (await report()).marketplace.rows[0];
    await client.query("UPDATE task_drafts SET quote_send_ready_at=created_at+interval '3 days'");
    const after = (await report()).marketplace.rows[0];
    expect(before).not.toHaveProperty('mean_draft_to_selection_seconds');
    expect(after).not.toHaveProperty('mean_draft_to_selection_seconds');
    expect(after.selected_quotes).toBe(before.selected_quotes);
  });
  it('uses intersections rather than unrelated stage counts for conditional rates', async () => {
    await draft(1); await paid(1); await link(1,1); // Paid, but no dated approval.
    await draft(2,500,true); await link(2,2);
    await client.query('UPDATE task_drafts SET quote_id=$2 WHERE id=$1',[id(2),id(102)]);
    await client.query('INSERT INTO quotes(id,task_draft_id) VALUES($1,$2)',[id(102),id(2)]);
    const funnel = (await report()).funnel.rows[0];
    expect(funnel).toMatchObject({ started: 2,draft_created: 2,quote_created: 2,quote_approved: 1,paid: 1,paid_from_previous: 0 });
    for (const [stage,previous] of [['draft_created','started'],['quote_created','draft_created'],['quote_approved','quote_created'],['paid','quote_approved'],['completed','paid']]) {
      expect(Number(funnel[`${stage}_from_previous`])).toBeLessThanOrEqual(Number(funnel[previous]));
    }
  });
  it('selects the first start before applying build segmentation', async () => {
    await event(1,'task_intake_started',{ build: 'A',at: 1 });
    await event(1,'task_intake_started',{ build: 'B',at: 2 });
    expect((await report('A')).funnel.rows[0].started).toBe(1);
    expect((await report('B')).funnel.rows[0].started).toBe(0);
  });
  it('clears the previous profile and scopes last question views to category/profile/key', async () => {
    await event(1,'task_intake_started');
    await event(1,'task_category_resolved',{ category: 'cleaning',profile: 'cleaning_indoor' });
    await event(1,'task_category_resolved',{ category: 'moving' });
    await event(1,'task_intake_question_viewed',{ category: 'moving',question: 'stairs' });
    await event(1,'task_intake_question_viewed',{ category: 'cleaning',profile: 'cleaning_surface',question: 'stairs' });
    await event(1,'task_category_resolved',{ category: 'handyman' });
    const r = await report();
    expect(r.intake.rows.find((row) => row.dimension === 'profile')?.value).toBe('unknown');
    expect(r.intake.rows.find((row) => row.dimension === 'category')?.value).toBe('handyman');
    expect(r.questions.rows.find((row) => row.category === 'moving')?.inactive_last_view).toBe(0);
    expect(r.questions.rows.find((row) => row.category === 'cleaning')?.inactive_last_view).toBe(1);
  });
});
