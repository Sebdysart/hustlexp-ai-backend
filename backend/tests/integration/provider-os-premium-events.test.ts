import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { Job } from 'bullmq';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), send: vi.fn(), inApp: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query, transaction: mocks.transaction } }));
vi.mock('../../src/services/TwilioSMSService.js', () => ({ sendSMS: mocks.send }));
vi.mock('../../src/services/NotificationService.js', () => ({ NotificationService: { createInTransaction: mocks.inApp } }));
vi.mock('../../src/jobs/outbox-worker.js', () => ({ markOutboxEventProcessed: vi.fn(), markOutboxEventFailed: vi.fn() }));
vi.mock('../../src/services/NotificationDeliveryState.js', () => ({
  authorizeNotificationDelivery: vi.fn(), markNotificationCancelled: vi.fn(),
  markNotificationDeliveryFailure: vi.fn(), markNotificationProviderAccepted: vi.fn(),
}));
vi.mock('../../src/logger.js', () => ({ workerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
import { processProviderOsPremiumEvent, premiumEventEligible, premiumRecipients } from '../../src/services/ProviderOsPremiumEvents.js';
import { processSMSJob } from '../../src/jobs/sms-worker.js';

// Explicit local-only disposable fixture. Never points at the application database.
const databaseUrl = process.env.PROVIDER_OS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('Provider OS durable events (isolated PostgreSQL fixture)', () => {
  const client = new Client({ connectionString: databaseUrl });
  const schema = `provider_os_test_${randomUUID().replaceAll('-', '')}`;
  const org = randomUUID(), otherOrg = randomUUID(), poster = randomUUID(), member = randomUUID(), second = randomUUID();
  let relationship: string;
  const query = (sql: string, values?: unknown[]) => client.query(sql, values);
  const rows = async (table: string) => (await query(`SELECT * FROM ${table}`)).rows;
  const event = async (type: string) => (await query('SELECT * FROM provider_os_domain_events WHERE event_type = $1 AND organization_id = $2', [type, org])).rows[0];
  const deliver = (id: string) => processSMSJob({ id: 'queue-job', data: { payload: { smsId: id, toPhone: '+19999999999', body: 'untrusted queue body' } } } as Job);
  async function draft() {
    const id = randomUUID();
    await query('INSERT INTO task_drafts(id,poster_user_id,status) VALUES($1,$2,\'draft\')', [id, poster]);
    return id;
  }
  async function selectQuote(origin: string | null = 'provider_os') {
    const draftId = await draft(), quoteId = randomUUID();
    await query(`INSERT INTO quotes(id,task_draft_id,business_organization_id,acquisition_origin,status) VALUES($1,$2,$3,$4,'quote_ready')`, [quoteId, draftId, org, origin]);
    await query('BEGIN');
    await query("UPDATE quotes SET status = 'quote_send_ready' WHERE id = $1", [quoteId]);
    await query('UPDATE task_drafts SET quote_id = $2 WHERE id = $1', [draftId, quoteId]);
    await query('COMMIT');
    return { draftId, quoteId };
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '55439') throw new Error('Use the isolated local test cluster on port 55439');
    await client.connect();
    await query(`CREATE SCHEMA ${schema}`);
    await query(`SET search_path TO ${schema}`);
    // Minimal canonical schema contracts, not a claim of full production migration rehearsal.
    await query(`
      CREATE TABLE users(id UUID PRIMARY KEY, phone TEXT, account_status TEXT DEFAULT 'ACTIVE', is_banned BOOLEAN DEFAULT false, trust_hold BOOLEAN DEFAULT false);
      CREATE TABLE business_organizations(id UUID PRIMARY KEY, status TEXT DEFAULT 'ACTIVE', provider_enabled BOOLEAN DEFAULT true);
      CREATE TABLE business_memberships(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID, user_id UUID, status TEXT DEFAULT 'ACTIVE', role TEXT DEFAULT 'OWNER', UNIQUE(organization_id,user_id));
      CREATE FUNCTION business_membership_has_action(UUID,UUID,TEXT) RETURNS BOOLEAN LANGUAGE sql AS 'SELECT EXISTS(SELECT 1 FROM business_memberships WHERE organization_id=$1 AND user_id=$2 AND status=''ACTIVE'' AND role IN (''OWNER'',''ADMIN'',''DISPATCHER''))';
      CREATE TABLE provider_os_entitlements(organization_id UUID PRIMARY KEY, status TEXT DEFAULT 'active', starts_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ);
      CREATE TABLE provider_os_relationships(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), provider_organization_id UUID, poster_user_id UUID, status TEXT DEFAULT 'active', accepted_by_user_id UUID, accepted_at TIMESTAMPTZ, UNIQUE(provider_organization_id,poster_user_id));
      CREATE TABLE task_drafts(id UUID PRIMARY KEY, poster_user_id UUID, task_id UUID, quote_id UUID, claimed_at TIMESTAMPTZ, status TEXT);
      CREATE TABLE tasks(id UUID PRIMARY KEY, business_fulfiller_organization_id UUID, state TEXT);
      CREATE TABLE quotes(id UUID PRIMARY KEY, task_draft_id UUID, business_organization_id UUID, acquisition_origin TEXT, status TEXT);
      CREATE TABLE quote_payments(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), quote_id UUID, task_id UUID, status TEXT);
      CREATE TABLE notification_preferences(user_id UUID PRIMARY KEY, sms_enabled BOOLEAN, quiet_hours_enabled BOOLEAN DEFAULT false, quiet_hours_start TEXT, quiet_hours_end TEXT, quiet_hours_timezone TEXT);
      CREATE TABLE sms_outbox(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, to_phone TEXT NOT NULL, body TEXT NOT NULL, idempotency_key TEXT UNIQUE, status TEXT DEFAULT 'pending', twilio_sid TEXT, error_message TEXT, retry_count INT DEFAULT 0, max_retries INT DEFAULT 3, available_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), sent_at TIMESTAMPTZ);
      CREATE TABLE outbox_events(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_type TEXT, aggregate_type TEXT, aggregate_id UUID, event_version INT, idempotency_key TEXT UNIQUE, payload JSONB, queue_name TEXT, status TEXT DEFAULT 'pending', attempts INT DEFAULT 0, error_message TEXT, enqueued_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), available_at TIMESTAMPTZ DEFAULT NOW(), processed_at TIMESTAMPTZ);
    `);
    await query(readFileSync('backend/database/migrations/20260920_provider_os_premium_events.sql', 'utf8'));
    mocks.query.mockImplementation(query);
    mocks.transaction.mockImplementation(async (fn) => {
      await query('BEGIN');
      try { const result = await fn(query); await query('COMMIT'); return result; }
      catch (error) { await query('ROLLBACK'); throw error; }
    });
  });
  afterAll(async () => {
    await query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });
  beforeEach(async () => {
    await query('TRUNCATE users,business_organizations,business_memberships,provider_os_entitlements,provider_os_relationships,task_drafts,tasks,quotes,quote_payments,notification_preferences,sms_outbox,outbox_events,provider_os_domain_events,provider_os_event_recipients CASCADE');
    await query('INSERT INTO users(id,phone) VALUES($1,NULL),($2,\'+15551234567\'),($3,\'+15557654321\')', [poster, member, second]);
    await query('INSERT INTO business_organizations(id) VALUES($1),($2)', [org, otherOrg]);
    await query('INSERT INTO provider_os_entitlements(organization_id) VALUES($1),($2)', [org, otherOrg]);
    await query('INSERT INTO business_memberships(organization_id,user_id) VALUES($1,$2),($1,$3)', [org, member, second]);
    await query('INSERT INTO notification_preferences(user_id,sms_enabled) VALUES($1,true),($2,true)', [member, second]);
    relationship = (await query('INSERT INTO provider_os_relationships(provider_organization_id,poster_user_id,accepted_by_user_id,accepted_at) VALUES($1,$2,$2,NOW()) RETURNING id', [org, poster])).rows[0].id;
    mocks.send.mockReset().mockResolvedValue({ success: true, sid: 'SM_test' });
    mocks.inApp.mockReset().mockResolvedValue(undefined);
  });

  it('captures first consent atomically, never on replay or rolled-back acceptance', async () => {
    expect(await rows('provider_os_domain_events')).toHaveLength(1);
    await query('INSERT INTO provider_os_relationships(provider_organization_id,poster_user_id,accepted_by_user_id,accepted_at) VALUES($1,$2,$2,NOW()) ON CONFLICT DO NOTHING', [org, poster]);
    await query('BEGIN');
    await query('INSERT INTO provider_os_relationships(provider_organization_id,poster_user_id,accepted_by_user_id,accepted_at) VALUES($1,$2,$2,NOW())', [otherOrg, poster]);
    await query('ROLLBACK');
    expect(await rows('provider_os_domain_events')).toHaveLength(1);
    expect(await rows('outbox_events')).toHaveLength(1);
    await query("UPDATE provider_os_relationships SET status='revoked' WHERE id=$1", [relationship]);
    expect(await rows('provider_os_domain_events')).toHaveLength(1);
  });
  it('emits a task only after insertion, one per related entitled org, and no replay', async () => {
    await query('INSERT INTO provider_os_relationships(provider_organization_id,poster_user_id,accepted_by_user_id,accepted_at) VALUES($1,$2,$2,NOW())', [otherOrg, poster]);
    const id = await draft();
    await query("INSERT INTO task_drafts(id,poster_user_id,status) VALUES($1,$2,'draft') ON CONFLICT DO NOTHING", [id, poster]);
    expect((await rows('provider_os_domain_events')).filter(e => e.event_type === 'CLIENT_TASK_POSTED')).toHaveLength(2);
    await query('BEGIN'); await draft(); await query('ROLLBACK');
    expect((await rows('provider_os_domain_events')).filter(e => e.event_type === 'CLIENT_TASK_POSTED')).toHaveLength(2);
    await query("INSERT INTO task_drafts(id,status) VALUES(gen_random_uuid(),'anonymous_task_draft')");
    expect((await rows('provider_os_domain_events')).filter(e => e.event_type === 'CLIENT_TASK_POSTED')).toHaveLength(2);
  });
  it('captures actual quote selection, not initiation, and materialization only after successful payment', async () => {
    const { draftId, quoteId } = await selectQuote();
    expect(await event('QUOTE_ACCEPTED')).toMatchObject({ quote_id: quoteId, draft_id: draftId });
    await query('UPDATE task_drafts SET quote_id=$2 WHERE id=$1', [draftId, quoteId]);
    expect((await rows('provider_os_domain_events')).filter(e => e.event_type === 'QUOTE_ACCEPTED')).toHaveLength(1);
    const taskId = randomUUID();
    await query("INSERT INTO tasks VALUES($1,$2,'ACCEPTED')", [taskId, org]);
    await query('UPDATE task_drafts SET task_id=$2 WHERE id=$1', [draftId, taskId]);
    await query("INSERT INTO quote_payments(quote_id,task_id,status) VALUES($1,$2,'PENDING')", [quoteId, taskId]);
    expect(await event('TASK_READY')).toBeUndefined();
    await query('BEGIN');
    await query("UPDATE quote_payments SET status='SUCCEEDED'");
    await query("UPDATE quotes SET status='paid' WHERE id=$1", [quoteId]);
    await query('ROLLBACK');
    expect(await event('TASK_READY')).toBeUndefined();
    await query("UPDATE quote_payments SET status='SUCCEEDED'");
    // A crash here must not lose the event: replay can return before quotes.status is updated.
    expect(await event('TASK_READY')).toMatchObject({ quote_id: quoteId, task_id: taskId });
    await processProviderOsPremiumEvent((await event('TASK_READY')).id);
    expect(await rows('sms_outbox')).toHaveLength(2);
    await query("UPDATE quotes SET status='paid' WHERE id=$1", [quoteId]);
    await query("UPDATE quote_payments SET status='SUCCEEDED'");
    await query("UPDATE quotes SET status='paid' WHERE id=$1", [quoteId]);
    expect(await event('TASK_READY')).toMatchObject({ quote_id: quoteId, task_id: taskId });
    expect((await rows('provider_os_domain_events')).filter(e => e.event_type === 'TASK_READY')).toHaveLength(1);
  });
  it('never emits quote events for claim/proposal origins', async () => {
    await selectQuote('claim_link'); await selectQuote('direct_proposal'); await selectQuote(null);
    expect(await event('QUOTE_ACCEPTED')).toBeUndefined();
  });
  it('isolates organizations and skips revoked/expired entitlements or relationships', async () => {
    const joined = await event('CLIENT_JOINED');
    expect(await premiumEventEligible({ ...joined, organization_id: otherOrg }, query)).toBe(false);
    expect(await premiumRecipients({ ...joined, organization_id: otherOrg }, query)).toHaveLength(0);
    await query("UPDATE provider_os_entitlements SET status='revoked' WHERE organization_id=$1", [org]);
    await processProviderOsPremiumEvent(joined.id);
    expect(await rows('sms_outbox')).toHaveLength(0);
    expect(await event('CLIENT_JOINED')).toMatchObject({ status: 'skipped', outcome: 'organization_relationship_or_context_ineligible' });
  });
  it.each(['member_removed', 'sms_disabled', 'missing_phone', 'banned', 'viewer'])('excludes %s at processing', async (reason) => {
    await query('DELETE FROM business_memberships WHERE user_id=$1', [second]);
    if (reason === 'member_removed') await query("UPDATE business_memberships SET status='REMOVED' WHERE user_id=$1", [member]);
    if (reason === 'sms_disabled') await query('UPDATE notification_preferences SET sms_enabled=false');
    if (reason === 'missing_phone') await query('UPDATE users SET phone=NULL WHERE id=$1', [member]);
    if (reason === 'banned') await query('UPDATE users SET is_banned=true WHERE id=$1', [member]);
    if (reason === 'viewer') await query("UPDATE business_memberships SET role='VIEWER' WHERE user_id=$1", [member]);
    await processProviderOsPremiumEvent((await event('CLIENT_JOINED')).id);
    expect(await rows('sms_outbox')).toHaveLength(0);
  });
  it('fan-out is transactional, retryable and deduped for every recipient', async () => {
    const joined = await event('CLIENT_JOINED');
    mocks.inApp.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('temporary failure'));
    await expect(processProviderOsPremiumEvent(joined.id)).rejects.toThrow('temporary failure');
    expect(await rows('sms_outbox')).toHaveLength(0);
    expect(await rows('provider_os_relationships')).toHaveLength(1);
    await processProviderOsPremiumEvent(joined.id); await processProviderOsPremiumEvent(joined.id);
    expect(await rows('sms_outbox')).toHaveLength(2);
    expect(await rows('provider_os_event_recipients')).toHaveLength(2);
    await query("UPDATE provider_os_domain_events SET status='pending' WHERE id=$1", [joined.id]);
    await processProviderOsPremiumEvent(joined.id);
    expect(await rows('sms_outbox')).toHaveLength(2);
  });
  it.each(['entitlement', 'expired', 'relationship', 'membership', 'preference', 'phone', 'account'])('rechecks %s at delivery', async (reason) => {
    await processProviderOsPremiumEvent((await event('CLIENT_JOINED')).id);
    const sms = (await rows('sms_outbox')).find(s => s.user_id === member);
    if (reason === 'entitlement') await query("UPDATE provider_os_entitlements SET status='suspended'");
    if (reason === 'expired') await query("UPDATE provider_os_entitlements SET expires_at=NOW()-INTERVAL '1 second'");
    if (reason === 'relationship') await query("UPDATE provider_os_relationships SET status='revoked'");
    if (reason === 'membership') await query('DELETE FROM business_memberships WHERE user_id=$1', [member]);
    if (reason === 'preference') await query('UPDATE notification_preferences SET sms_enabled=false');
    if (reason === 'phone') await query('UPDATE users SET phone=NULL WHERE id=$1', [member]);
    if (reason === 'account') await query("UPDATE users SET account_status='DEACTIVATED' WHERE id=$1", [member]);
    await deliver(sms.id);
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await rows('sms_outbox')).find(s => s.id === sms.id).status).toBe('suppressed');
  });
  it('uses current phone and trusted template, then never resends a saved SID', async () => {
    await processProviderOsPremiumEvent((await event('CLIENT_JOINED')).id);
    const sms = (await rows('sms_outbox'))[0];
    await query("UPDATE users SET phone='+15550001111' WHERE id=$1", [sms.user_id]);
    await deliver(sms.id); await deliver(sms.id);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith('+15550001111', expect.stringContaining(`/provider-os?organizationId=${org}`));
    await query("UPDATE sms_outbox SET status='sending' WHERE id=$1", [sms.id]);
    await deliver(sms.id);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('suppresses historical premium work and unproven v2 payloads', async () => {
    for (const key of ['provider_os:legacy', 'provider_os:v2:sms:forged']) {
      const sms = (await query('INSERT INTO sms_outbox(user_id,to_phone,body,idempotency_key) VALUES($1,$2,$3,$4) RETURNING id', [member, '+15551234567', 'legacy', key])).rows[0];
      await deliver(sms.id);
    }
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await rows('sms_outbox')).every(s => s.status === 'suppressed')).toBe(true);
  });
  it('never resends a crashed, stale send without a saved SID', async () => {
    await processProviderOsPremiumEvent((await event('CLIENT_JOINED')).id);
    const sms = (await rows('sms_outbox'))[0];
    await query("UPDATE sms_outbox SET status='sending', updated_at=NOW()-INTERVAL '11 minutes' WHERE id=$1", [sms.id]);
    await deliver(sms.id); await deliver(sms.id);
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await rows('sms_outbox')).find(s => s.id === sms.id).error_message).toBe('delivery_uncertain_requires_review');
  });
  it('Twilio failure cannot undo successful payment or canonical task materialization', async () => {
    const { draftId, quoteId } = await selectQuote();
    const taskId = randomUUID();
    await query("INSERT INTO tasks VALUES($1,$2,'ACCEPTED')", [taskId, org]);
    await query('UPDATE task_drafts SET task_id=$2 WHERE id=$1', [draftId, taskId]);
    await query("INSERT INTO quote_payments(quote_id,task_id,status) VALUES($1,$2,'SUCCEEDED')", [quoteId, taskId]);
    await query("UPDATE quotes SET status='paid' WHERE id=$1", [quoteId]);
    await processProviderOsPremiumEvent((await event('TASK_READY')).id);
    mocks.send.mockResolvedValue({ success: false, error: 'transport failure' });
    await deliver((await rows('sms_outbox'))[0].id);
    expect((await rows('quote_payments'))[0].status).toBe('SUCCEEDED');
    expect((await rows('tasks'))[0].state).toBe('ACCEPTED');
    expect((await rows('task_drafts'))[0].task_id).toBe(taskId);
    expect((await rows('quotes'))[0].status).toBe('paid');
  });
  it('defers during quiet hours without calling Twilio', async () => {
    await processProviderOsPremiumEvent((await event('CLIENT_JOINED')).id);
    const sms = (await rows('sms_outbox'))[0];
    const hour = new Date().getUTCHours();
    await query(`UPDATE notification_preferences SET quiet_hours_enabled=true, quiet_hours_start=$1, quiet_hours_end=$2, quiet_hours_timezone='UTC'`,
      [`${hour.toString().padStart(2, '0')}:00:00`, `${((hour + 2) % 24).toString().padStart(2, '0')}:00:00`]);
    await deliver(sms.id);
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await rows('sms_outbox')).find(s => s.id === sms.id).retry_count).toBe(0);
    expect((await rows('outbox_events')).find(e => e.idempotency_key === sms.idempotency_key).error_message).toBe('quiet_hours_deferred');
  });
  it('retries definite rejection; ambiguous failure never changes canonical state or resends', async () => {
    const { quoteId, draftId } = await selectQuote();
    const selected = await event('QUOTE_ACCEPTED');
    await processProviderOsPremiumEvent(selected.id);
    const sms = (await rows('sms_outbox'))[0];
    mocks.send.mockResolvedValueOnce({ success: false, definitelyNotSent: true, error: 'rate_limited' });
    await deliver(sms.id);
    expect((await rows('sms_outbox')).find(s => s.id === sms.id).status).toBe('failed');
    mocks.send.mockResolvedValueOnce({ success: false, error: 'network_timeout' });
    await deliver(sms.id); await deliver(sms.id);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect((await rows('sms_outbox')).find(s => s.id === sms.id).error_message).toBe('delivery_uncertain_requires_review');
    expect((await query('SELECT quote_id FROM task_drafts WHERE id=$1', [draftId])).rows[0].quote_id).toBe(quoteId);
    expect((await query('SELECT status FROM quotes WHERE id=$1', [quoteId])).rows[0].status).toBe('quote_send_ready');
  });
});
