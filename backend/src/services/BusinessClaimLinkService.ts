// backend/src/services/BusinessClaimLinkService.ts
import crypto from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';

export interface BusinessClaimPreview {
  claimLinkId: string;
  taskDraftId: string;
  title: string;
  category: string;
  scopeSummary: string | null;
  requirements: string | null;
  estimatedPriceMinCents: number | null;
  estimatedPriceMaxCents: number | null;
  zip: string | null;
  region: string | null;
  expiresAt: string;
}

function hashToken(token: string): string {
  return crypto
    .createHash('sha256')
    .update(token.trim())
    .digest('hex');
}

function unavailable(): ServiceResult<never> {
  // Intentionally do not distinguish invalid / expired / claimed / revoked.
  return {
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'This claim link is invalid or no longer available.',
    },
  };
}

export async function getBusinessClaimPreview(
  query: QueryFn,
  rawToken: string,
): Promise<ServiceResult<BusinessClaimPreview>> {
  const token = rawToken.trim();

  if (!/^[0-9a-f]{64}$/i.test(token)) {
    return unavailable();
  }

  const tokenHash = hashToken(token);

  const result = await query<{
    claim_link_id: string;
    task_draft_id: string;
    status: 'OPEN' | 'CLAIMED' | 'EXPIRED' | 'REVOKED';
    expires_at: Date;
    category: string;
    title: string;
    scope_summary: string | null;
    zip: string | null;
    region: string | null;
    raw_input: string | null;
    requirements: string | null;
    est_price_min_cents: number | null;
    est_price_max_cents: number | null;
  }>(
    `
    SELECT
      link.id AS claim_link_id,
      link.task_draft_id,
      link.status,
      link.expires_at,
      draft.category,
      draft.title,
      draft.scope_summary,
      draft.zip,
      draft.region,
      draft.raw_input,
      CASE
        WHEN draft.structured ? 'requirements'
          THEN draft.structured->>'requirements'
        ELSE NULL
      END AS requirements,
      draft.est_price_min_cents,
      draft.est_price_max_cents
    FROM ops_business_claim_links link
    JOIN task_drafts draft
      ON draft.id = link.task_draft_id
    WHERE link.token_hash = $1
    LIMIT 1
    `,
    [tokenHash],
  );

  const row = result.rows[0];

  if (!row) return unavailable();

  if (row.status !== 'OPEN') return unavailable();

  if (row.expires_at.getTime() <= Date.now()) {
    await query(
      `
      UPDATE ops_business_claim_links
      SET status = 'EXPIRED',
          updated_at = NOW()
      WHERE id = $1
        AND status = 'OPEN'
      `,
      [row.claim_link_id],
    );

    return unavailable();
  }

  return {
    success: true,
    data: {
      claimLinkId: row.claim_link_id,
      taskDraftId: row.task_draft_id,
      title: row.title,
      category: row.category,
      scopeSummary: row.scope_summary,
      requirements: row.requirements,
      estimatedPriceMinCents: row.est_price_min_cents,
      estimatedPriceMaxCents: row.est_price_max_cents,
      zip: row.zip,
      region: row.region,
      expiresAt: row.expires_at.toISOString(),
    },
  };
}

export async function getBusinessClaimPreviewPublic(
  rawToken: string,
): Promise<ServiceResult<BusinessClaimPreview>> {
  try {
    return await getBusinessClaimPreview(db.query.bind(db), rawToken);
  } catch {
    return {
      success: false,
      error: {
        code: 'DB_ERROR',
        message: 'Unable to load claim link.',
      },
    };
  }
}
