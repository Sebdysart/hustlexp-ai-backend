import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const testUrl = process.env.PROVIDER_OS_TEST_DATABASE_URL;

describe.skipIf(!testUrl)('businessProposal.requestAssessment (isolated PostgreSQL)', () => {
  const databaseName = `assessment_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: testUrl });
  let fixture: Client;
  let database: typeof import('../../src/db.js').db;
  let caller: ReturnType<typeof import('../../src/routers/businessProposal.js').businessProposalRouter.createCaller>;
  let oldDatabaseUrl: string | undefined;
  let firstProposalId: string;

  const actor = randomUUID();
  const organization = randomUUID();
  const activeAdmin = randomUUID();
  const removedAdmin = randomUUID();
  const suspendedAdmin = randomUUID();

  async function createProposal() {
    const draftId = randomUUID();
    const proposalId = randomUUID();
    await fixture.query(`INSERT INTO task_drafts(id,status) VALUES($1,'open')`, [draftId]);
    await fixture.query(
      `INSERT INTO business_task_proposals(id,task_draft_id,business_organization_id,status,expires_at)
       VALUES($1,$2,$3,'PENDING',NOW()+INTERVAL '1 day')`,
      [proposalId, draftId, organization],
    );
    return { draftId, proposalId };
  }

  async function request(proposalId: string) {
    return caller.requestAssessment({
      proposalId,
      businessMessage: 'An onsite assessment is needed to scope the work.',
      proposedWindowStart: new Date(Date.now() + 86_400_000).toISOString(),
      proposedWindowEnd: new Date(Date.now() + 90_000_000).toISOString(),
    });
  }

  beforeAll(async () => {
    const parsed = new URL(testUrl!);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.port !== '55439') {
      throw new Error('Isolated local PostgreSQL on port 55439 required');
    }
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const fixtureUrl = new URL(testUrl!);
    fixtureUrl.pathname = `/${databaseName}`;
    fixture = new Client({ connectionString: fixtureUrl.toString() });
    await fixture.connect();
    await fixture.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE users(id UUID PRIMARY KEY, account_status TEXT NOT NULL DEFAULT 'ACTIVE',
        is_banned BOOLEAN NOT NULL DEFAULT FALSE, trust_hold BOOLEAN NOT NULL DEFAULT FALSE);
      CREATE TABLE business_organizations(id UUID PRIMARY KEY, status TEXT NOT NULL,
        provider_enabled BOOLEAN NOT NULL, verification_status TEXT NOT NULL, display_name TEXT);
      CREATE TABLE business_memberships(organization_id UUID, user_id UUID, status TEXT, role TEXT);
      CREATE TABLE task_drafts(id UUID PRIMARY KEY, status TEXT NOT NULL, task_id UUID);
      CREATE TABLE business_task_proposals(id UUID PRIMARY KEY, task_draft_id UUID NOT NULL,
        business_organization_id UUID NOT NULL, status TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
        responded_at TIMESTAMPTZ, updated_at TIMESTAMPTZ);
      CREATE TABLE business_assessment_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_draft_id UUID NOT NULL, business_organization_id UUID NOT NULL,
        claim_link_id UUID NOT NULL, requested_by_user_id UUID NOT NULL,
        business_message TEXT NOT NULL, proposed_window_start TIMESTAMPTZ NOT NULL,
        proposed_window_end TIMESTAMPTZ NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING_ADMIN');
      CREATE UNIQUE INDEX assessment_one_active ON business_assessment_requests(task_draft_id,business_organization_id)
        WHERE status IN ('PENDING_ADMIN','AWAITING_CUSTOMER','SCHEDULED');
      CREATE TABLE admin_roles(user_id UUID, role TEXT, can_manage_operations BOOLEAN NOT NULL DEFAULT FALSE);
      CREATE TABLE notifications(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL,
        type TEXT, title VARCHAR, message TEXT, entity_type TEXT, entity_id UUID,
        action_url TEXT, metadata JSONB, category VARCHAR, body TEXT, deep_link TEXT,
        priority VARCHAR, notification_class TEXT, object_type TEXT, object_id TEXT,
        dedupe_key TEXT UNIQUE, supersession_key TEXT);
      CREATE TABLE business_audit_events(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID, actor_id UUID, action TEXT, object_type TEXT, object_id UUID, after_state JSONB);
      CREATE FUNCTION business_require_action(org UUID, actor UUID, action TEXT) RETURNS void
        LANGUAGE plpgsql AS $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM business_memberships
            WHERE organization_id=org AND user_id=actor AND status='ACTIVE' AND role='OWNER') THEN
            RAISE EXCEPTION 'Business action denied';
          END IF;
        END $$;`);
    await fixture.query(`INSERT INTO users(id) VALUES($1),($2),($3),($4)`,
      [actor, activeAdmin, removedAdmin, suspendedAdmin]);
    await fixture.query(`INSERT INTO business_organizations(id,status,provider_enabled,verification_status,display_name)
      VALUES($1,'ACTIVE',TRUE,'VERIFIED','Test Business')`, [organization]);
    await fixture.query(`INSERT INTO business_memberships VALUES($1,$2,'ACTIVE','OWNER')`, [organization,actor]);
    await fixture.query(`INSERT INTO admin_roles VALUES($1,'admin',FALSE),($2,'admin',FALSE),($3,'admin',FALSE)`,
      [activeAdmin,removedAdmin,suspendedAdmin]);
    await fixture.query(`DELETE FROM admin_roles WHERE user_id=$1`, [removedAdmin]);
    await fixture.query(`UPDATE users SET account_status='SUSPENDED' WHERE id=$1`, [suspendedAdmin]);
    oldDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = fixtureUrl.toString();
    database = (await import('../../src/db.js')).db;
    const { businessProposalRouter } = await import('../../src/routers/businessProposal.js');
    caller = businessProposalRouter.createCaller({
      user: { id: actor, account_status: 'ACTIVE', is_banned: false } as never,
      firebaseUid: actor,
      ip: null,
    });
  }, 60_000);

  afterAll(async () => {
    if (database) await database.close();
    if (fixture) await fixture.end();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
  }, 30_000);

  it('reproduces the NOT NULL rollback, then applies only the forward migration', async () => {
    const { proposalId } = await createProposal();
    firstProposalId = proposalId;
    await expect(request(proposalId)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED', message: 'Unable to submit the assessment request.',
    });
    expect((await fixture.query('SELECT id FROM business_assessment_requests')).rows).toHaveLength(0);
    expect((await fixture.query('SELECT id FROM notifications')).rows).toHaveLength(0);
    await fixture.query(readFileSync(
      'backend/database/migrations/20260923_business_proposal_assessment_source.sql', 'utf8',
    ));
    const result = await request(proposalId);
    expect(result.status).toBe('PENDING_ADMIN');
    expect((await fixture.query('SELECT claim_link_id FROM business_assessment_requests')).rows)
      .toEqual([{ claim_link_id: null }]);
    expect((await fixture.query('SELECT user_id FROM notifications')).rows)
      .toEqual([{ user_id: activeAdmin }]);
    expect((await fixture.query('SELECT action FROM business_audit_events')).rows)
      .toEqual([{ action: 'ASSESSMENT_REQUESTED' }]);
  });

  it('commits the assessment when no eligible Ops recipient remains', async () => {
    await fixture.query('DELETE FROM admin_roles WHERE user_id=$1', [activeAdmin]);
    const { proposalId } = await createProposal();
    const result = await request(proposalId);
    expect(result.status).toBe('PENDING_ADMIN');
    expect((await fixture.query('SELECT id FROM business_assessment_requests')).rows).toHaveLength(2);
    expect((await fixture.query('SELECT id FROM notifications')).rows).toHaveLength(1);
  });

  it('does not notify a suspended or removed Ops user on later requests', async () => {
    const { proposalId } = await createProposal();
    await request(proposalId);
    expect((await fixture.query('SELECT id FROM business_assessment_requests')).rows).toHaveLength(3);
    expect((await fixture.query('SELECT user_id FROM notifications')).rows)
      .toEqual([{ user_id: activeAdmin }]);
  });

  it('keeps duplicate assessment requests blocked without duplicate notification or audit', async () => {
    await expect(request(firstProposalId)).rejects.toMatchObject({code: 'PRECONDITION_FAILED'});
    expect((await fixture.query('SELECT id FROM business_assessment_requests')).rows).toHaveLength(3);
    expect((await fixture.query('SELECT id FROM business_audit_events')).rows).toHaveLength(3);
    expect((await fixture.query('SELECT id FROM notifications')).rows).toHaveLength(1);
  });
});
