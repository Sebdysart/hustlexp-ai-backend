import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), notify: vi.fn(), analytics: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query, transaction: mocks.transaction } }));
vi.mock('../../src/auth/firebase.js', () => ({ firebaseAuth: {} }));
vi.mock('../../src/services/NotificationService.js', () => ({ NotificationService: { createForOperationsInTransaction: mocks.notify, createInTransaction: mocks.notify } }));
vi.mock('../../src/services/AnalyticsService.js', () => ({ AnalyticsService: { track: mocks.analytics } }));
import { supportRouter } from '../../src/routers/support.js';
import { businessAssessmentRouter } from '../../src/routers/businessAssessment.js';
const url = process.env.PROVIDER_OS_TEST_DATABASE_URL;
describe.skipIf(!url)('support notification commit boundary (isolated PostgreSQL)', () => {
  const client = new Client({ connectionString: url });
  const schema = `support_test_${randomUUID().replaceAll('-', '')}`, actor = randomUUID();
  const query = (sql: string, params?: unknown[]) => client.query(sql, params);
  const caller = supportRouter.createCaller({ user: { id: actor, account_status: 'ACTIVE' } as never, firebaseUid: actor });
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['localhost','127.0.0.1'].includes(parsed.hostname) || parsed.port !== '55439') throw new Error('Isolated local test database required');
    await client.connect(); await query(`CREATE SCHEMA ${schema}`); await query(`SET search_path TO ${schema}`);
    await query(`CREATE TABLE users(id UUID PRIMARY KEY);
      CREATE TABLE support_threads(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),opened_by_user_id UUID,business_organization_id UUID,
        status TEXT,subject TEXT,context_type TEXT,task_draft_id UUID,task_id UUID,proposal_id UUID,quote_id UUID,source_route TEXT,
        resolved_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE support_messages(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),thread_id UUID,sender_user_id UUID,sender_kind TEXT,body TEXT);
      CREATE TABLE notice_fixture(thread_id UUID);
      CREATE TABLE task_drafts(id UUID PRIMARY KEY,poster_user_id UUID);
      CREATE TABLE business_memberships(organization_id UUID,user_id UUID,status TEXT);
      CREATE TABLE business_assessment_requests(id UUID PRIMARY KEY,task_draft_id UUID,business_organization_id UUID,
        status TEXT,completed_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
      CREATE FUNCTION business_membership_has_action(UUID,UUID,TEXT) RETURNS BOOLEAN LANGUAGE sql AS
        'SELECT EXISTS(SELECT 1 FROM business_memberships WHERE organization_id=$1 AND user_id=$2 AND status=''ACTIVE'')';`);
    await query('INSERT INTO users VALUES($1)',[actor]); mocks.query.mockImplementation(query);
    mocks.transaction.mockImplementation(async fn => {
      const connection = new Client({connectionString:url}); await connection.connect();
      const tx = (sql:string, params?:unknown[]) => connection.query(sql,params);
      try { await tx(`SET search_path TO ${schema}`); await tx('BEGIN'); const result = await fn(tx); await tx('COMMIT'); return result; }
      catch(e) { await tx('ROLLBACK'); throw e; } finally { await connection.end(); }
    });
  });
  afterAll(async () => { await query(`DROP SCHEMA ${schema} CASCADE`); await client.end(); });
  it('rolls back thread/reply on notice failure and serializes duplicate creation retries', async () => {
    const input = {subject:'Help',message:'A question',contextType:'GENERAL' as const};
    mocks.notify.mockRejectedValue(new Error('notification unavailable'));
    await expect(caller.createThread(input)).rejects.toThrow('notification unavailable');
    expect((await query('SELECT * FROM support_threads')).rows).toHaveLength(0);
    expect(mocks.analytics).not.toHaveBeenCalled();
    mocks.notify.mockImplementation((tx, notice) => tx('INSERT INTO notice_fixture VALUES($1)',[notice.entityId]));
    const created = await Promise.all([caller.createThread(input),caller.createThread(input)]);
    expect(created[0].threadId).toBe(created[1].threadId);
    expect((await query('SELECT * FROM support_messages')).rows).toHaveLength(1);
    expect((await query('SELECT * FROM notice_fixture')).rows).toHaveLength(1);
    mocks.notify.mockRejectedValue(new Error('notification unavailable'));
    await expect(caller.reply({threadId:created[0].threadId,message:'Followup'})).rejects.toThrow();
    expect((await query('SELECT * FROM support_messages')).rows).toHaveLength(1);
    mocks.notify.mockImplementation((tx, notice) => tx('INSERT INTO notice_fixture VALUES($1)',[notice.entityId]));
    await caller.reply({threadId:created[0].threadId,message:'Followup'});
    expect((await query('SELECT * FROM support_messages')).rows).toHaveLength(2);
    await query("UPDATE support_threads SET status='RESOLVED'");
    await expect(caller.reply({threadId:created[0].threadId,message:'Too late'})).rejects.toThrow('resolved');
  });
  it('keeps assessment completion retryable if its notice fails, without letting another member complete it', async () => {
    const organization = randomUUID(), draft = randomUUID(), assessment = randomUUID(), otherActor = randomUUID();
    await query('INSERT INTO task_drafts VALUES($1,$2)',[draft,randomUUID()]);
    await query("INSERT INTO business_memberships VALUES($1,$2,'ACTIVE'),($3,$4,'ACTIVE')",[organization,actor,randomUUID(),otherActor]);
    await query("INSERT INTO business_assessment_requests VALUES($1,$2,$3,'SCHEDULED',NULL,NOW())",[assessment,draft,organization]);
    const assessmentCaller = businessAssessmentRouter.createCaller({user:{id:actor,account_status:'ACTIVE'} as never,firebaseUid:actor});
    const otherCaller = businessAssessmentRouter.createCaller({user:{id:otherActor,account_status:'ACTIVE'} as never,firebaseUid:otherActor});
    await expect(otherCaller.complete({assessmentRequestId:assessment})).rejects.toThrow('cannot be completed');
    mocks.notify.mockRejectedValue(new Error('notification unavailable'));
    await expect(assessmentCaller.complete({assessmentRequestId:assessment})).rejects.toThrow('notification unavailable');
    expect((await query('SELECT status FROM business_assessment_requests WHERE id=$1',[assessment])).rows[0].status).toBe('SCHEDULED');
    mocks.notify.mockImplementation((tx, notice) => tx('INSERT INTO notice_fixture VALUES($1)',[notice.entityId]));
    await assessmentCaller.complete({assessmentRequestId:assessment});
    expect((await query('SELECT status FROM business_assessment_requests WHERE id=$1',[assessment])).rows[0].status).toBe('COMPLETED');
    expect((await query('SELECT * FROM notice_fixture WHERE thread_id=$1',[assessment])).rows).toHaveLength(1);
    await expect(assessmentCaller.complete({assessmentRequestId:assessment})).rejects.toThrow('cannot be completed');
  });
});
