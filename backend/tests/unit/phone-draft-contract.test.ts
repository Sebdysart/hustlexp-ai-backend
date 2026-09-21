import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const migration = read('backend/database/migrations/20261002_phone_draft_claims.sql');
const schema = read('backend/database/constitutional-schema.sql');
const claim = read('backend/src/services/CustomerDraftClaimService.ts');
const ops = read('backend/src/routers/web/ops.ts');
const postTask = read('backend/src/routers/web/postTask.ts');
const worker = read('backend/src/jobs/sms-worker.ts');
const providerOs = read('backend/src/services/ProviderOsService.ts');
const quotePayment = read('backend/src/services/QuotePaymentFinalizationService.ts');

describe('Ops phone draft ownership contract', () => {
  it('adds nullable email/accountless SMS and a hashed expiring one-time claim', () => {
    expect(migration).toMatch(/users alter column email drop not null/i);
    expect(migration).toMatch(/sms_outbox alter column user_id drop not null/i);
    expect(migration).toMatch(/token_hash text not null unique/i);
    expect(migration).toMatch(/status in \('OPEN', 'CLAIMED', 'EXPIRED', 'REVOKED'\)/i);
    expect(migration).toMatch(/created_by_ops_user_id uuid not null/i);
    expect(migration).toMatch(/users_verified_identity_chk/i);
    expect(migration).toMatch(/leads_contact_or_owner_chk/i);
  });

  it('uses one canonical creation service for customer and Ops posting', () => {
    expect(postTask).toContain('createCanonicalTaskDraft');
    expect(ops).toMatch(/createCustomerTaskDraft:\s*operationsAdminProcedure/);
    expect(ops).toContain('createCanonicalTaskDraftInTransaction');
    expect(ops).toContain('posterUserId: null');
  });

  it('logs every customer-draft creation boundary with one correlation context', () => {
    for (const stage of [
      'ops_create_customer_draft_start',
      'normalize_customer_phone',
      'canonical_draft_create_start',
      'canonical_draft_create_success',
      'pending_claim_create_start',
      'pending_claim_create_success',
      'sms_enqueue_start',
      'sms_enqueue_success',
      'response_build',
      'ops_create_customer_draft_success',
    ]) {
      expect(`${ops}\n${claim}`).toContain(stage);
    }
    expect(ops).toContain('correlationId');
    expect(ops).toContain('serializeCustomerDraftError');
    expect(ops).toMatch(/catch\s*\(error\)[\s\S]*throw error/);
  });

  it('locks the claim and both ownership records before consuming it', () => {
    expect(claim).toMatch(/pending_phone_draft_claims[\s\S]*for update/i);
    expect(claim).toMatch(/task_drafts where id=\$1 for update/i);
    expect(claim).toMatch(/leads where id=\$1 for update/i);
    expect(claim).toContain('UPDATE task_drafts SET poster_user_id');
    expect(claim).toContain('UPDATE leads SET user_id');
  });

  it('keeps raw tokens out of persisted SMS and rebuilds the link in the trusted worker', () => {
    expect(claim).toContain("const body = 'pending_phone_claim'");
    expect(worker).toContain('pendingPhoneClaimSmsBody');
    expect(worker).toContain("recipient_kind === 'pending_phone_claim'");
  });

  it('routes pending-claim SMS through the canonical allowed notification queue', () => {
    expect(schema).toMatch(/queue_name[\s\S]*'user_notifications'/i);
    expect(claim).toMatch(
      /VALUES \('sms\.send_requested','pending_phone_draft_claim',[\s\S]*'user_notifications','pending',NOW\(\)\)/,
    );
    expect(claim).not.toMatch(
      /VALUES \('sms\.send_requested','pending_phone_draft_claim',[\s\S]*'sms','pending',NOW\(\)\)/,
    );
  });

  it('does not expand Provider OS to ownerless drafts', () => {
    expect(providerOs).toContain('if (!draft.poster_user_id)');
    expect(providerOs).toContain("return failure('INVALID_STATE', 'This request is no longer eligible to quote through Provider OS.')");
  });

  it('keeps payment and task materialization unavailable before poster binding', () => {
    expect(quotePayment).toMatch(/d\.poster_user_id = \$3/i);
  });
});
