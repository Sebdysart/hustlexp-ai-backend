import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ query: vi.fn(), access: vi.fn(), publish: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query, transaction: (fn: (query: unknown) => unknown) => fn(mocks.query) } }));
vi.mock('../../src/services/ProviderOsAccess.js', () => ({ assertProviderOsAccess: mocks.access }));
vi.mock('../../src/services/BusinessQuoteActivationService.js', () => ({
  PENDING_BUSINESS_VERIFICATION: 'pending_business_verification', publishBusinessQuoteInTransaction: mocks.publish,
}));
import { assertProviderOsDraftPhotoAuthority } from '../../src/services/ProviderOsDraftPhotoAuthority.js';
import { getProviderOsQuote, listProviderOsQuotes } from '../../src/services/ProviderOsQuoteHistory.js';
import { createBusinessQuoteInTransaction } from '../../src/services/BusinessClaimService.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

beforeEach(() => { vi.resetAllMocks(); mocks.access.mockResolvedValue(undefined); });
describe('Provider OS history and media authority', () => {
  it.each(['history', 'detail', 'photos'])('checks selected organization access before reading %s', async (kind) => {
    mocks.access.mockRejectedValue(new Error('Access revoked'));
    const input = { actorId: 'actor', organizationId: 'org' };
    const promise = kind === 'history' ? listProviderOsQuotes(input)
      : kind === 'detail' ? getProviderOsQuote({ ...input, quoteId: 'quote' })
        : assertProviderOsDraftPhotoAuthority({ ...input, taskDraftId: 'draft' }, mocks.query);
    await expect(promise).rejects.toThrow('Access revoked');
    expect(mocks.access).toHaveBeenCalledWith({ ...input,
      ...(kind === 'detail' ? { quoteId: 'quote' } : kind === 'photos' ? { taskDraftId: 'draft' } : {}),
      operation: 'READ_WORKSPACE' }, mocks.query);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('requires the draft relationship and eligibility even after the org guard passes', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(assertProviderOsDraftPhotoAuthority({ actorId: 'actor', organizationId: 'org-a', taskDraftId: 'draft-b' }, mocks.query)).rejects.toThrow('unavailable');
    const [sql, params] = mocks.query.mock.calls[0];
    expect(params.slice(0, 2)).toEqual(['draft-b', 'org-a']);
    for (const clause of ["r.status = 'active'", 'r.poster_user_id = d.poster_user_id',
      'd.task_id IS NULL', 'd.claimed_at IS NULL', 'd.quote_id IS NULL', 'd.status = ANY', 'FOR SHARE OF d, r, u']) expect(sql).toContain(clause);
  });
  it('allows an eligible related draft for the explicit org', async () => {
    mocks.query.mockResolvedValue({ rows: [{ id: 'draft' }] });
    await expect(assertProviderOsDraftPhotoAuthority({ actorId: 'member-2', organizationId: 'org', taskDraftId: 'draft' }, mocks.query)).resolves.toBeUndefined();
  });
  it('does not disclose another organization quote or its versions', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(getProviderOsQuote({ actorId: 'actor', organizationId: 'org-a', quoteId: 'quote-b' })).rejects.toThrow('unavailable');
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][1]).toEqual(['org-a', 'quote-b']);
    expect(mocks.query.mock.calls[0][0]).toContain("q.business_organization_id = $1 AND q.acquisition_origin = 'provider_os'");
  });
  it('paginates bounded org quote history without requiring a claim record', async () => {
    mocks.query.mockResolvedValue({ rows: Array.from({ length: 51 }, (_, i) => ({ id: `q-${i}`, cursor_created_at: '2026-09-19T12:00:00.123456Z' })) });
    const result = await listProviderOsQuotes({ actorId: 'member-2', organizationId: 'org', cursor: { createdAt: '2026-09-20T00:00:00Z', id: 'last' } });
    expect(result.quotes).toHaveLength(50);
    expect(result.nextCursor).toEqual({ createdAt: '2026-09-19T12:00:00.123456Z', id: 'q-49' });
    const [sql, values] = mocks.query.mock.calls[0];
    expect(sql).toContain('LIMIT 51');
    expect(sql).not.toContain('claim_links');
    expect(sql).not.toContain('claimed_by_user_id =');
    expect(sql).toContain('WHEN d.quote_id = q.id THEN d.task_id ELSE NULL');
    expect(values).toEqual(['org', '2026-09-20T00:00:00Z', 'last']);
  });
});

it.each(['provider_os', 'direct_proposal', 'claim_link'] as const)('persists server origin %s on canonical quote and version snapshot', async (acquisitionOrigin) => {
  mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'quote' }] })
    .mockResolvedValueOnce({ rows: [{ id: 'version' }] }).mockResolvedValue({ rows: [] });
  mocks.publish.mockResolvedValue(true);
  const result = await createBusinessQuoteInTransaction(mocks.query, {
    acquisitionOrigin, draft: { id: 'draft', title: 'Work', scope_summary: 'Scope', poster_user_id: 'poster' },
    actorId: 'actor', organizationId: 'org', proposedCustomerTotalCents: 12000, proposedPayoutCents: 10000,
    arrivalWindowStart: '2026-10-01T12:00:00Z', arrivalWindowEnd: '2026-10-02T23:59:59Z', quoteExpiresAt: new Date('2026-10-01'),
  });
  expect(result.success).toBe(true);
  expect(mocks.query.mock.calls[1][0]).toContain('acquisition_origin');
  expect(mocks.query.mock.calls[1][1][5]).toBe(acquisitionOrigin);
  expect(JSON.parse(mocks.query.mock.calls[2][1][4]).acquisition_origin).toBe(acquisitionOrigin);
  expect(mocks.publish).toHaveBeenCalled();
});

it('registers the additive migration after ownership and photo-audit prerequisites without guessing legacy origin', () => {
  const names = REQUIRED_MIGRATION_FILES.map((entry) => entry.name as string);
  const index = names.indexOf('20260919_provider_os_quote_origin');
  expect(index).toBeGreaterThan(names.indexOf('20260918_provider_os_organization_access'));
  expect(index).toBeGreaterThan(names.indexOf('20260914_claim_preview_photo_access_audit'));
  const sql = readFileSync('backend/database/migrations/20260919_provider_os_quote_origin.sql', 'utf8');
  expect(sql).toContain('ADD COLUMN acquisition_origin TEXT NULL');
  expect(sql).not.toMatch(/UPDATE\s+quotes/i);
  expect(sql).toContain("access_context = 'PROVIDER_OS'");
});

it('filters eligible draft rows before LIMIT and excludes quotes by organization, not actor', () => {
  const source = readFileSync('backend/src/services/ProviderOsService.ts', 'utf8');
  const feed = source.slice(source.indexOf('export async function listProviderOsDrafts'), source.indexOf('export async function getProviderOsDraft'));
  expect(feed).toContain('d.claimed_at IS NULL AND d.task_id IS NULL AND d.quote_id IS NULL');
  expect(feed.indexOf('d.status = ANY($3::text[])')).toBeLessThan(feed.indexOf('LIMIT 100'));
  expect(feed).toContain('q.business_organization_id = $1');
  expect(feed).not.toContain('.filter(');
});
