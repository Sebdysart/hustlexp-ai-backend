import { beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({notice:vi.fn()}));
vi.mock('../../src/db.js',()=>({db:{query:vi.fn()}}));
vi.mock('../../src/services/NotificationRequestService.js',()=>({enqueueNotificationRequest:m.notice}));
vi.mock('../../src/services/LocalCertificationPayoutProvider.js',()=>({LocalCertificationPayoutProvider:{verifyPaidTransfer:vi.fn(async()=>true),verifyPaidBusinessTransfer:vi.fn(async()=>true)}}));
import { executeReleaseTransaction } from '../../src/services/EscrowReleaseTransaction.js';
const org='10000000-0000-4000-8000-000000000001';
const task='10000000-0000-4000-8000-000000000002';
const user='10000000-0000-4000-8000-000000000003';
const escrow='10000000-0000-4000-8000-000000000004';
beforeEach(()=>vi.clearAllMocks());
describe('canonical release notification boundary',()=>{
  it.each([true,false])('records the existing payout notice with the release (business=%s)',async business=>{
    const query=vi.fn(async(sql:string)=>{
      if(sql.includes('FROM escrows')) return {rows:[{id:escrow,task_id:task,amount:10000,platform_fee_cents:1500,state:'FUNDED',version:1}],rowCount:1};
      if(sql.includes('FROM tasks')) return {rows:[{worker_id:business?null:user,payout_recipient_user_id:user,business_fulfiller_organization_id:business?org:null,orchestration_mode:business?'OPS_MANUAL':'MARKETPLACE',automation_classification:'CONTROLLED_TEST',price:10000,payment_method:'escrow'}],rowCount:1};
      if(sql.includes('FROM hxos_local_test_business_payout_destinations')) return {rows:[{payout_recipient_user_id:user}],rowCount:1};
      if(sql.includes('UPDATE escrows')) return {rows:[{id:escrow,state:'RELEASED'}],rowCount:1};
      throw new Error('Unexpected query: '+sql);
    });
    const result=await executeReleaseTransaction(query as never,{escrowId:escrow,localTestTransferId:'test-transfer'});
    expect(result.success).toBe(true);
    expect(m.notice).toHaveBeenCalledWith(query,expect.objectContaining({userId:user,category:'payment_released',deepLink:business?`/business/tasks/${task}`:'/earnings',dedupeKey:`payout-released:${escrow}:${user}`}));
  });
});
