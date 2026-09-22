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
      CREATE TABLE tasks(id UUID PRIMARY KEY,poster_id UUID,worker_id UUID,state TEXT);
      CREATE TABLE task_drafts(id UUID PRIMARY KEY,title TEXT,scope_summary TEXT,poster_user_id UUID,status TEXT,task_id UUID,
        quote_id UUID,category TEXT,region_code TEXT);
      CREATE TABLE proof_photos(id UUID PRIMARY KEY,proof_id UUID,storage_key TEXT);
      CREATE TABLE proof_submissions(id UUID PRIMARY KEY,photo_url TEXT);
      CREATE TABLE task_messages(id UUID PRIMARY KEY,photo_urls TEXT[]);
      CREATE TABLE business_task_proposals(id UUID PRIMARY KEY,task_draft_id UUID,business_organization_id UUID,status TEXT,
        quote_id UUID,responded_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
      CREATE TABLE provider_os_relationships(id UUID PRIMARY KEY);
      CREATE TABLE quotes(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),task_draft_id UUID,title TEXT,status TEXT,environment TEXT,
        is_test BOOLEAN,business_organization_id UUID,business_location_id UUID,provider_service_profile_id UUID,
        claimed_by_user_id UUID,acquisition_origin TEXT,active_version_id UUID,updated_at TIMESTAMPTZ,task_id UUID);
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
      CREATE TABLE notice_fixture(dedupe_key TEXT UNIQUE);`);
    // Post-assessment quotes use the same current organization/category eligibility
    // contract as ordinary quotes. Exercise its real schema rather than mocking the gate.
    for (const migration of [
      '20260718_business_workspace_contract',
      '20260718_business_operations_contract',
      '20260720_media_upload_finalization_contract',
      '20260720_private_media_delivery_contract',
      '20260913_task_draft_photos',
      '20261007_business_service_category_policy',
      '20261007_business_credentials_evidence',
      '20261008_business_quote_eligibility',
    ]) await fixture.query(readFileSync(`backend/database/migrations/${migration}.sql`, 'utf8'));
    await fixture.query(readFileSync('backend/database/migrations/20260924_assessment_lifecycle_integrity.sql','utf8'));
    await fixture.query(readFileSync('backend/database/migrations/20260925_provider_os_assessment_source.sql','utf8'));
    await fixture.query('INSERT INTO users(id) VALUES($1),($2)',[actor,poster]);
    await fixture.query(`INSERT INTO business_organizations(id,legal_name,display_name,provider_enabled,verification_status,created_by,creation_idempotency_key)
      VALUES($1,'Assessment Business A','Assessment Business A',TRUE,'VERIFIED',$3,'pg:assessment:orgA'),
      ($2,'Assessment Business B','Assessment Business B',TRUE,'VERIFIED',$3,'pg:assessment:orgB')`,[orgA,orgB,actor]);
    await fixture.query("INSERT INTO business_memberships(organization_id,user_id,status,role,invited_by) VALUES($1,$2,'ACTIVE','OWNER',$2),($3,$2,'ACTIVE','OWNER',$2)",[orgA,actor,orgB]);
    // Explicit test policy, not a claim that cleaning is legally unrestricted.
    await fixture.query("UPDATE service_category_policies SET effective_to='2026-01-01T00:00:00Z' WHERE service_category_id=(SELECT id FROM service_categories WHERE code='cleaning')");
    await fixture.query(`INSERT INTO service_category_policies(service_category_id,jurisdiction_code,policy_status,policy_version,effective_from)
      SELECT id,'US-WA','UNRESTRICTED',2,'2026-01-01T00:00:00Z' FROM service_categories WHERE code='cleaning'`);
    await fixture.query(`INSERT INTO business_service_profiles(organization_id,service_code,service_category_id,selected_by_business,service_name,service_description,pricing_mode,response_mode,created_by,creation_idempotency_key)
      SELECT organization_id,'cleaning',c.id,TRUE,'Cleaning','Assessment cleaning services','QUOTE_REQUIRED','INDIVIDUAL_OFFERS',$3,'pg:assessment:service'
      FROM service_categories c CROSS JOIN unnest(ARRAY[$1::uuid,$2::uuid]) AS organization_id WHERE c.code='cleaning'`,[orgA,orgB,actor]);
    await fixture.query("INSERT INTO task_drafts(id,title,scope_summary,poster_user_id,status,task_id,category,region_code) VALUES($1,'Exterior cleanup','Clean the outside area',$2,'open',NULL,'cleaning','US-WA')",[draft,poster]);
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
