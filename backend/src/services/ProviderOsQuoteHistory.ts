import { TRPCError } from '@trpc/server';
import { db } from '../db.js';
import { assertProviderOsAccess } from './ProviderOsAccess.js';

interface ProviderOsQuoteRow {
  id: string;
  task_draft_id: string;
  title: string;
  status: string;
  display_status: string;
  acquisition_origin: 'provider_os';
  created_at: Date;
  cursor_created_at: string;
  active_version_id: string | null;
  task_id: string | null;
  customer_description: string | null;
  total_cents: number | null;
  hustler_payout_cents: number | null;
  arrival_window_start: Date | null;
  arrival_window_end: Date | null;
  expires_at: Date | null;
}

// Quote ownership is durable read authority for the business's own commercial
// record, even if a client relationship is later revoked. It grants no new draft access.
const projection = `SELECT q.id, q.task_draft_id, q.title, q.status, q.acquisition_origin,
  q.created_at, to_char(q.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
  q.active_version_id,
  CASE WHEN d.quote_id = q.id THEN d.task_id ELSE NULL END AS task_id,
  qv.customer_description, qv.total_cents, qv.hustler_payout_cents,
  qv.arrival_window_start, qv.arrival_window_end, qv.expires_at,
  CASE
    WHEN d.quote_id = q.id AND d.task_id IS NOT NULL THEN 'materialized'
    WHEN q.status = 'submitted' AND qv.expires_at <= NOW() THEN 'expired'
    ELSE q.status END AS display_status
 FROM quotes q
 JOIN task_drafts d ON d.id = q.task_draft_id
 LEFT JOIN quote_versions qv ON qv.id = q.active_version_id AND qv.quote_id = q.id
 WHERE q.business_organization_id = $1 AND q.acquisition_origin = 'provider_os'`;

export async function listProviderOsQuotes(input: {
  actorId: string; organizationId: string;
  cursor?: { createdAt: string; id: string };
}) {
  return db.transaction(async (query) => {
    await assertProviderOsAccess({ ...input, operation: 'READ_WORKSPACE' }, query);
    const result = await query<ProviderOsQuoteRow>(`${projection}
      AND ($2::timestamptz IS NULL OR (q.created_at, q.id) < ($2::timestamptz, $3::uuid))
      ORDER BY q.created_at DESC, q.id DESC LIMIT 51`,
    [input.organizationId, input.cursor?.createdAt ?? null, input.cursor?.id ?? null]);
    const quotes = result.rows.slice(0, 50);
    const last = quotes[quotes.length - 1];
    return { quotes, nextCursor: result.rows.length > 50 && last
      ? { createdAt: last.cursor_created_at, id: last.id } : null };
  });
}

export async function getProviderOsQuote(input: {
  actorId: string; organizationId: string; quoteId: string;
}) {
  return db.transaction(async (query) => {
    await assertProviderOsAccess({ ...input, operation: 'READ_WORKSPACE' }, query);
    const result = await query<ProviderOsQuoteRow>(`${projection} AND q.id = $2`, [input.organizationId, input.quoteId]);
    if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Quote unavailable.' });
    const versions = await query(`SELECT id, version_number, status, customer_description,
      total_cents, hustler_payout_cents, arrival_window_start, arrival_window_end, expires_at
      FROM quote_versions WHERE quote_id = $1 ORDER BY version_number DESC`, [input.quoteId]);
    return { quote: result.rows[0], versions: versions.rows };
  });
}
