import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), write: vi.fn(), create: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/lib/outbox-helpers.js', () => ({ writeToOutbox: mocks.write }));
vi.mock('../../src/services/NotificationService.js', () => ({ NotificationService: { createNotification: mocks.create } }));
import { enqueueNotificationRequest, processNotificationRequest } from '../../src/services/NotificationRequestService.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
const user = '10000000-0000-4000-8000-000000000001';
const task = '10000000-0000-4000-8000-000000000002';
const params = {userId:user, taskId:task, category:'proof_submitted' as const, title:'Proof submitted', body:'Review proof.', deepLink:`/tasks/${task}/proof`, dedupeKey:`proof-submitted:proof:${user}`};
const key = `notification-request:${params.dedupeKey}`;
const job = {name:'notification.create_requested',data:{outbox_idempotency_key:key,payload:{...params,userId:'forged',body:'forged'}}};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockImplementation(async (sql:string) => {
    if (sql.includes('FROM outbox_events')) return {rows:[{id:task,payload:params,status:'enqueued'}]};
    if (sql.includes('FROM users')) return {rows:[{id:user}]};
    return {rows:[],rowCount:1};
  });
  mocks.create.mockResolvedValue({success:true,data:{id:task}});
});
describe('durable notification request boundary', () => {
  it('registers the forward dispatch index after the existing premium outbox index', () => {
    const names=REQUIRED_MIGRATION_FILES.map(row=>row.name);
    expect(names.filter(name=>name==='20260922_notification_request_dispatch')).toHaveLength(1);
    expect(names.indexOf('20260922_notification_request_dispatch')).toBeGreaterThan(names.indexOf('20260920_provider_os_premium_events'));
  });
  it('persists only inside the supplied domain transaction, using recipient/event identity', async () => {
    const query=vi.fn();
    await enqueueNotificationRequest(query,params);
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({
      eventType:'notification.create_requested',aggregateType:'notification_request',aggregateId:user,
      queueName:'user_notifications',idempotencyKey:key,payload:params,
    }),query);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('ignores queue copy and recipient values and processes the stored request', async () => {
    await processNotificationRequest(job);
    expect(mocks.create).toHaveBeenCalledWith(params);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("status = 'processed'"),[task,null]);
  });
  it('keeps storage failures retryable; replay keeps the same notification key', async () => {
    mocks.create.mockResolvedValueOnce({success:false,error:{code:'DB_ERROR',message:'offline'}});
    await expect(processNotificationRequest(job)).rejects.toThrow('DB_ERROR');
    expect(mocks.query.mock.calls.some(([sql])=>sql.includes("status = 'processed'"))).toBe(false);
    await processNotificationRequest(job);
    expect(mocks.create.mock.calls.map(([input])=>input.dedupeKey)).toEqual([params.dedupeKey,params.dedupeKey]);
  });
  it.each(['PREFERENCE_DISABLED','FORBIDDEN','NOT_FOUND'])('records a terminal skipped outcome for %s', async code => {
    mocks.create.mockResolvedValue({success:false,error:{code,message:'internal details'}});
    await processNotificationRequest(job);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("status = 'processed'"),[task,code]);
  });
  it('does not notify an ineligible or deleted account', async () => {
    mocks.query.mockImplementation(async (sql:string)=>({rows:sql.includes('FROM outbox_events')?[{id:task,payload:params,status:'enqueued'}]:[]}));
    await processNotificationRequest(job);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("status = 'processed'"),[task,'recipient_ineligible']);
  });
  it.each([
    {category:'proof_submitted',metadata:{proofId:task}},
    {category:'proof_rejected',metadata:{proofId:task}},
    {category:'new_matching_task',metadata:{applicationId:task}},
  ])('skips delayed $category whose canonical source is no longer actionable', async source => {
    mocks.query.mockImplementation(async (sql:string)=>({rows:sql.includes('FROM outbox_events')
      ?[{id:task,payload:{...params,...source},status:'enqueued'}]
      :sql.includes('FROM users')?[{id:user}]:[]}));
    await processNotificationRequest(job);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("status = 'processed'"),[task,'source_no_longer_actionable']);
  });
  it('reauthorizes the exact release recipient and keeps canonical work independent of premium access', async () => {
    const paid={...params,category:'payment_released',taskId:undefined,metadata:{escrowId:task,taskId:task,organizationId:task}};
    mocks.query.mockImplementation(async (sql:string)=>({rows:sql.includes('FROM outbox_events')
      ?[{id:task,payload:paid,status:'enqueued'}]:sql.includes('FROM users')?[{id:user}]:[]}));
    await processNotificationRequest(job);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("status = 'processed'"),[task,'release_recipient_no_longer_authorized']);
    const releaseQuery=mocks.query.mock.calls.find(([sql])=>sql.includes('FROM escrows'))!;
    expect(releaseQuery[1]).toEqual([task,task,user,task]);
    expect(releaseQuery[0]).toContain('business_membership_has_action');
    expect(releaseQuery[0]).not.toContain('provider_os_entitlements');
    mocks.query.mockImplementation(async (sql:string)=>({rows:sql.includes('FROM outbox_events')
      ?[{id:task,payload:paid,status:'enqueued'}]:[{id:user}]}));
    await processNotificationRequest(job);
    expect(mocks.create).toHaveBeenCalledWith(paid);
  });
  it('does not replay processed or missing persisted work', async () => {
    mocks.query.mockResolvedValueOnce({rows:[{id:task,payload:params,status:'processed'}]});
    await processNotificationRequest(job);
    mocks.query.mockResolvedValueOnce({rows:[]});
    await expect(processNotificationRequest(job)).rejects.toThrow('missing');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects mismatched persisted identity and missing queue provenance', async () => {
    mocks.query.mockResolvedValueOnce({rows:[{id:task,payload:{...params,dedupeKey:'another'},status:'enqueued'}]});
    await expect(processNotificationRequest(job)).rejects.toThrow('identity');
    await expect(processNotificationRequest({name:job.name,data:{}})).rejects.toThrow('provenance');
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
