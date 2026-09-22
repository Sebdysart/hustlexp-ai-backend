import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), sign: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query, transaction: (work: (query: unknown) => unknown) => work(mocks.query) } }));
vi.mock('../../src/storage/backblaze-b2.js', () => ({ backblazeB2: { getSignedUrlForObject: mocks.sign } }));
import { submitOrganizationCredential, reviewBusinessCredential, getCredentialEvidence, readBusinessCredentials } from '../../src/services/BusinessCredentialService.js';
const ids = { actorId: '00000000-0000-4000-8000-000000000001', organizationId: '10000000-0000-4000-8000-000000000001', credentialTypeId: '20000000-0000-4000-8000-000000000001', credentialId: '30000000-0000-4000-8000-000000000001', versionId: '40000000-0000-4000-8000-000000000001' };
const type = { id: ids.credentialTypeId, code: 'TEST_LICENSE', requires_number: true, requires_evidence: true, supports_expiration: true, jurisdiction_code: 'US-WA' };
const credential = { id: ids.credentialId, organization_id: ids.organizationId, current_version_id: ids.versionId, credential_type_id: ids.credentialTypeId, status: 'PENDING', expires_at: '2099-01-01T00:00:00Z' };
function defaults(sql: string) {
  if (sql.includes('business_require_action')) return { rows: [{ id: ids.organizationId }], rowCount: 1 };
  if (sql.includes('FROM admin_roles')) return { rows: [{ allowed: true }], rowCount: 1 };
  if (sql.includes('FROM credential_types')) return { rows: [type], rowCount: 1 };
  if (sql.includes('FROM business_organizations')) return { rows: [{ id: ids.organizationId }], rowCount: 1 };
  if (sql.includes('FROM business_credentials') && sql.includes('FOR UPDATE')) return { rows: [credential], rowCount: 1 };
  if (sql.includes('INSERT INTO business_credentials')) return { rows: [{ id: ids.credentialId }], rowCount: 1 };
  if (sql.includes('UPDATE media_upload_receipts')) return { rows: [{ id: 'receipt', canonical_checksum_sha256: 'a'.repeat(64), canonical_content_type: 'image/jpeg', canonical_size_bytes: 123 }], rowCount: 1 };
  return { rows: [], rowCount: 1 };
}
describe('organization credential management', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.query.mockImplementation(async (sql: string) => defaults(sql)); });
  it('accepts organization credentials with null membership and stores a pending immutable version', async () => {
    const result = await submitOrganizationCredential({ ...ids, membershipId: null, jurisdictionCode: 'US-WA', credentialNumber: 'LIC-123', uploadReceiptIds: ['receipt'], idempotencyKey: 'credential:test:01' });
    expect(result.status).toBe('PENDING');
    const insert = mocks.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO business_credentials'));
    expect(insert?.[1]).toContain(null);
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO business_credential_versions'))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("purpose='BUSINESS_CREDENTIAL'") && sql.includes('organization_id=$2') && sql.includes('uploader_id=$3'))).toBe(true);
  });
  it('rejects a nonfinalized or cross-organization receipt without trusting a URL', async () => {
    mocks.query.mockImplementation(async (sql: string) => sql.includes('UPDATE media_upload_receipts') ? { rows: [] } : defaults(sql));
    await expect(submitOrganizationCredential({ ...ids, jurisdictionCode: 'US-WA', credentialNumber: '123', uploadReceiptIds: ['receipt'], idempotencyKey: 'credential:test:02' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  it('requires an evidence receipt and credential number when registry requires them', async () => {
    await expect(submitOrganizationCredential({ ...ids, jurisdictionCode: 'US-WA', uploadReceiptIds: [], idempotencyKey: 'credential:test:03' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  it('approves only the current submitted version and audits the decision', async () => {
    const result = await reviewBusinessCredential({ ...ids, decision: 'APPROVE', reason: 'Verified against supplied evidence.' });
    expect(result.status).toBe('ACTIVE');
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO ops_action_audit'))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO business_audit_events'))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO business_credential_events'))).toBe(true);
  });
  it('rejects a stale review instead of approving newly replaced evidence', async () => {
    await expect(reviewBusinessCredential({ ...ids, versionId: 'old-version', decision: 'APPROVE', reason: 'Verified evidence.' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('records rejection without marking a credential active', async () => {
    expect((await reviewBusinessCredential({ ...ids, decision: 'REJECT', reason: 'License number does not match.' })).status).toBe('REJECTED');
  });
  it('revocation records a manual review signal without changing task state or historical decision', async () => {
    mocks.query.mockImplementation(async (sql: string) => sql.includes('FROM business_credentials') && sql.includes('FOR UPDATE') ? { rows: [{ ...credential, status: 'ACTIVE' }] } : defaults(sql));
    expect((await reviewBusinessCredential({ ...ids, decision: 'REVOKE', reason: 'Authority revoked license.' })).status).toBe('REVOKED');
    const text = mocks.query.mock.calls.map(([sql]) => sql).join('\n');
    expect(text).toContain('INSERT INTO business_credential_review_signals');
    expect(text).not.toMatch(/UPDATE tasks|UPDATE business_quote_eligibility_decisions/);
  });
  it('denies adjudication to a caller without current Ops capability', async () => {
    mocks.query.mockImplementation(async (sql: string) => sql.includes('FROM admin_roles') ? { rows: [{ allowed: false }] } : defaults(sql));
    await expect(reviewBusinessCredential({ ...ids, decision: 'APPROVE', reason: 'Claimed approval.' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('authorizes evidence by exact organization and consumed receipt before signing', async () => {
    mocks.query.mockImplementation(async (sql: string) => sql.includes('JOIN media_upload_receipts') ? { rows: [{ canonical_key: 'private/credential.jpg' }] } : defaults(sql));
    mocks.sign.mockResolvedValue('https://private.example/object?signature=secret');
    expect(await getCredentialEvidence({ ...ids, evidenceId: 'evidence' }, true)).toMatchObject({ downloadUrl: expect.stringContaining('https://') });
    expect(mocks.sign).toHaveBeenCalledWith('private/credential.jpg', 300);
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO business_credential_media_access_log'))).toBe(true);
  });
  it('does not sign evidence absent a matching consumed receipt', async () => {
    await expect(getCredentialEvidence({ ...ids, evidenceId: 'foreign-evidence' }, true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it('returns effective expiration without rewriting historical credentials', async () => {
    mocks.query.mockImplementation(async (sql: string) => sql.includes('SELECT c.*') ? { rows: [{ ...credential, status: 'ACTIVE', effective_status: 'EXPIRED', expires_at: '2000-01-01', evidence: [], history: [] }] } : defaults(sql));
    const result = await readBusinessCredentials(ids.actorId, ids.organizationId);
    expect(result.credentials[0]?.effectiveStatus).toBe('EXPIRED');
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('UPDATE business_credentials'))).toBe(false);
  });
  it('preserves member-specific submissions but requires that exact active membership', async () => {
    await expect(submitOrganizationCredential({ ...ids, membershipId:'foreign-member', jurisdictionCode:'US-WA', credentialNumber:'123', uploadReceiptIds:['receipt'], idempotencyKey:'credential:member:01' })).rejects.toMatchObject({code:'BAD_REQUEST'});
    expect(mocks.query.mock.calls.find(([sql])=>sql.includes('FROM business_memberships'))?.[1]).toEqual(['foreign-member',ids.organizationId]);
  });
  it('does not let an expired pending submission be approved', async () => {
    mocks.query.mockImplementation(async(sql:string)=>sql.includes('FROM business_credentials')&&sql.includes('FOR UPDATE')?{rows:[{...credential,expires_at:'2000-01-01'}]}:defaults(sql));
    await expect(reviewBusinessCredential({...ids,decision:'APPROVE',reason:'Review of expired document.'})).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  });
  it('appends a new version for resubmission without overwriting old evidence/history', async () => {
    await submitOrganizationCredential({...ids,jurisdictionCode:'US-WA',credentialNumber:'renewed-number',uploadReceiptIds:['new-receipt'],idempotencyKey:'credential:renewal:01'});
    const sql=mocks.query.mock.calls.map(([text])=>text).join('\n');
    expect(sql).toContain('INSERT INTO business_credential_versions');
    expect(sql).not.toMatch(/UPDATE business_credential_versions|DELETE FROM business_credential/);
  });
  it('replays the same submission deterministically without consuming receipts again', async () => {
    await submitOrganizationCredential({...ids,jurisdictionCode:'US-WA',credentialNumber:'123',uploadReceiptIds:['receipt'],idempotencyKey:'credential:replay:01'});
    const write=mocks.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO business_credential_versions'));
    const hash=write?.[1]?.[5];
    mocks.query.mockClear();
    mocks.query.mockImplementation(async(sql:string)=>sql.includes('SELECT id,credential_id,submission_hash')?{rows:[{id:ids.versionId,credential_id:ids.credentialId,submission_hash:hash}]}:defaults(sql));
    expect(await submitOrganizationCredential({...ids,jurisdictionCode:'US-WA',credentialNumber:'123',uploadReceiptIds:['receipt'],idempotencyKey:'credential:replay:01'})).toEqual({id:ids.credentialId,status:'PENDING',versionId:ids.versionId});
    expect(mocks.query.mock.calls.some(([sql])=>sql.includes('UPDATE media_upload_receipts'))).toBe(false);
  });
  it('exposes bounded revocation review signals only to Operations', async () => {
    mocks.query.mockImplementation(async(sql:string)=>sql.includes('FROM business_credential_review_signals')?{rows:[{credentialId:ids.credentialId,quoteId:'quote',taskId:'task',reason:'CREDENTIAL_REVOKED',createdAt:'2026-01-01T00:00:00Z'}]}:defaults(sql));
    expect((await readBusinessCredentials(ids.actorId,ids.organizationId,true)).reviewSignals).toHaveLength(1);
    expect(mocks.query.mock.calls.find(([sql])=>sql.includes('FROM business_credential_review_signals'))?.[0]).toContain('LIMIT 100');
    mocks.query.mockClear();
    expect((await readBusinessCredentials(ids.actorId,ids.organizationId)).reviewSignals).toEqual([]);
    expect(mocks.query.mock.calls.some(([sql])=>sql.includes('FROM business_credential_review_signals'))).toBe(false);
  });
});
