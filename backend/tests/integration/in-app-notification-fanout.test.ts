import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query }, isInvariantViolation: () => false, getErrorMessage: () => '' }));
vi.mock('../../src/config.js', () => ({ config: { redis: {} } }));
vi.mock('../../src/logger.js', () => ({ logger: { child: () => ({}) } }));
import { NotificationService } from '../../src/services/NotificationService.js';
import type { QueryFn } from '../../src/db.js';
import { businessNotificationDestinations } from '../../src/services/BusinessNotificationDestination.js';

const url = process.env.PROVIDER_OS_TEST_DATABASE_URL;
describe.skipIf(!url)('in-app recipient dedupe against the shipped PostgreSQL uniqueness contract', () => {
  const client = new Client({ connectionString: url });
  const schema = `in_app_test_${randomUUID().replaceAll('-', '')}`;
  const query: QueryFn = (sql, values) => client.query(sql, values);
  const users = [randomUUID(), randomUUID()];
  const event = { type: 'QUOTE_ACCEPTED', title: 'Quote accepted', message: 'Customer accepted.', dedupeKey: 'quote-accepted:event' };
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.port !== '55439') throw new Error('Isolated local test database required');
    await client.connect();
    await query(`CREATE SCHEMA ${schema}`);
    await query(`SET search_path TO ${schema}`);
    await query(`CREATE TABLE notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
      type TEXT, title VARCHAR, message TEXT, entity_type TEXT, entity_id UUID,
      action_url TEXT, metadata JSONB, category VARCHAR, body TEXT, deep_link TEXT,
      priority VARCHAR, notification_class TEXT, object_type TEXT, object_id TEXT,
      dedupe_key TEXT UNIQUE, supersession_key TEXT, read_at TIMESTAMPTZ, clicked_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE UNIQUE INDEX notifications_user_dedupe ON notifications(user_id,dedupe_key);`);
    await query(`CREATE TABLE task_drafts(id UUID PRIMARY KEY, task_id UUID, quote_id UUID);
      CREATE TABLE users(id UUID PRIMARY KEY,account_status TEXT DEFAULT 'ACTIVE',is_banned BOOLEAN DEFAULT FALSE,trust_hold BOOLEAN DEFAULT FALSE);
      CREATE TABLE admin_roles(user_id UUID,role TEXT,can_manage_operations BOOLEAN DEFAULT FALSE);
      CREATE TABLE quotes(id UUID PRIMARY KEY, task_draft_id UUID, business_organization_id UUID, acquisition_origin TEXT);
      CREATE TABLE tasks(id UUID PRIMARY KEY,business_fulfiller_organization_id UUID);
      CREATE TABLE business_assessment_requests(id UUID PRIMARY KEY,task_draft_id UUID,business_organization_id UUID,proposal_id UUID,claim_link_id UUID);
      CREATE TABLE business_task_proposals(id UUID PRIMARY KEY,task_draft_id UUID,business_organization_id UUID,quote_id UUID,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE ops_business_claim_links(id UUID PRIMARY KEY,task_draft_id UUID,claimed_by_organization_id UUID,status TEXT,quote_id UUID);
      CREATE TABLE business_memberships(organization_id UUID,user_id UUID,status TEXT DEFAULT 'ACTIVE',role TEXT DEFAULT 'OWNER');
      CREATE FUNCTION business_membership_has_action(UUID,UUID,TEXT) RETURNS BOOLEAN LANGUAGE sql AS 'SELECT EXISTS(SELECT 1 FROM business_memberships WHERE organization_id=$1 AND user_id=$2 AND status=''ACTIVE'')';`);
    await query('INSERT INTO users(id) VALUES($1),($2)',users);
    mocks.query.mockImplementation(query);
  });
  beforeEach(async () => { await query('TRUNCATE notifications'); });
  afterAll(async () => { await query(`DROP SCHEMA ${schema} CASCADE`); await client.end(); });
  it('delivers once per recipient even on concurrent replay', async () => {
    const inputs = users.map(userId => ({ ...event, userId }));
    const fanOut = async () => {
      const connection = new Client({connectionString:url}); await connection.connect();
      const tx: QueryFn = (sql, values) => connection.query(sql, values);
      try {
        await tx(`SET search_path TO ${schema}`); await tx('BEGIN');
        await NotificationService.createManyInTransaction(tx, inputs); await tx('COMMIT');
      } catch (error) { await tx('ROLLBACK'); throw error; } finally { await connection.end(); }
    };
    await Promise.all([fanOut(), fanOut()]);
    const rows = await query('SELECT user_id FROM notifications');
    expect(rows.rows.map(r => r.user_id).sort()).toEqual([...users].sort());
  });
  it('does not duplicate a historical raw-key notice while completing missing recipients', async () => {
    await query('INSERT INTO notifications(user_id,dedupe_key) VALUES($1,$2)', [users[0], event.dedupeKey]);
    await NotificationService.createManyInTransaction(query, users.map(userId => ({ ...event, userId })));
    expect((await query('SELECT user_id FROM notifications')).rows.map(r => r.user_id).sort()).toEqual([...users].sort());
  });
  it('scopes read/unread ownership and breaks equal-timestamp ordering ties deterministically', async () => {
    const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'];
    await query("INSERT INTO notifications(id,user_id,created_at) VALUES($1,$3,'2026-09-01'),($2,$3,'2026-09-01')", [...ids,users[0]]);
    expect((await NotificationService.getUserNotifications(users[0], 1, 0, true))).toMatchObject({success:true,data:[{id:ids[1]}]});
    expect((await NotificationService.markAsRead(ids[1], users[1])).success).toBe(false);
    expect(await NotificationService.getUnreadCount(users[0])).toMatchObject({success:true,data:2});
    await NotificationService.markAsRead(ids[1], users[0]);
    expect(await NotificationService.getUnreadCount(users[0])).toMatchObject({success:true,data:1});
    await NotificationService.markAllAsRead(users[1]);
    expect(await NotificationService.getUnreadCount(users[0])).toMatchObject({success:true,data:1});
  });
  it('resolves proposal, claim, Provider OS and canonical task links without cross-org inference', async () => {
    const org = randomUUID(), other = randomUUID(), draft = randomUUID(), quote = randomUUID(), proposal = randomUUID(), task = randomUUID();
    await query('INSERT INTO task_drafts VALUES($1,NULL,$2)', [draft,quote]);
    await query("INSERT INTO quotes VALUES($1,$2,$3,'direct_proposal')", [quote,draft,org]);
    await query('INSERT INTO business_memberships(organization_id,user_id) VALUES($1,$2),($1,$3)', [org,...users]);
    await query('INSERT INTO business_task_proposals(id,task_draft_id,business_organization_id,quote_id) VALUES($1,$2,$3,$4)', [proposal,draft,org,quote]);
    const refs = [{ id: 'notice', entityType: 'quote' as const, entityId: quote }];
    const link = async () => (await businessNotificationDestinations(query, refs, { actorId: users[0] })).get('notice');
    expect(await link()).toBe(`/business/proposals/${proposal}`);
    expect((await businessNotificationDestinations(query, refs, { organizationId: other })).get('notice')).toBeNull();
    await NotificationService.createForBusinessInTransaction(query, org, { ...event, entityType: 'quote', entityId: quote, actionUrl: `/business/claims/${draft}` });
    expect((await query('SELECT action_url FROM notifications')).rows).toEqual([{action_url:`/business/proposals/${proposal}`},{action_url:`/business/proposals/${proposal}`}]);
    await query('DELETE FROM business_task_proposals');
    await query('UPDATE quotes SET acquisition_origin=NULL');
    expect(await link()).toBeNull(); // Historical provenance must not be guessed.
    await query("INSERT INTO ops_business_claim_links VALUES($1,$2,$3,'CLAIMED',$4)", [randomUUID(),draft,org,quote]);
    expect(await link()).toBe(`/business/claims/${draft}?organizationId=${org}`);
    await query("UPDATE quotes SET acquisition_origin='provider_os'");
    expect(await link()).toBe(`/provider-os/quotes/${quote}?organizationId=${org}`);
    await query('INSERT INTO tasks VALUES($1,$2)',[task,org]);
    await query('UPDATE task_drafts SET task_id=$1',[task]);
    expect(await link()).toBe(`/business/tasks/${task}`); // No premium entitlement needed for canonical successor.
    await query("UPDATE business_memberships SET status='REMOVED'");
    expect(await link()).toBeNull();
    expect((await businessNotificationDestinations(query, [{...refs[0],entityId:randomUUID()}], {actorId:users[0]})).get('notice')).toBeNull();
  });
  it('routes assessment notices by their persisted acquisition source, even when a draft has both paths', async () => {
    const org=randomUUID(), draft=randomUUID(), proposal=randomUUID(), claim=randomUUID();
    const proposalAssessment=randomUUID(), claimAssessment=randomUUID();
    await query('INSERT INTO task_drafts VALUES($1,NULL,NULL)',[draft]);
    await query('INSERT INTO business_memberships(organization_id,user_id) VALUES($1,$2)',[org,users[0]]);
    await query('INSERT INTO business_task_proposals(id,task_draft_id,business_organization_id) VALUES($1,$2,$3)',[proposal,draft,org]);
    await query("INSERT INTO ops_business_claim_links VALUES($1,$2,$3,'CLAIMED',NULL)",[claim,draft,org]);
    await query('INSERT INTO business_assessment_requests VALUES($1,$2,$3,$4,NULL),($5,$2,$3,NULL,$6)',
      [proposalAssessment,draft,org,proposal,claimAssessment,claim]);
    const destinations=await businessNotificationDestinations(query,[
      {id:'proposal',entityType:'assessment',entityId:proposalAssessment},
      {id:'claim',entityType:'assessment',entityId:claimAssessment},
    ],{actorId:users[0]});
    expect(destinations.get('proposal')).toBe(`/business/proposals/${proposal}`);
    expect(destinations.get('claim')).toBe(`/business/claims/${draft}?organizationId=${org}`);
  });
  it('excludes suspended business and operations accounts from new fan-out', async () => {
    const org=randomUUID();
    await query('INSERT INTO business_memberships(organization_id,user_id) VALUES($1,$2),($1,$3)',[org,...users]);
    await query("INSERT INTO admin_roles(user_id,role) VALUES($1,'admin'),($2,'founder')",users);
    await query("UPDATE users SET account_status='SUSPENDED' WHERE id=$1",[users[1]]);
    await NotificationService.createForBusinessInTransaction(query,org,event);
    await NotificationService.createForOperationsInTransaction(query,{...event,dedupeKey:'ops-event'});
    expect((await query('SELECT user_id FROM notifications')).rows).toEqual([{user_id:users[0]},{user_id:users[0]}]);
    await query('TRUNCATE notifications');
    await query('UPDATE users SET trust_hold=TRUE WHERE id=$1',[users[0]]);
    await NotificationService.createForBusinessInTransaction(query,org,{...event,dedupeKey:'another-event'});
    await NotificationService.createForOperationsInTransaction(query,{...event,dedupeKey:'another-ops-event'});
    expect((await query('SELECT * FROM notifications')).rows).toHaveLength(0);
  });
});
