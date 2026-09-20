import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

vi.mock('../../src/services/NotificationService.js', () => ({
  NotificationService: {
    createInTransaction: async (query: (sql: string, values: unknown[]) => Promise<unknown>, notice: { dedupeKey: string }) => {
      await query('INSERT INTO notice_fixture(dedupe_key) VALUES($1) ON CONFLICT DO NOTHING',[notice.dedupeKey]);
    },
  },
}));

const testUrl = process.env.PROVIDER_OS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)('post-assessment quote origins (isolated PostgreSQL)', () => {
  const databaseName = `assessment_quote_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: testUrl });
  let fixture: Client;
  let database: typeof import('../../src/db.js').db;
  let quoteAfterAssessment: typeof import('../../src/services/BusinessClaimService.js').quoteAfterAssessment;
  const actor=randomUUID(), poster=randomUUID(), orgA=randomUUID(), orgB=randomUUID(), draft=randomUUID();
  const claim=randomUUID(), claimAssessment=randomUUID(), proposal=randomUUID(), proposalAssessment=randomUUID();
  let oldDatabaseUrl: string | undefined;

  beforeAll(async () => {
    const parsed=new URL(testUrl!);
    if (!['localhost','127.0.0.1'].includes(parsed.hostname) || parsed.port!=='55439') throw new Error('Isolated local PostgreSQL on port 55439 required');
    await admin.connect(); await admin.query(`CREATE DATABASE ${databaseName}`);
    const url=new URL(testUrl!); url.pathname=`/${databaseName}`;
    fixture=new Client({connectionString:url.toString()}); await fixture.connect();
    await fixture.query(`CREATE EXTENSION pgcrypto;
      CREATE TABLE users(id UUID PRIMARY KEY);
      CREATE TABLE business_organizations(id UUID PRIMARY KEY,status TEXT,provider_enabled BOOLEAN,verification_status TEXT);
      CREATE TABLE business_memberships(organization_id UUID,user_id UUID,status TEXT,role TEXT);
      CREATE FUNCTION business_require_action(org UUID, actor UUID, action TEXT) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM business_memberships WHERE organization_id=org AND user_id=actor AND status='ACTIVE' AND role='OWNER')
        THEN RAISE EXCEPTION 'Business action denied'; END IF; END $$;
      CREATE TABLE task_drafts(id UUID PRIMARY KEY,title TEXT,scope_summary TEXT,poster_user_id UUID,status TEXT,task_id UUID);
      CREATE TABLE business_task_proposals(id UUID PRIMARY KEY,task_draft_id UUID,business_organization_id UUID,status TEXT,
        quote_id UUID,responded_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
      CREATE TABLE provider_os_relationships(id UUID PRIMARY KEY);
      CREATE TABLE quotes(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),task_draft_id UUID,title TEXT,status TEXT,environment TEXT,
        is_test BOOLEAN,business_organization_id UUID,business_location_id UUID,provider_service_profile_id UUID,
        claimed_by_user_id UUID,acquisition_origin TEXT,active_version_id UUID,updated_at TIMESTAMPTZ);
      CREATE TABLE quote_versions(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),quote_id UUID,version_number INTEGER,status TEXT,
        customer_description TEXT,subtotal_cents INTEGER,service_fee_cents INTEGER,materials_cents INTEGER,discount_cents INTEGER,
        total_cents INTEGER,hustler_payout_cents INTEGER,scope_json JSONB,pay_token TEXT,arrival_window_start TIMESTAMPTZ,
        arrival_window_end TIMESTAMPTZ,expires_at TIMESTAMPTZ,dispatch_expires_at TIMESTAMPTZ);
      CREATE TABLE ops_business_claim_links(id UUID PRIMARY KEY,task_draft_id UUID,status TEXT,claimed_by_organization_id UUID,
        quote_id UUID,claimed_by_service_profile_id UUID,claimed_by_business_location_id UUID,
        proposed_customer_total_cents INTEGER,proposed_payout_cents INTEGER,updated_at TIMESTAMPTZ);
      CREATE TABLE business_assessment_requests(id UUID PRIMARY KEY,task_draft_id UUID NOT NULL,business_organization_id UUID NOT NULL,
        claim_link_id UUID,status TEXT,assessment_fee_cents INTEGER,updated_at TIMESTAMPTZ);
      CREATE TABLE assessment_payments(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),assessment_request_id UUID UNIQUE,
        task_draft_id UUID,business_organization_id UUID,poster_user_id UUID,provider TEXT,provider_payment_id TEXT,
        provider_merchant_id TEXT,amount_cents INTEGER,status TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE business_audit_events(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),organization_id UUID,actor_id UUID,
        action TEXT,object_type TEXT,object_id UUID,after_state JSONB);
      CREATE TABLE notice_fixture(dedupe_key TEXT UNIQUE);`);
    await fixture.query(readFileSync('backend/database/migrations/20260924_assessment_lifecycle_integrity.sql','utf8'));
    await fixture.query(readFileSync('backend/database/migrations/20260925_provider_os_assessment_source.sql','utf8'));
    await fixture.query('INSERT INTO users(id) VALUES($1),($2)',[actor,poster]);
    await fixture.query("INSERT INTO business_organizations VALUES($1,'ACTIVE',TRUE,'VERIFIED'),($2,'ACTIVE',TRUE,'VERIFIED')",[orgA,orgB]);
    await fixture.query("INSERT INTO business_memberships VALUES($1,$2,'ACTIVE','OWNER'),($3,$2,'ACTIVE','OWNER')",[orgA,actor,orgB]);
    await fixture.query("INSERT INTO task_drafts VALUES($1,'Exterior cleanup','Clean the outside area',$2,'open',NULL)",[draft,poster]);
    await fixture.query("INSERT INTO ops_business_claim_links(id,task_draft_id,status,claimed_by_organization_id) VALUES($1,$2,'CLAIMED',$3)",[claim,draft,orgA]);
    await fixture.query("INSERT INTO business_task_proposals(id,task_draft_id,business_organization_id,status) VALUES($1,$2,$3,'EXPIRED')",[proposal,draft,orgB]);
    await fixture.query("INSERT INTO business_assessment_requests(id,task_draft_id,business_organization_id,claim_link_id,status,assessment_fee_cents) VALUES($1,$2,$3,$4,'COMPLETED',3500)",[claimAssessment,draft,orgA,claim]);
    await fixture.query("INSERT INTO business_assessment_requests(id,task_draft_id,business_organization_id,proposal_id,status) VALUES($1,$2,$3,$4,'COMPLETED')",[proposalAssessment,draft,orgB,proposal]);
    await fixture.query("INSERT INTO assessment_payments(assessment_request_id,task_draft_id,business_organization_id,poster_user_id,provider,provider_payment_id,provider_merchant_id,amount_cents,status) VALUES($1,$2,$3,$4,'local_test','paid','local_test',3500,'SUCCEEDED')",[claimAssessment,draft,orgA,poster]);
    oldDatabaseUrl=process.env.DATABASE_URL; process.env.DATABASE_URL=url.toString();
    database=(await import('../../src/db.js')).db;
    quoteAfterAssessment=(await import('../../src/services/BusinessClaimService.js')).quoteAfterAssessment;
  },60_000);
  afterAll(async () => {
    if (database) await database.close(); if (fixture) await fixture.end();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); await admin.end();
    if (oldDatabaseUrl===undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL=oldDatabaseUrl;
  },30_000);

  function input(assessmentRequestId: string, organizationId: string) {
    return {assessmentRequestId,organizationId,actorId:actor,
      proposedCustomerTotalCents:24000,proposedPayoutCents:20000,
      arrivalWindowStart:new Date(Date.now()+5*86_400_000).toISOString(),
      arrivalWindowEnd:new Date(Date.now()+6*86_400_000).toISOString()};
  }
  it('locks the assessment without a nullable outer-join row, credits the fee, and creates a claim-origin canonical quote', async () => {
    const result=await quoteAfterAssessment(input(claimAssessment,orgA));
    expect(result.success ? 'ok' : result.error.code).toBe('ok');
    if (!result.success) return;
    const row=(await fixture.query(`SELECT q.acquisition_origin,q.status,v.total_cents,v.hustler_payout_cents,v.scope_json,
      a.quote_is_net_of_credit FROM quotes q JOIN quote_versions v ON v.id=q.active_version_id
      JOIN business_assessment_requests a ON a.quote_id=q.id WHERE q.id=$1`,[result.data.quoteId])).rows[0];
    expect(row).toMatchObject({acquisition_origin:'claim_link',status:'submitted',total_cents:20500,
      hustler_payout_cents:16500,quote_is_net_of_credit:true});
    expect(row.scope_json.assessment_credit_cents).toBe(3500);
    expect((await fixture.query('SELECT quote_id FROM ops_business_claim_links WHERE id=$1',[claim])).rows[0].quote_id).toBe(result.data.quoteId);
    const replay=await quoteAfterAssessment(input(claimAssessment,orgA));
    expect(replay.success).toBe(true);
    if (replay.success) expect(replay.data.quoteId).toBe(result.data.quoteId);
    expect((await fixture.query('SELECT id FROM quotes WHERE business_organization_id=$1',[orgA])).rows).toHaveLength(1);
  });
  it('uses the linked proposal instead of a fake claim for a second organization on the same draft', async () => {
    const denied=await quoteAfterAssessment(input(proposalAssessment,orgA));
    expect(denied).toMatchObject({success:false,error:{code:'ASSESSMENT_WRONG_BUSINESS'}});
    const result=await quoteAfterAssessment(input(proposalAssessment,orgB));
    expect(result.success ? 'ok' : result.error.code).toBe('ok');
    if (!result.success) return;
    const row=(await fixture.query('SELECT acquisition_origin,status FROM quotes WHERE id=$1',[result.data.quoteId])).rows[0];
    expect(row).toEqual({acquisition_origin:'direct_proposal',status:'submitted'});
    expect((await fixture.query('SELECT status,quote_id FROM business_task_proposals WHERE id=$1',[proposal])).rows[0])
      .toEqual({status:'QUOTED',quote_id:result.data.quoteId});
    expect((await fixture.query('SELECT total_cents FROM quote_versions WHERE id=$1',[result.data.quoteVersionId])).rows[0].total_cents).toBe(24000);
    expect((await fixture.query('SELECT dedupe_key FROM notice_fixture')).rows).toHaveLength(2);
  });
});
