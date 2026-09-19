import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
vi.mock('../../src/db.js', () => ({db:{query:vi.fn()}}));
vi.mock('../../src/jobs/queues.js', () => ({generateIdempotencyKey:vi.fn()}));
vi.mock('../../src/services/NotificationService.js', () => ({NotificationService:{createNotification:vi.fn()}}));
import type { QueryFn } from '../../src/db.js';
import { enqueueNotificationRequest } from '../../src/services/NotificationRequestService.js';
const url = process.env.PROVIDER_OS_TEST_DATABASE_URL;
describe.skipIf(!url)('notification intent transaction and replay (isolated PostgreSQL)',()=>{
  const client = new Client({connectionString:url});
  const schema=`notification_request_${randomUUID().replaceAll('-','')}`;
  const recipient=randomUUID(),task=randomUUID(),application=randomUUID();
  const notification={userId:recipient,taskId:task,category:'new_matching_task' as const,title:'New applicant',body:'Review applicants.',deepLink:`/tasks/${task}/applicants`,dedupeKey:`application-received:${application}:${recipient}`};
  const query: QueryFn=(sql,params)=>client.query(sql,params);
  beforeAll(async()=>{
    const parsed=new URL(url!);
    if(!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.port!=='55439') throw new Error('Isolated local test database required');
    await client.connect();
    await query(`CREATE SCHEMA ${schema}`);
    await query(`SET search_path TO ${schema}`);
    await query(`CREATE TABLE domain_fixture(id UUID PRIMARY KEY);
      CREATE TABLE outbox_events(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),event_type TEXT,aggregate_type TEXT,
      aggregate_id UUID,event_version INTEGER,idempotency_key VARCHAR(255) UNIQUE NOT NULL,payload JSONB,queue_name TEXT,status TEXT,enqueued_at TIMESTAMPTZ);`);
    await query(readFileSync('backend/database/migrations/20260922_notification_request_dispatch.sql','utf8'));
  });
  afterAll(async()=>{await query(`DROP SCHEMA ${schema} CASCADE`);await client.end();});
  async function mutate(fail=false){
    const connection=new Client({connectionString:url});await connection.connect();
    const tx: QueryFn=(sql,params)=>connection.query(sql,params);
    try {
      await tx(`SET search_path TO ${schema}`);await tx('BEGIN');
      await tx('INSERT INTO domain_fixture VALUES($1) ON CONFLICT DO NOTHING',[application]);
      await enqueueNotificationRequest(tx,notification);
      if(fail) throw new Error('domain transaction rolled back');
      await tx('COMMIT');
    } catch(error){await tx('ROLLBACK');throw error;}finally{await connection.end();}
  }
  it('cannot publish a rolled-back domain mutation; concurrent committed replays produce one durable request',async()=>{
    await expect(mutate(true)).rejects.toThrow('rolled back');
    expect((await query('SELECT * FROM domain_fixture')).rows).toHaveLength(0);
    expect((await query('SELECT * FROM outbox_events')).rows).toHaveLength(0);
    await Promise.all([mutate(),mutate()]);
    const rows=(await query('SELECT * FROM outbox_events')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({event_type:'notification.create_requested',queue_name:'user_notifications',status:'pending',payload:notification});
    await enqueueNotificationRequest(query,{...notification,dedupeKey:`application-received:${randomUUID()}:${recipient}`});
    expect((await query('SELECT * FROM outbox_events')).rows).toHaveLength(2);
    expect((await query("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='outbox_notification_request_dispatch_lease'",[schema])).rows[0].indexdef).toContain('notification.create_requested');
  });
});
