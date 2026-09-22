import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import type { QueryFn } from '../../src/db.js';
import { evaluateBusinessTaskEligibility, persistBusinessQuoteEligibilityDecision } from '../../src/services/BusinessTaskEligibilityService.js';

const testUrl=process.env.PROVIDER_OS_TEST_DATABASE_URL;
const migration=(file:string)=>readFileSync(`backend/database/migrations/${file}.sql`,'utf8');
const stageMigrations=['20261007_business_service_category_policy','20261007_business_credentials_evidence','20261008_business_quote_eligibility'];

describe.skipIf(!testUrl)('Stage-1 business eligibility (isolated PostgreSQL)',()=>{
  const databaseName=`business_eligibility_${randomUUID().replaceAll('-','')}`;
  const admin=new Client({connectionString:testUrl});
  const actorId=randomUUID(),organizationId=randomUUID(),foreignOrgId=randomUUID(),legacyCredentialId=randomUUID();
  let fixture:Client;
  let created=false;
  let database:typeof import('../../src/db.js').db;
  let credentials:typeof import('../../src/services/BusinessCredentialService.js');
  let workspace:typeof import('../../src/services/BusinessWorkspaceService.js');
  let oldDatabaseUrl:string|undefined;
  let policyId:string;
  let credentialTypeId:string;
  let allowedQuoteId:string;
  let allowedDraftId:string;
  let submitted:{id:string;status:'PENDING';versionId:string};

  beforeAll(async()=>{
    const parsed=new URL(testUrl!);
    if(!['localhost','127.0.0.1'].includes(parsed.hostname)||parsed.port!=='55439') throw new Error('Only isolated local PostgreSQL on port 55439 is allowed.');
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);created=true;
    const fixtureUrl=new URL(testUrl!);fixtureUrl.pathname=`/${databaseName}`;
    fixture=new Client({connectionString:fixtureUrl.toString()});await fixture.connect();
    // Real business + private-media migrations; only unrelated domain base tables
    // are reduced to the columns required by those migration contracts.
    await fixture.query(`CREATE EXTENSION pgcrypto;
      CREATE TABLE users(id UUID PRIMARY KEY,full_name TEXT NOT NULL,email TEXT,account_status TEXT NOT NULL DEFAULT 'ACTIVE');
      CREATE TABLE admin_roles(user_id UUID PRIMARY KEY REFERENCES users(id),role TEXT,can_manage_operations BOOLEAN,can_modify_trust BOOLEAN);
      CREATE TABLE tasks(id UUID PRIMARY KEY,poster_id UUID,worker_id UUID,state TEXT);
      CREATE TABLE task_drafts(id UUID PRIMARY KEY,category TEXT,region_code TEXT,task_id UUID,quote_id UUID,structured JSONB);
      CREATE TABLE quotes(id UUID PRIMARY KEY,task_draft_id UUID REFERENCES task_drafts(id),business_organization_id UUID,task_id UUID,status TEXT);
      CREATE TABLE quote_versions(id UUID PRIMARY KEY,quote_id UUID REFERENCES quotes(id));
      CREATE TABLE proof_photos(id UUID PRIMARY KEY,proof_id UUID,storage_key TEXT);
      CREATE TABLE proof_submissions(id UUID PRIMARY KEY,photo_url TEXT);
      CREATE TABLE task_messages(id UUID PRIMARY KEY,photo_urls TEXT[]);
      CREATE TABLE ops_action_audit(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),actor_user_id UUID,actor_label TEXT,action TEXT,target_type TEXT,target_id UUID,meta JSONB);`);
    for(const file of ['20260718_business_workspace_contract','20260718_business_operations_contract','20260720_media_upload_finalization_contract','20260720_private_media_delivery_contract','20260913_task_draft_photos']) await fixture.query(migration(file));
    await fixture.query("INSERT INTO users(id,full_name,email) VALUES($1,'Credential Owner','owner@example.test')",[actorId]);
    await fixture.query("INSERT INTO admin_roles VALUES($1,'admin',TRUE,TRUE)",[actorId]);
    await fixture.query(`INSERT INTO business_organizations(id,legal_name,display_name,provider_enabled,created_by,creation_idempotency_key)
      VALUES($1,'Primary Business LLC','Primary Business',TRUE,$3,'pg:primary:org'),($2,'Foreign Business LLC','Foreign Business',TRUE,$3,'pg:foreign:org')`,[organizationId,foreignOrgId,actorId]);
    await fixture.query(`INSERT INTO business_memberships(organization_id,user_id,role,status,invited_by) VALUES($1,$2,'OWNER','ACTIVE',$2)`,[organizationId,actorId]);
    await fixture.query(`INSERT INTO business_service_profiles(organization_id,service_code,service_name,service_description,pricing_mode,response_mode,created_by,creation_idempotency_key)
      VALUES($1,'CLEANING','Cleaning','Existing cleaning services','QUOTE_REQUIRED','INDIVIDUAL_OFFERS',$2,'pg:legacy:cleaning'),
      ($1,'CUSTOM_SPECIAL','Custom work','Unknown historic service','QUOTE_REQUIRED','INDIVIDUAL_OFFERS',$2,'pg:legacy:custom')`,[organizationId,actorId]);
    await fixture.query(`INSERT INTO business_credentials(id,organization_id,credential_type,status,evidence_hash,verified_by,verified_at)
      VALUES($1,$2,'LEGACY_UNREGISTERED','ACTIVE',repeat('a',64),$3,NOW())`,[legacyCredentialId,organizationId,actorId]);
    for(const file of stageMigrations) await fixture.query(migration(file));
    oldDatabaseUrl=process.env.DATABASE_URL;process.env.DATABASE_URL=fixtureUrl.toString();
    database=(await import('../../src/db.js')).db;
    credentials=await import('../../src/services/BusinessCredentialService.js');
    workspace=await import('../../src/services/BusinessWorkspaceService.js');
  },60_000);
  afterAll(async()=>{
    if(database) await database.close();
    if(fixture) await fixture.end();
    if(created) await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await admin.end();
    if(oldDatabaseUrl===undefined) delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldDatabaseUrl;
  },30_000);

  async function draft(category='cleaning'){
    const id=randomUUID();
    await fixture.query("INSERT INTO task_drafts(id,category,region_code,structured) VALUES($1,$2,'US-WA',$3::jsonb)",[id,category,JSON.stringify({secondary_intents:['electrical']})]);
    return id;
  }
  async function finalizedReceipt(orgId=organizationId){
    const id=randomUUID();
    await fixture.query(`INSERT INTO media_upload_receipts(id,organization_id,uploader_id,purpose,quarantine_key,expected_content_type,expected_size_bytes)
      VALUES($1,$2,$3,'BUSINESS_CREDENTIAL',$4,'image/jpeg',123)`,[id,orgId,actorId,`quarantine/credential/${id}`]);
    await fixture.query(`UPDATE media_upload_receipts SET status='FINALIZED',canonical_key=$2,canonical_content_type='image/jpeg',canonical_size_bytes=123,
      canonical_checksum_sha256=repeat('a',64),pixel_width=10,pixel_height=10,source_metadata_detected=false,raw_deleted_at=NOW(),finalized_at=NOW() WHERE id=$1`,[id,`private/credential/${id}.jpg`]);
    return id;
  }
  async function saveDecision(draftId:string){
    return database.transaction(async(query)=>{
      const result=await evaluateBusinessTaskEligibility(query,{organizationId,taskDraftId:draftId,action:'SUBMIT_QUOTE'});
      expect(result.eligible).toBe(true);
      const quoteId=randomUUID(),quoteVersionId=randomUUID();
      await query("INSERT INTO quotes(id,task_draft_id,business_organization_id,status) VALUES($1,$2,$3,'submitted')",[quoteId,draftId,organizationId]);
      await query('INSERT INTO quote_versions(id,quote_id) VALUES($1,$2)',[quoteVersionId,quoteId]);
      await persistBusinessQuoteEligibilityDecision(query,result,{organizationId,taskDraftId:draftId,quoteId,quoteVersionId});
      return {result,quoteId,quoteVersionId};
    });
  }

  it('applies all three forward migrations twice and conservatively normalizes existing production rows',async()=>{
    for(const file of stageMigrations) await fixture.query(migration(file));
    expect((await fixture.query('SELECT code FROM service_categories')).rows).toHaveLength(14);
    expect((await fixture.query("SELECT service_code,selected_by_business FROM business_service_profiles ORDER BY service_code")).rows).toEqual([
      {service_code:'CUSTOM_SPECIAL',selected_by_business:false},{service_code:'cleaning',selected_by_business:true}]);
    expect((await fixture.query('SELECT id FROM business_credential_events WHERE credential_id=$1',[legacyCredentialId])).rows).toHaveLength(1);
    expect((await fixture.query("SELECT id FROM service_category_policies WHERE policy_status<>'MANUAL_REVIEW_REQUIRED'")).rows).toHaveLength(0);
  });
  it('keeps all new policy, evidence, and snapshot tables server-private after migration reapplication',async()=>{
    const tables=['service_categories','service_category_policies','credential_types','service_credential_requirements',
      'business_credential_versions','business_credential_events','business_credential_evidence','business_credential_media_access_log',
      'business_quote_eligibility_decisions','task_draft_category_corrections','business_credential_review_signals'];
    const privacy=await fixture.query('SELECT relname,relrowsecurity FROM pg_class WHERE relname=ANY($1::text[])',[tables]);
    expect(privacy.rows).toHaveLength(tables.length);
    expect(privacy.rows.every(row=>row.relrowsecurity===true)).toBe(true);
    expect((await fixture.query(`SELECT c.relname,a.privilege_type FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.relname=ANY($1::text[]) AND a.grantee=0`,[tables])).rows).toEqual([]);
  });
  it('creates, decrypts, and updates one authoritative encrypted business address',async()=>{
    const previousKey=process.env.TASK_LOCATION_ENCRYPTION_KEY;
    const previousKeyId=process.env.TASK_LOCATION_ENCRYPTION_KEY_ID;
    process.env.TASK_LOCATION_ENCRYPTION_KEY=randomBytes(32).toString('base64');
    process.env.TASK_LOCATION_ENCRYPTION_KEY_ID='isolated-pg-address-test';
    try {
      const input={actorId,organizationId,exactAddress:'123 Private Fixture Street',roughLocation:'Seattle',postalCode:'98101',regionCode:'US-WA',timezone:'America/Los_Angeles'};
      expect(await workspace.getBusinessAddress(actorId,organizationId)).toBeNull();
      const createdAddress=await workspace.saveBusinessAddress(input);
      expect(await workspace.getBusinessAddress(actorId,organizationId)).toEqual({id:createdAddress.id,exactAddress:input.exactAddress,
        roughLocation:input.roughLocation,postalCode:input.postalCode,regionCode:input.regionCode,timezone:input.timezone});
      const firstStored=(await fixture.query('SELECT * FROM business_locations WHERE id=$1',[createdAddress.id])).rows[0];
      expect(firstStored.purpose).toBe('BUSINESS_ADDRESS');
      expect(firstStored.exact_address_key_id).toBe('isolated-pg-address-test');
      expect(JSON.stringify(firstStored)).not.toContain(input.exactAddress);
      expect(firstStored.exact_address_ciphertext).toBeTruthy();
      const updatedAddress='456 Updated Fixture Avenue';
      expect(await workspace.saveBusinessAddress({...input,exactAddress:updatedAddress,postalCode:'98102'})).toEqual(createdAddress);
      expect(await workspace.getBusinessAddress(actorId,organizationId)).toMatchObject({id:createdAddress.id,exactAddress:updatedAddress,postalCode:'98102'});
      const stored=(await fixture.query("SELECT * FROM business_locations WHERE organization_id=$1 AND purpose='BUSINESS_ADDRESS' AND status='ACTIVE'",[organizationId])).rows;
      expect(stored).toHaveLength(1);
      expect(stored[0].exact_address_ciphertext).not.toBe(firstStored.exact_address_ciphertext);
      expect(JSON.stringify(stored[0])).not.toContain(updatedAddress);
      // Even an independent insert cannot create a second active address.
      await expect(fixture.query(`INSERT INTO business_locations(id,organization_id,name,rough_location,postal_code,region_code,timezone,purpose,
        exact_address_ciphertext,exact_address_nonce,exact_address_auth_tag,exact_address_key_id,exact_address_fingerprint,
        access_ciphertext,access_nonce,access_auth_tag,access_key_id,access_fingerprint,created_by,creation_idempotency_key)
        SELECT gen_random_uuid(),organization_id,name,rough_location,postal_code,region_code,timezone,purpose,
          exact_address_ciphertext,exact_address_nonce,exact_address_auth_tag,exact_address_key_id,exact_address_fingerprint,
          access_ciphertext,access_nonce,access_auth_tag,access_key_id,access_fingerprint,created_by,'pg:duplicate:address'
        FROM business_locations WHERE id=$1`,[createdAddress.id])).rejects.toMatchObject({code:'23505'});
      const audit=(await fixture.query("SELECT after_state FROM business_audit_events WHERE organization_id=$1 AND action='business_address_saved'",[organizationId])).rows;
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit)).not.toContain('Fixture');
    } finally {
      if(previousKey===undefined) delete process.env.TASK_LOCATION_ENCRYPTION_KEY;else process.env.TASK_LOCATION_ENCRYPTION_KEY=previousKey;
      if(previousKeyId===undefined) delete process.env.TASK_LOCATION_ENCRYPTION_KEY_ID;else process.env.TASK_LOCATION_ENCRYPTION_KEY_ID=previousKeyId;
    }
  });
  it('denies business-address reads and writes to an active account with no organization membership',async()=>{
    const outsider=randomUUID();
    await fixture.query("INSERT INTO users(id,full_name) VALUES($1,'Unrelated Fixture User')",[outsider]);
    await expect(workspace.getBusinessAddress(outsider,organizationId)).rejects.toThrow('HXBUS2');
    await expect(workspace.saveBusinessAddress({actorId:outsider,organizationId,exactAddress:'Denied Fixture Address',roughLocation:'Seattle',postalCode:'98101',regionCode:'US-WA',timezone:'America/Los_Angeles'})).rejects.toThrow('HXBUS2');
    expect((await fixture.query("SELECT id FROM business_locations WHERE organization_id=$1 AND purpose='BUSINESS_ADDRESS' AND status='ACTIVE'",[organizationId])).rows).toHaveLength(1);
    expect((await fixture.query("SELECT id FROM business_audit_events WHERE actor_id=$1",[outsider])).rows).toHaveLength(0);
  });
  it('uses effective policy, allows independent multiple services, and ignores secondary intents',async()=>{
    await workspace.selectBusinessServices({actorId,organizationId,serviceCodes:['cleaning','plumbing']});
    const draftId=await draft();
    const pending=await evaluateBusinessTaskEligibility(fixture.query.bind(fixture) as QueryFn,{organizationId,taskDraftId:draftId,action:'SUBMIT_QUOTE'});
    expect(pending.eligible).toBe(false);
    expect(pending.reasons.some(r=>r.code==='MANUAL_REVIEW_REQUIRED')).toBe(true);
    await fixture.query(`UPDATE service_category_policies SET effective_to='2026-01-01T00:00:00Z' WHERE service_category_id=(SELECT id FROM service_categories WHERE code='cleaning')`);
    policyId=(await fixture.query(`INSERT INTO service_category_policies(service_category_id,jurisdiction_code,policy_status,policy_version,effective_from)
      SELECT id,'US-WA','UNRESTRICTED',2,'2026-01-01T00:00:00Z' FROM service_categories WHERE code='cleaning' RETURNING id`)).rows[0].id;
    const allowed=await evaluateBusinessTaskEligibility(fixture.query.bind(fixture) as QueryFn,{organizationId,taskDraftId:draftId,action:'SUBMIT_QUOTE'});
    expect(allowed).toMatchObject({eligible:true,policy:{version:2,status:'UNRESTRICTED'}});
    expect((await fixture.query("SELECT status,weekly_capacity_slots FROM business_service_profiles WHERE organization_id=$1 AND service_code='cleaning'",[organizationId])).rows[0]).toEqual({status:'DRAFT',weekly_capacity_slots:0});
  });
  it('writes actual ALLOW snapshots atomically, then rejects mutation and post-quote category changes',async()=>{
    allowedDraftId=await draft();
    const createdQuote=await saveDecision(allowedDraftId);allowedQuoteId=createdQuote.quoteId;
    expect((await fixture.query('SELECT decision,category_policy_id,policy_version FROM business_quote_eligibility_decisions WHERE quote_id=$1',[allowedQuoteId])).rows[0])
      .toEqual({decision:'ALLOW',category_policy_id:policyId,policy_version:2});
    await expect(fixture.query("UPDATE business_quote_eligibility_decisions SET decision='ALLOW' WHERE quote_id=$1",[allowedQuoteId])).rejects.toThrow('immutable');
    await expect(fixture.query("UPDATE task_drafts SET category='other' WHERE id=$1",[allowedDraftId])).rejects.toThrow('Category cannot change');
    expect((await fixture.query('SELECT id FROM business_quote_eligibility_decisions WHERE quote_id=$1',[allowedQuoteId])).rows).toHaveLength(1);
  });
  it('rejects conflicting quote snapshot binding and duplicate quote decisions',async()=>{
    const anotherDraft=await draft();
    const result=await evaluateBusinessTaskEligibility(fixture.query.bind(fixture) as QueryFn,{organizationId,taskDraftId:anotherDraft,action:'SUBMIT_QUOTE'});
    const wrongQuote=randomUUID(),version=randomUUID();
    await fixture.query("INSERT INTO quotes(id,task_draft_id,business_organization_id,status) VALUES($1,$2,$3,'submitted')",[wrongQuote,anotherDraft,foreignOrgId]);
    await fixture.query('INSERT INTO quote_versions VALUES($1,$2)',[version,wrongQuote]);
    await expect(persistBusinessQuoteEligibilityDecision(fixture.query.bind(fixture) as QueryFn,result,{organizationId,taskDraftId:anotherDraft,quoteId:wrongQuote,quoteVersionId:version})).rejects.toThrow('binding mismatch');
    const original=(await fixture.query('SELECT quote_version_id FROM business_quote_eligibility_decisions WHERE quote_id=$1',[allowedQuoteId])).rows[0];
    await expect(persistBusinessQuoteEligibilityDecision(fixture.query.bind(fixture) as QueryFn,result,{organizationId,taskDraftId:allowedDraftId,quoteId:allowedQuoteId,quoteVersionId:original.quote_version_id})).rejects.toMatchObject({code:'23505'});
  });
  it('submits real organization credentials, consumes exact private receipts, and records immutable review history',async()=>{
    credentialTypeId=(await fixture.query(`INSERT INTO credential_types(code,display_name,credential_kind,jurisdiction_code)
      VALUES('TEST_WA_LICENSE','Fixture license (not a legal policy)','LICENSE','US-WA') RETURNING id`)).rows[0].id;
    const receiptId=await finalizedReceipt();
    submitted=await credentials.submitOrganizationCredential({actorId,organizationId,membershipId:null,credentialTypeId,jurisdictionCode:'US-WA',credentialNumber:'fixture-license',expiresAt:'2099-12-31',uploadReceiptIds:[receiptId],idempotencyKey:'pg:credential:01'});
    expect(submitted.status).toBe('PENDING');
    expect((await fixture.query('SELECT membership_id,status,current_version_id FROM business_credentials WHERE id=$1',[submitted.id])).rows[0]).toEqual({membership_id:null,status:'PENDING',current_version_id:submitted.versionId});
    expect((await fixture.query('SELECT status,purpose,canonical_url FROM media_upload_receipts WHERE id=$1',[receiptId])).rows[0]).toEqual({status:'CONSUMED',purpose:'BUSINESS_CREDENTIAL',canonical_url:null});
    await credentials.reviewBusinessCredential({actorId,organizationId,credentialId:submitted.id,versionId:submitted.versionId,decision:'APPROVE',reason:'Verified fixture only.'});
    expect((await fixture.query('SELECT status FROM business_credential_events WHERE credential_id=$1 ORDER BY created_at,id',[submitted.id])).rows.map(r=>r.status)).toEqual(['PENDING','ACTIVE']);
    await expect(fixture.query("UPDATE business_credential_versions SET snapshot='{}' WHERE id=$1",[submitted.versionId])).rejects.toThrow('append-only');
  });
  it('rejects cross-organization evidence and rolls back rather than creating a credential version',async()=>{
    const receiptId=await finalizedReceipt(foreignOrgId);
    await expect(credentials.submitOrganizationCredential({actorId,organizationId,credentialTypeId,jurisdictionCode:'US-WA',credentialNumber:'bad-org',uploadReceiptIds:[receiptId],idempotencyKey:'pg:cross-org:01'})).rejects.toMatchObject({code:'BAD_REQUEST'});
    expect((await fixture.query('SELECT id FROM business_credential_versions WHERE submission_idempotency_key=$1',['pg:cross-org:01'])).rows).toHaveLength(0);
    expect((await fixture.query('SELECT status FROM media_upload_receipts WHERE id=$1',[receiptId])).rows[0].status).toBe('FINALIZED');
    await expect(fixture.query('UPDATE media_upload_receipts SET organization_id=$2 WHERE id=$1',[receiptId,organizationId])).rejects.toThrow('immutable organization');
    await expect(fixture.query(`INSERT INTO business_credential_evidence(credential_id,version_id,organization_id,upload_receipt_id) VALUES($1,$2,$3,$4)`,[legacyCredentialId,submitted.versionId,organizationId,receiptId])).rejects.toMatchObject({code:'23503'});
  });
  it('snapshots a verified credential; later expiry blocks new quotes but leaves the prior snapshot intact',async()=>{
    await fixture.query(`UPDATE service_category_policies SET effective_to='2026-01-01T00:00:00Z' WHERE service_category_id=(SELECT id FROM service_categories WHERE code='plumbing')`);
    const requiredPolicy=(await fixture.query(`INSERT INTO service_category_policies(service_category_id,jurisdiction_code,policy_status,policy_version,effective_from)
      SELECT id,'US-WA','CREDENTIAL_REQUIRED',2,'2026-01-01T00:00:00Z' FROM service_categories WHERE code='plumbing' RETURNING id`)).rows[0].id;
    await fixture.query('INSERT INTO service_credential_requirements(service_category_policy_id,credential_type_id) VALUES($1,$2)',[requiredPolicy,credentialTypeId]);
    const prior=await saveDecision(await draft('plumbing'));
    const frozen=(await fixture.query('SELECT credential_snapshot FROM business_quote_eligibility_decisions WHERE quote_id=$1',[prior.quoteId])).rows[0].credential_snapshot;
    expect(frozen[0]).toMatchObject({credentialId:submitted.id,credentialVersionId:submitted.versionId,status:'ACTIVE'});
    await fixture.query("UPDATE business_credentials SET expires_at='2020-01-01T00:00:00Z' WHERE id=$1",[submitted.id]);
    const nowExpired=await evaluateBusinessTaskEligibility(fixture.query.bind(fixture) as QueryFn,{organizationId,taskDraftId:await draft('plumbing'),action:'SUBMIT_QUOTE'});
    expect(nowExpired.reasons.some(r=>r.code==='CREDENTIAL_EXPIRED')).toBe(true);
    expect((await fixture.query('SELECT credential_snapshot FROM business_quote_eligibility_decisions WHERE quote_id=$1',[prior.quoteId])).rows[0].credential_snapshot).toEqual(frozen);
  });
  it('revocation creates an actionable review signal without canceling booked work or mutating snapshots',async()=>{
    const quote=(await fixture.query("SELECT quote_id,task_draft_id FROM business_quote_eligibility_decisions WHERE primary_category='plumbing'")).rows[0];
    const taskId=randomUUID();await fixture.query("INSERT INTO tasks(id,state) VALUES($1,'ACCEPTED')",[taskId]);
    await fixture.query('UPDATE task_drafts SET task_id=$2,quote_id=$3 WHERE id=$1',[quote.task_draft_id,taskId,quote.quote_id]);
    await credentials.reviewBusinessCredential({actorId,organizationId,credentialId:submitted.id,versionId:submitted.versionId,decision:'REVOKE',reason:'Authority revoked the fixture license.'});
    expect((await fixture.query('SELECT task_id,reason FROM business_credential_review_signals WHERE credential_id=$1',[submitted.id])).rows[0]).toEqual({task_id:taskId,reason:'CREDENTIAL_REVOKED'});
    expect((await fixture.query('SELECT state FROM tasks WHERE id=$1',[taskId])).rows[0].state).toBe('ACCEPTED');
    expect((await fixture.query('SELECT credential_snapshot FROM business_quote_eligibility_decisions WHERE quote_id=$1',[quote.quote_id])).rows[0].credential_snapshot[0].status).toBe('ACTIVE');
    expect((await credentials.readBusinessCredentials(actorId,organizationId,true)).reviewSignals).toHaveLength(1);
  });
});
