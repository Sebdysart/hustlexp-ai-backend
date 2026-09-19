import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

vi.mock('../../src/services/NotificationService.js', () => ({
  NotificationService: {
    createForBusinessInTransaction: async (query: (sql: string, values: unknown[]) => Promise<unknown>, organizationId: string, notice: { dedupeKey: string }) => {
      await query('INSERT INTO notice_fixture(organization_id,dedupe_key) VALUES($1,$2) ON CONFLICT DO NOTHING', [organizationId,notice.dedupeKey]);
    },
  },
}));

const testUrl = process.env.PROVIDER_OS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)('assessment controlled payment (isolated PostgreSQL)', () => {
  const databaseName = `assessment_pay_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: testUrl });
  let fixture: Client;
  let database: typeof import('../../src/db.js').db;
  let service: typeof import('../../src/services/AssessmentPaymentService.js');
  const actor = randomUUID(), otherActor = randomUUID(), org = randomUUID(), draft = randomUUID(), assessment = randomUUID();
  const previous = new Map<string, string | undefined>();
  const variables = ['DATABASE_URL','NODE_ENV','PAYMENT_PROVIDER','HXOS_ALLOW_LOCAL_TEST_PAYMENT',
    'HXOS_ALLOW_LOCAL_TEST_PAYMENT_IN_PRODUCTION','ENGINE_API_MODE','STRIPE_MODE',
    'HXOS_LOCAL_TEST_PAYMENT_SECRET','HX_PAYMENT_CREATION_MODE'];

  beforeAll(async () => {
    const parsed = new URL(testUrl!);
    if (!['localhost','127.0.0.1'].includes(parsed.hostname) || parsed.port !== '55439') throw new Error('Isolated local PostgreSQL on port 55439 required');
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const fixtureUrl = new URL(testUrl!); fixtureUrl.pathname = `/${databaseName}`;
    fixture = new Client({ connectionString: fixtureUrl.toString() }); await fixture.connect();
    await fixture.query(`CREATE EXTENSION pgcrypto;
      CREATE TABLE users(id UUID PRIMARY KEY);
      CREATE TABLE business_organizations(id UUID PRIMARY KEY);
      CREATE TABLE task_drafts(id UUID PRIMARY KEY,poster_user_id UUID NOT NULL REFERENCES users(id));
      CREATE TABLE business_task_proposals(id UUID PRIMARY KEY,task_draft_id UUID,business_organization_id UUID);
      CREATE TABLE quotes(id UUID PRIMARY KEY);
      CREATE TABLE ops_business_claim_links(id UUID PRIMARY KEY,quote_id UUID);
      CREATE TABLE business_assessment_requests(id UUID PRIMARY KEY,task_draft_id UUID NOT NULL REFERENCES task_drafts(id),
        business_organization_id UUID NOT NULL REFERENCES business_organizations(id),claim_link_id UUID,
        assessment_fee_cents INTEGER,assessment_platform_fee_cents INTEGER,status TEXT NOT NULL);
      CREATE TABLE assessment_payments(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        assessment_request_id UUID NOT NULL UNIQUE REFERENCES business_assessment_requests(id),
        task_draft_id UUID NOT NULL REFERENCES task_drafts(id),
        business_organization_id UUID NOT NULL REFERENCES business_organizations(id),
        poster_user_id UUID NOT NULL REFERENCES users(id),provider TEXT NOT NULL,
        provider_payment_id TEXT NOT NULL,provider_merchant_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,platform_fee_cents INTEGER NOT NULL,status TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(provider,provider_payment_id));
      CREATE TABLE notice_fixture(organization_id UUID,dedupe_key TEXT UNIQUE);`);
    await fixture.query(readFileSync('backend/database/migrations/20260924_assessment_lifecycle_integrity.sql','utf8'));
    await fixture.query('INSERT INTO users(id) VALUES($1),($2)',[actor,otherActor]);
    await fixture.query('INSERT INTO business_organizations(id) VALUES($1)',[org]);
    await fixture.query('INSERT INTO task_drafts(id,poster_user_id) VALUES($1,$2)',[draft,actor]);
    await fixture.query(`INSERT INTO business_assessment_requests(id,task_draft_id,business_organization_id,assessment_fee_cents,status)
      VALUES($1,$2,$3,4500,'AWAITING_CUSTOMER')`,[assessment,draft,org]);
    for (const name of variables) previous.set(name,process.env[name]);
    process.env.DATABASE_URL = fixtureUrl.toString();
    process.env.NODE_ENV = 'production'; process.env.PAYMENT_PROVIDER = 'local_test';
    process.env.HXOS_ALLOW_LOCAL_TEST_PAYMENT = 'true';
    process.env.HXOS_ALLOW_LOCAL_TEST_PAYMENT_IN_PRODUCTION = 'true';
    process.env.ENGINE_API_MODE = 'test'; process.env.STRIPE_MODE = 'test';
    process.env.HXOS_LOCAL_TEST_PAYMENT_SECRET = 'assessment-certification-secret-at-least-32-characters';
    process.env.HX_PAYMENT_CREATION_MODE = 'enabled';
    database = (await import('../../src/db.js')).db;
    service = await import('../../src/services/AssessmentPaymentService.js');
  }, 60_000);

  afterAll(async () => {
    if (database) await database.close();
    if (fixture) await fixture.end();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); await admin.end();
    for (const [name,value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name]=value; }
  }, 30_000);

  it('persists a pending payment and provider intent before confirmation, with server fee and owner binding', async () => {
    await expect(service.createAssessmentPayment(assessment,otherActor)).rejects.toMatchObject({code:'NOT_FOUND'});
    const created = await service.createAssessmentPayment(assessment,actor);
    expect(created).toMatchObject({status:'PENDING',amountCents:4500,testMode:true});
    expect((await fixture.query('SELECT status,provider_merchant_id,amount_cents,platform_fee_cents,currency FROM assessment_payments')).rows)
      .toEqual([{status:'PENDING',provider_merchant_id:'local_test',amount_cents:4500,platform_fee_cents:0,currency:'USD'}]);
    expect((await fixture.query('SELECT status FROM hxos_local_test_assessment_intents')).rows).toEqual([{status:'requires_confirmation'}]);
    await expect(service.confirmAssessmentPayment(assessment,otherActor,created.clientSecret!)).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(service.confirmAssessmentPayment(assessment,actor,'wrong'.repeat(16))).rejects.toMatchObject({code:'FORBIDDEN'});
    expect((await fixture.query('SELECT status FROM assessment_payments')).rows[0].status).toBe('PENDING');
  });

  it('reuses pending identity, obeys the creation freeze, and still confirms existing work', async () => {
    const replay = await service.createAssessmentPayment(assessment,actor);
    expect((await fixture.query('SELECT id FROM assessment_payments')).rows).toHaveLength(1);
    process.env.HX_PAYMENT_CREATION_MODE='frozen';
    const pending = await service.createAssessmentPayment(assessment,actor);
    expect(pending.paymentIntentId).toBe(replay.paymentIntentId);
    const settled = await service.confirmAssessmentPayment(assessment,actor,pending.clientSecret!);
    expect(settled.status).toBe('SUCCEEDED');
    process.env.HX_PAYMENT_CREATION_MODE='enabled';
    const again = await service.confirmAssessmentPayment(assessment,actor,pending.clientSecret!);
    expect(again.status).toBe('SUCCEEDED');
    expect((await fixture.query('SELECT dedupe_key FROM notice_fixture')).rows).toHaveLength(1);
    expect((await fixture.query("SELECT id FROM hxos_local_test_assessment_events WHERE event_type='intent_succeeded'")).rows).toHaveLength(1);
  });

  it('rejects new creation when frozen and never treats a mismatched amount as success', async () => {
    const nextDraft=randomUUID(), nextAssessment=randomUUID();
    await fixture.query('INSERT INTO task_drafts(id,poster_user_id) VALUES($1,$2)',[nextDraft,actor]);
    await fixture.query(`INSERT INTO business_assessment_requests(id,task_draft_id,business_organization_id,assessment_fee_cents,status)
      VALUES($1,$2,$3,2500,'AWAITING_CUSTOMER')`,[nextAssessment,nextDraft,org]);
    process.env.HX_PAYMENT_CREATION_MODE='frozen';
    await expect(service.createAssessmentPayment(nextAssessment,actor)).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
    expect((await fixture.query('SELECT id FROM assessment_payments WHERE assessment_request_id=$1',[nextAssessment])).rows).toHaveLength(0);
    process.env.HX_PAYMENT_CREATION_MODE='enabled';
    const created = await service.createAssessmentPayment(nextAssessment,actor);
    await fixture.query('UPDATE assessment_payments SET amount_cents=2600 WHERE assessment_request_id=$1',[nextAssessment]);
    await expect(service.confirmAssessmentPayment(nextAssessment,actor,created.clientSecret!)).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  });
});
