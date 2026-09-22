import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const migration = read('backend/database/migrations/20260922_phone_draft_claims.sql');
const smsCleanupMigration = read('backend/database/migrations/20260922_remove_pending_phone_claim_sms.sql');
const migrationFiles = read('backend/src/jobs/engine-automation-migration-files.ts');
const claim = read('backend/src/services/CustomerDraftClaimService.ts');
const ops = read('backend/src/routers/web/ops.ts');
const postTask = read('backend/src/routers/web/postTask.ts');
const worker = read('backend/src/jobs/sms-worker.ts');
const notificationService = read('backend/src/services/NotificationService.ts');
const providerOsEvents = read('backend/src/services/ProviderOsPremiumEvents.ts');
const providerOs = read('backend/src/services/ProviderOsService.ts');
const quotePayment = read('backend/src/services/QuotePaymentFinalizationService.ts');

describe('Ops phone draft ownership contract', () => {
  it('adds nullable email and a hashed expiring one-time claim', () => {
    expect(migration).toMatch(/users alter column email drop not null/i);
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
    expect(ops).toContain('claimUrl: created.claimUrl');
    expect(ops).not.toContain('claimToken: created.claimToken');
  });

  it('logs every customer-draft creation boundary with one correlation context', () => {
    for (const stage of [
      'ops_create_customer_draft_start',
      'normalize_customer_phone',
      'canonical_draft_create_start',
      'canonical_draft_create_success',
      'pending_claim_create_start',
      'pending_claim_create_success',
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

  it('returns a reconstructable customer claim URL without persisting its raw token', () => {
    expect(claim).toContain('pendingPhoneClaimUrl');
    expect(claim).toContain('/customer/claim/');
    expect(claim).toContain('tokenHash(rawToken)');
    expect(ops).toContain('activePendingPhoneClaimUrl');
    expect(ops).toContain('customer_claim_url');
  });

  it('does not enqueue or process pending-claim SMS', () => {
    expect(claim).not.toContain('INSERT INTO sms_outbox');
    expect(claim).not.toContain('sms.send_requested');
    expect(worker).not.toContain("recipient_kind === 'pending_phone_claim'");
    expect(worker).not.toContain('pendingPhoneClaimSmsBody');
    expect(ops).not.toContain('customer_sms_status');
    expect(ops).not.toContain('smsStatus');
  });

  it('restores sms_outbox to authenticated-user recipients in a forward migration', () => {
    expect(smsCleanupMigration).toMatch(/delete from outbox_events[\s\S]*pending_phone_draft_claim/i);
    expect(smsCleanupMigration).toMatch(/delete from sms_outbox[\s\S]*recipient_kind = 'pending_phone_claim'/i);
    expect(smsCleanupMigration).toMatch(/alter column user_id set not null/i);
    expect(smsCleanupMigration).toMatch(/drop column if exists recipient_context_id/i);
    expect(smsCleanupMigration).toMatch(/drop column if exists recipient_kind/i);
    expect(migrationFiles).toContain(
      "{ name: '20261003_remove_pending_phone_claim_sms', fileName: '20260922_remove_pending_phone_claim_sms.sql' }",
    );
  });

  it('leaves unrelated notification and Provider OS SMS producers intact', () => {
    expect(notificationService).toContain("'sms.send_requested'");
    expect(notificationService).toContain("'user_notifications'");
    expect(providerOsEvents).toContain("'sms.send_requested'");
    expect(providerOsEvents).toContain("'user_notifications'");
  });

  it('does not expand Provider OS to ownerless drafts', () => {
    expect(providerOs).toContain('if (!draft.poster_user_id)');
    expect(providerOs).toContain("return failure('INVALID_STATE', 'This request is no longer eligible to quote through Provider OS.')");
  });

  it('keeps payment and task materialization unavailable before poster binding', () => {
    expect(quotePayment).toMatch(/d\.poster_user_id = \$3/i);
  });
});
