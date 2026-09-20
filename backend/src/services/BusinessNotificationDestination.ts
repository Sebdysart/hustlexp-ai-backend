import type { QueryFn } from '../db.js';

export interface BusinessNotificationReference {
  id: string;
  entityType: 'quote' | 'assessment';
  entityId: string;
}
interface DestinationContext {
  id: string;
  organization_id: string;
  draft_id: string;
  quote_id: string | null;
  acquisition_origin: string | null;
  task_id: string | null;
  proposal_id: string | null;
  claimed: boolean;
  source_provider_os_relationship_id: string | null;
}

/** Resolve canonical ownership, never infer a claim from a draft/quote ID. */
export async function businessNotificationDestinations(
  query: QueryFn,
  references: BusinessNotificationReference[],
  authority: { organizationId: string } | { actorId: string },
): Promise<Map<string, string | null>> {
  const destinations = new Map<string, string | null>(references.map(r => [r.id, null]));
  if (!references.length) return destinations;
  const result = await query<DestinationContext>(`
    WITH refs AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id TEXT, "entityType" TEXT, "entityId" UUID)
    ), entities AS (
      SELECT r.id, 'quote'::text AS entity_type, q.business_organization_id AS organization_id,
        q.task_draft_id AS draft_id, q.id AS quote_id, q.acquisition_origin,
        NULL::uuid AS source_proposal_id, NULL::uuid AS source_claim_link_id,
        NULL::uuid AS source_provider_os_relationship_id
      FROM refs r JOIN quotes q ON r."entityType" = 'quote' AND q.id = r."entityId"
      UNION ALL
      SELECT r.id, 'assessment'::text, a.business_organization_id, a.task_draft_id,
        NULL::uuid, NULL::text, a.proposal_id, a.claim_link_id,
        a.provider_os_relationship_id
      FROM refs r JOIN business_assessment_requests a ON r."entityType" = 'assessment' AND a.id = r."entityId"
    )
    SELECT e.*, t.id AS task_id, p.id AS proposal_id,
      EXISTS (SELECT 1 FROM ops_business_claim_links c WHERE c.task_draft_id = e.draft_id
        AND c.claimed_by_organization_id = e.organization_id AND c.status = 'CLAIMED'
        AND (e.entity_type = 'quote' OR (e.source_claim_link_id IS NOT NULL AND c.id = e.source_claim_link_id))
        AND (e.quote_id IS NULL OR c.quote_id = e.quote_id)) AS claimed
    FROM entities e JOIN task_drafts d ON d.id = e.draft_id
    LEFT JOIN tasks t ON t.id = d.task_id AND t.business_fulfiller_organization_id = e.organization_id
      AND (e.quote_id IS NULL OR d.quote_id = e.quote_id)
    LEFT JOIN LATERAL (
      SELECT p.id FROM business_task_proposals p WHERE p.task_draft_id = e.draft_id
        AND p.business_organization_id = e.organization_id AND (e.quote_id IS NULL OR p.quote_id = e.quote_id)
        AND (e.entity_type = 'quote' OR (e.source_proposal_id IS NOT NULL AND p.id = e.source_proposal_id))
      ORDER BY p.created_at DESC, p.id DESC LIMIT 1
    ) p ON TRUE
    WHERE ($2::uuid IS NULL OR e.organization_id = $2)
      AND ($3::uuid IS NULL OR business_membership_has_action(e.organization_id, $3, 'READ_WORKSPACE'))
  `, [JSON.stringify(references), 'organizationId' in authority ? authority.organizationId : null,
    'actorId' in authority ? authority.actorId : null]);
  for (const row of result.rows) {
    let destination: string | null = null;
    if (row.task_id) destination = `/business/tasks/${row.task_id}`;
    else if (row.acquisition_origin === 'provider_os' && row.quote_id)
      destination = `/provider-os/quotes/${row.quote_id}?organizationId=${row.organization_id}`;
    else if (row.source_provider_os_relationship_id)
      destination = `/provider-os/drafts/${row.draft_id}?organizationId=${row.organization_id}`;
    else if (row.proposal_id) destination = `/business/proposals/${row.proposal_id}`;
    else if (row.claimed) destination = `/business/claims/${row.draft_id}?organizationId=${row.organization_id}`;
    destinations.set(row.id, destination);
  }
  return destinations;
}
