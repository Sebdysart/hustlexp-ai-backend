import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db.js';
import { businessQuoteRouter } from '../../src/routers/businessQuote.js';
import {
  BUSINESS_QUOTE_STATUSES,
  OPEN_BUSINESS_QUOTE_STATUSES,
  decodeBusinessQuoteCursor,
  listBusinessQuotes,
  normalizeBusinessQuoteStatuses,
} from '../../src/services/BusinessQuoteReadService.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

vi.mock('../../src/db.js', () => ({ db: { query: vi.fn() } }));

const org = '11111111-1111-4111-8111-111111111111';
const otherOrg = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333';
const claimQuote = '44444444-4444-4444-8444-444444444444';
const proposalQuote = '55555555-5555-4555-8555-555555555555';
const providerQuote = '66666666-6666-4666-8666-666666666666';
const draftId = '77777777-7777-4777-8777-777777777777';

function row(overrides: Record<string, unknown> = {}) {
  return {
    quote_id: claimQuote,
    quote_version_id: '88888888-8888-4888-8888-888888888888',
    acquisition_origin: 'claim_link',
    quote_status: 'submitted',
    display_status: 'submitted',
    task_draft_id: draftId,
    task_id: null,
    title: 'Garden cleanup',
    category: 'YARD_WORK',
    customer_name: 'Customer',
    region: 'WA',
    zip: '98101',
    customer_total_cents: 12000,
    payout_cents: 9500,
    arrival_window_start: '2026-10-10T17:00:00Z',
    arrival_window_end: '2026-10-10T19:00:00Z',
    expires_at: '2026-10-09T17:00:00Z',
    created_at: '2026-09-21T10:00:00Z',
    updated_at: '2026-09-21T11:00:00Z',
    claim_link_id: '99999999-9999-4999-8999-999999999999',
    proposal_id: null,
    ...overrides,
  };
}

const query = vi.mocked(db.query);

beforeEach(() => vi.resetAllMocks());

