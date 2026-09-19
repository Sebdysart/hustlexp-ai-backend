import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
const m=vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn(),notice:vi.fn(),verify:vi.fn()}));
vi.mock('../../src/db.js',()=>({db:{query:m.query,transaction:m.transaction}}));
vi.mock('../../src/services/NotificationService.js',()=>({NotificationService:{createInTransaction:m.notice,createForBusinessInTransaction:m.notice}}));
vi.mock('../../src/services/payment/StaxQuotePaymentProvider.js',()=>({StaxQuotePaymentProvider:{verifySucceededPayment:m.verify}}));
vi.mock('../../src/services/EscrowService.js',()=>({EscrowService:{}}));
vi.mock('../../src/services/TaskCreateService.js',()=>({TaskCreateService:{}}));
vi.mock('../../src/services/BusinessQuoteActivationService.js',()=>({isBusinessQuoteProviderVerified:vi.fn()}));
vi.mock('../../src/services/QuoteServiceAddressService.js',()=>({consumeQuoteServiceAddress:vi.fn(),readQuoteServiceLocation:vi.fn()}));
vi.mock('../../src/services/ControlledTestQuotePaymentService.js',()=>({controlledTestQuotePaymentEnabled:vi.fn(),settleControlledTestQuotePayment:vi.fn()}));
vi.mock('../../src/services/AnalyticsService.js',()=>({AnalyticsService:{track:vi.fn()}}));
import { finalizePaidQuote } from '../../src/services/QuotePaymentFinalizationService.js';
import { EarnedVerificationUnlockService } from '../../src/services/EarnedVerificationUnlockService.js';
const url=process.env.PROVIDER_OS_TEST_DATABASE_URL;
describe.skipIf(!url)('ordinary notification commit boundaries (isolated PostgreSQL)',()=>{
  const client=new Client({connectionString:url});
  const schema=`lifecycle_notice_${randomUUID().replaceAll('-','')}`;
  const actor=randomUUID(),organization=randomUUID(),quote=randomUUID(),version=randomUUID(),task=randomUUID(),escrow=randomUUID();
  const q=(sql:string,values?:unknown[])=>client.query(sql,values);
  async function transaction(fn:(query:typeof q)=>Promise<unknown>){
    await q('BEGIN');try{const result=await fn(q);await q('COMMIT');return result;}catch(e){await q('ROLLBACK');throw e;}
  }
  const storeNotice=(query:typeof q, recipientOrInput:any, businessInput?:any)=>{
    const input=businessInput??recipientOrInput;
    return query('INSERT INTO notice_fixture VALUES($1) ON CONFLICT DO NOTHING',[`${input.userId??recipientOrInput}:${input.dedupeKey}`]);
  };
  beforeAll(async()=>{
    const parsed=new URL(url!);
    if(!['localhost','127.0.0.1'].includes(parsed.hostname)||parsed.port!=='55439') throw new Error('Isolated test database required');
    await client.connect();await q(`CREATE SCHEMA ${schema}`);await q(`SET search_path TO ${schema}`);
    await q(`CREATE TABLE notice_fixture(key TEXT PRIMARY KEY);
      CREATE TABLE quote_payments(quote_id UUID,quote_version_id UUID,provider_payment_id TEXT,task_id UUID,status TEXT,updated_at TIMESTAMPTZ);
      CREATE TABLE quotes(id UUID PRIMARY KEY,status TEXT,updated_at TIMESTAMPTZ);
      CREATE TABLE quote_versions(id UUID PRIMARY KEY,quote_id UUID,status TEXT,updated_at TIMESTAMPTZ);
      CREATE TABLE verification_earnings_tracking(user_id UUID PRIMARY KEY,total_net_earnings_cents INT DEFAULT 0,earned_unlock_threshold_cents INT DEFAULT 4000,unlock_notified_at TIMESTAMPTZ);
      CREATE TABLE verification_earnings_ledger(id UUID DEFAULT gen_random_uuid(),user_id UUID,task_id UUID,escrow_id UUID UNIQUE,net_payout_cents INT,cumulative_earnings_before_cents INT,cumulative_earnings_after_cents INT);`);
    m.verify.mockResolvedValue({success:true});
  });
  afterAll(async()=>{await q(`DROP SCHEMA ${schema} CASCADE`);await client.end();});
  it('retries ordinary paid notices with the existing materialized task, without losing or duplicating notices',async()=>{
    await q("INSERT INTO quote_payments VALUES($1,$2,'payment',$3,'PENDING',NOW())",[quote,version,task]);
    await q("INSERT INTO quotes VALUES($1,'quote_send_ready',NOW())",[quote]);
    await q("INSERT INTO quote_versions VALUES($1,$2,'draft',NOW())",[version,quote]);
    // Only materialization/provider lookup are stubbed. The final paid-state/notice SQL runs on PostgreSQL.
    m.query.mockImplementation(async(sql:string,values?:unknown[])=>{
      if(sql.includes('q.id AS quote_id')) return {rows:[{quote_status:'quote_send_ready',selected_quote_id:quote,provider_payment_id:'payment',payment_amount_cents:1000,payment_platform_fee_cents:100,payment_provider:'stax',total_cents:1000,hustler_payout_cents:900,poster_user_id:actor,business_organization_id:organization}]};
      if(sql.includes('FROM escrows')) return {rows:[{state:'FUNDED'}]};
      if(sql.includes('UPDATE tasks')) return {rows:[{id:task}],rowCount:1};
      return q(sql,values);
    });
    const run=()=>{
      let count=0;
      m.transaction.mockImplementation(async fn=>++count===1?{taskId:task,escrowId:escrow,replayed:true}:transaction(fn));
      return finalizePaidQuote({quoteId:quote,quoteVersionId:version,posterId:actor,paymentIntentId:'payment',paymentMode:'stax'});
    };
    m.notice.mockImplementationOnce(storeNotice).mockRejectedValueOnce(new Error('notice storage unavailable'));
    expect((await run()).success).toBe(false);
    expect((await q('SELECT status FROM quote_payments')).rows[0].status).toBe('PENDING');
    expect((await q('SELECT status FROM quotes')).rows[0].status).toBe('quote_send_ready');
    expect((await q('SELECT * FROM notice_fixture')).rows).toHaveLength(0);
    m.notice.mockImplementation(storeNotice);
    expect((await run()).success).toBe(true);
    expect((await run()).success).toBe(true);
    expect((await q('SELECT * FROM notice_fixture')).rows).toHaveLength(2);
    expect((await q('SELECT status FROM quote_payments')).rows[0].status).toBe('SUCCEEDED');
  });
  it('rolls back the unlock-notified claim on insert failure and publishes once after retry',async()=>{
    m.query.mockImplementation(q);m.transaction.mockImplementation(transaction);
    await q('INSERT INTO verification_earnings_tracking(user_id,total_net_earnings_cents) VALUES($1,3900)',[actor]);
    m.notice.mockRejectedValueOnce(new Error('notice storage unavailable'));
    expect((await EarnedVerificationUnlockService.recordEarnings(actor,task,escrow,200)).success).toBe(false);
    expect((await q('SELECT unlock_notified_at FROM verification_earnings_tracking')).rows[0].unlock_notified_at).toBeNull();
    expect((await q('SELECT * FROM verification_earnings_ledger')).rows).toHaveLength(0);
    m.notice.mockImplementation(storeNotice);
    expect((await EarnedVerificationUnlockService.recordEarnings(actor,task,escrow,200)).success).toBe(true);
    expect((await EarnedVerificationUnlockService.recordEarnings(actor,task,escrow,200)).success).toBe(true);
    expect((await q("SELECT * FROM notice_fixture WHERE key LIKE '%earned-verification-unlocked:%'")).rows).toHaveLength(1);
  });
});
