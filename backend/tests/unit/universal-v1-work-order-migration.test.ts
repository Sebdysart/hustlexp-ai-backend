import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
const sql=readFileSync(new URL('../../database/migrations/20260908_universal_v1_provider_work_order_authority.sql',import.meta.url),'utf8');
describe('20260908 post-estimate authority migration',()=>{
 it('repairs replay, active-hold, expiry, fake-finance, Poster, and no-assignment invariants',()=>{
 for(const proof of ['task_applications_universal_interest_replay','task_reservations_one_active_task',"NEW.status='EXPIRED'",'universal_fake_finance_boundary_guard',"automation_classification='CONTROLLED_TEST'",'t.poster_id=NEW.materialized_by','t.worker_id IS NULL','task_work_order_command_requests','request.request_sha256=current_setting',"financial.provider_kind='FAKE'",'e.processor_payment_eligible=false','e.payout_funding_eligible=false','forbid_work_order_request_mutation','task_work_order_command_requests_no_truncate','prevent_append_only_truncate','idempotency_key IS NULL AND request_sha256 IS NULL','HXUV1-INTEREST-3'])expect(sql).toContain(proof);
  expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS task_provider_eligibility_exact_chain[\s\S]*?\(task_draft_id,provider_user_id,provider_organization_id,decision_version\)\s+NULLS NOT DISTINCT;/u);
 });
 it('does not introduce Stripe, escrow, assignment, or approved-provider effects',()=>{expect(sql).not.toMatch(/stripe|escrow|SET worker_id|APPROVED_PROVIDER/i);});
});