describe('canonical organization business quote list', () => {
  const caller = () =>
    businessQuoteRouter.createCaller({
      user: { id: actor, account_status: 'ACTIVE', is_banned: false } as never,
      firebaseUid: 'test-user',
    });

  it('validates organization, status filters, page size and opaque cursor', async () => {
    await expect(caller().listForOrganization({ organizationId: 'wrong' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller().listForOrganization({ organizationId: org, limit: 101 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().listForOrganization({
        organizationId: org,
        statuses: ['unknown' as never],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().listForOrganization({ organizationId: org, cursor: 'raw-position' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().listForOrganization({ organizationId: org, price: 1 } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(query).not.toHaveBeenCalled();
  });

  it('requires an active organization and exact READ_WORKSPACE membership', async () => {
    query.mockResolvedValueOnce({ rows: [] } as never);
    await expect(caller().listForOrganization({ organizationId: org })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("organization.status = 'ACTIVE'");
    expect(sql).toContain("business_membership_has_action(organization.id, $2, 'READ_WORKSPACE')");
    expect(params).toEqual([org, actor]);
  });

  it('returns claim, proposal and Provider OS quotes once through the same quote-root read', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: org }] } as never);
    query.mockResolvedValueOnce({
      rows: [
        row(),
        row({
          quote_id: proposalQuote,
          acquisition_origin: 'direct_proposal',
          claim_link_id: null,
          proposal_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
        row({
          quote_id: providerQuote,
          acquisition_origin: 'provider_os',
          claim_link_id: null,
          proposal_id: null,
        }),
      ],
    } as never);

    const result = await listBusinessQuotes({
      actorId: actor,
      organizationId: org,
      openOnly: false,
      statuses: null,
      limit: 20,
      cursor: null,
    });

    expect(result.items).toHaveLength(3);
    expect(result.items.map((quote) => quote.acquisitionOrigin)).toEqual([
      'claim_link',
      'direct_proposal',
      'provider_os',
    ]);
    expect(result.items[0]).toMatchObject({
      quoteId: claimQuote,
      claimLinkId: '99999999-9999-4999-8999-999999999999',
      proposalId: null,
      customerTotalCents: 12000,
      payoutCents: 9500,
    });
    expect(result.items[1]).toMatchObject({
      quoteId: proposalQuote,
      proposalId: expect.any(String),
    });
    expect(result.items[2]).toMatchObject({
      quoteId: providerQuote,
      claimLinkId: null,
      proposalId: null,
    });

    const sql = String(query.mock.calls[1][0]);
    expect(sql).toContain('FROM quotes quote');
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('candidate.quote_id = quote.id');
    expect(sql.match(/LIMIT 1/g)).toHaveLength(2);
    expect(sql).not.toContain('provider_os_entitlements');
  });

  it('owns lifecycle and expiry semantics for open-only results', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: org }] } as never);
    query.mockResolvedValueOnce({
      rows: [
        row(),
        row({ quote_id: proposalQuote, quote_status: 'pending_business_verification' }),
        row({ quote_id: providerQuote, quote_status: 'quote_send_ready' }),
        row({ quote_id: 'aaaaaaaa-0000-4000-8000-000000000001', quote_status: 'quote_ready' }),
      ],
    } as never);
    await listBusinessQuotes({
      actorId: actor,
      organizationId: org,
      openOnly: true,
      statuses: null,
      limit: 20,
      cursor: null,
    });

    expect(OPEN_BUSINESS_QUOTE_STATUSES).toEqual([
      'pending_business_verification',
      'submitted',
      'quote_send_ready',
      'quote_ready',
    ]);
    for (const closed of ['draft', 'paid', 'rejected', 'superseded', 'expired', 'withdrawn']) {
      expect(OPEN_BUSINESS_QUOTE_STATUSES).not.toContain(closed);
    }
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain("quote.status = 'submitted'");
    expect(sql).toContain("quote.status = 'pending_business_verification'");
    expect(sql).toContain("THEN 'expired'");
    expect(sql).toContain('OR version.expires_at IS NULL');
    expect(sql).toContain('OR version.arrival_window_end IS NULL');
    expect(sql).toContain('OR version.dispatch_expires_at IS NULL');
    expect(sql).toContain("quote.status = 'quote_send_ready'");
    expect(sql).toContain("payment.status IN ('SUCCEEDED', 'REFUNDED')");
    expect(params).toEqual([org, null, true, OPEN_BUSINESS_QUOTE_STATUSES, null, null, 21]);
  });

  it('returns canonical and effective status independently and resolves durable task linkage', async () => {
    const taskId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    query.mockResolvedValueOnce({ rows: [{ id: org }] } as never);
    query.mockResolvedValueOnce({
      rows: [
        row({
          quote_status: 'submitted',
          display_status: 'expired',
          task_id: taskId,
        }),
      ],
    } as never);
    const result = await listBusinessQuotes({
      actorId: actor,
      organizationId: org,
      openOnly: false,
      statuses: ['submitted'],
      limit: 20,
      cursor: null,
    });
    expect(result.items[0]).toMatchObject({
      quoteStatus: 'submitted',
      displayStatus: 'expired',
      taskId,
    });
    const sql = String(query.mock.calls[1][0]);
    expect(sql).toContain('COALESCE(');
    expect(sql).toContain('CASE WHEN draft.quote_id = quote.id THEN draft.task_id END');
  });

  it('uses proposal-first deterministic routing for null provenance without guessing origin', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: org }] } as never);
    query.mockResolvedValueOnce({
      rows: [
        row({
          acquisition_origin: null,
          claim_link_id: null,
          proposal_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
      ],
    } as never);
    const result = await listBusinessQuotes({
      actorId: actor,
      organizationId: org,
      openOnly: false,
      statuses: null,
      limit: 20,
      cursor: null,
    });
    expect(result.items[0]).toMatchObject({
      acquisitionOrigin: null,
      proposalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      claimLinkId: null,
    });
  });

  it('normalizes filters and uses deterministic cursor pagination bound to the request', async () => {
    const statuses = normalizeBusinessQuoteStatuses(['submitted', 'submitted', 'quote_ready']);
    expect(statuses).toEqual(['submitted', 'quote_ready']);
    query.mockResolvedValueOnce({ rows: [{ id: org }] } as never);
    query.mockResolvedValueOnce({ rows: [row(), row({ quote_id: proposalQuote })] } as never);
    const result = await listBusinessQuotes({
      actorId: actor,
      organizationId: org,
      openOnly: true,
      statuses,
      limit: 1,
      cursor: null,
    });
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeTruthy();
    const cursor = decodeBusinessQuoteCursor(result.nextCursor!, org, true, statuses);
    expect(cursor.quoteId).toBe(claimQuote);
    expect(() => decodeBusinessQuoteCursor(result.nextCursor!, otherOrg, true, statuses)).toThrow();
    expect(() => decodeBusinessQuoteCursor(result.nextCursor!, org, false, statuses)).toThrow();
    expect(() => decodeBusinessQuoteCursor(result.nextCursor!, org, true, ['paid'])).toThrow();
    expect(String(query.mock.calls[1][0])).toContain(
      'ORDER BY quote.created_at DESC, quote.id DESC'
    );
  });

  it('registers indexes after all quote routing tables exist', () => {
    const names = REQUIRED_MIGRATION_FILES.map((migration) => migration.name);
    expect(names.indexOf('20261001_business_quote_list_indexes')).toBeGreaterThan(
      names.indexOf('20260930_tilled_merchant_invitations')
    );
    const migration = readFileSync(
      'backend/database/migrations/20261001_business_quote_list_indexes.sql',
      'utf8'
    );
    expect(migration).toContain('quotes_business_org_created_idx');
    expect(migration).toContain('business_task_proposals_quote_route_idx');
    expect(migration).toContain('ops_business_claim_links_quote_route_idx');
    expect(BUSINESS_QUOTE_STATUSES).toContain('quote_ready');
  });
});
