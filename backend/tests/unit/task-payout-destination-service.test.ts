import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe,expect,it,vi } from 'vitest';
import type { QueryFn } from '../../src/db.js';
import { loadCurrentTaskPayoutDestination } from '../../src/services/TaskPayoutDestinationService.js';

const binding = {
  taskId:'10000000-0000-4000-8000-000000000001',
  workerId:'20000000-0000-4000-8000-000000000001',
  payoutRecipientUserId:'30000000-0000-4000-8000-000000000001',
};

describe('current task payout destination', () => {
  it('returns a provider destination only when the canonical binding is current', async () => {
    const query=vi.fn().mockResolvedValue({ rows:[{
      stripe_connect_id:'acct_current',payouts_enabled:true,
      account_status:'ACTIVE',binding_current:true,
    }] }) as unknown as QueryFn;
    const result=await loadCurrentTaskPayoutDestination(query,binding);
    expect(result).toEqual({ ready:true,stripeConnectId:'acct_current',reason:'READY' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('business_service_task_assignments assignment'),[
      binding.taskId,binding.workerId,binding.payoutRecipientUserId,
    ]);
    const sql=String(vi.mocked(query).mock.calls[0]?.[0]);
    expect(sql).toContain("payout.status='ACTIVE'");
    expect(sql).toContain("encode(digest(payee.stripe_connect_id,'sha256'),'hex')");
  });

  it('fails closed when the task, fulfiller, payee, assignment, or fingerprint no longer matches', async () => {
    const query=vi.fn().mockResolvedValue({ rows:[{
      stripe_connect_id:'acct_changed',payouts_enabled:true,
      account_status:'ACTIVE',binding_current:false,
    }] }) as unknown as QueryFn;
    await expect(loadCurrentTaskPayoutDestination(query,binding)).resolves.toEqual({
      ready:false,stripeConnectId:null,reason:'TASK_BINDING_MISMATCH',
    });
  });

  it('fails closed when the bound provider account cannot receive payouts', async () => {
    const query=vi.fn().mockResolvedValue({ rows:[{
      stripe_connect_id:'acct_restricted',payouts_enabled:false,
      account_status:'ACTIVE',binding_current:true,
    }] }) as unknown as QueryFn;
    await expect(loadCurrentTaskPayoutDestination(query,binding)).resolves.toEqual({
      ready:false,stripeConnectId:null,reason:'PAYOUT_ACCOUNT_NOT_READY',
    });
  });

  it('is required by every full and partial transfer path before provider movement', () => {
    for (const file of [
      'backend/src/jobs/completion-release-orchestrator.ts',
      'backend/src/jobs/EscrowActionRelease.ts',
      'backend/src/jobs/EscrowActionPartialRefund.ts',
      'backend/src/services/EscrowReleaseTransaction.ts',
      'backend/src/services/EscrowPartialRefundTransaction.ts',
    ]) {
      const source=readFileSync(resolve(process.cwd(),file),'utf8');
      expect(source,`${file} must enforce canonical payout binding`)
        .toContain('loadCurrentTaskPayoutDestination');
    }
  });
});
