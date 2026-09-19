import type { QueryFn } from '../db.js';

/** Caller holds the organization FOR UPDATE lock. Shared manual and paid grant/audit writer. */
export async function writeProviderOsEntitlement(
  query: QueryFn,
  input: {
    organizationId: string;
    actorId: string;
    status: 'active' | 'suspended' | 'revoked';
    expiresAt?: string | null;
    reason: string;
    purchaseId?: string;
  }
) {
  const before = await query(`SELECT * FROM provider_os_entitlements WHERE organization_id = $1`, [
    input.organizationId,
  ]);
  const result = await query(
    `INSERT INTO provider_os_entitlements
          (organization_id, status, starts_at, expires_at, granted_by_user_id, granted_at,
           changed_by_user_id, suspended_at, revoked_at, reason, grant_source, source_purchase_id)
          VALUES ($1, $2::text, NOW(), $3::timestamptz,
            CASE WHEN $2::text = 'active' THEN $4::uuid ELSE NULL END,
            CASE WHEN $2::text = 'active' THEN NOW() ELSE NULL END, $4,
            CASE WHEN $2::text = 'suspended' THEN NOW() ELSE NULL END,
            CASE WHEN $2::text = 'revoked' THEN NOW() ELSE NULL END, $5, $6, $7)
          ON CONFLICT (organization_id) DO UPDATE SET status = EXCLUDED.status,
            starts_at = CASE WHEN EXCLUDED.status = 'active' THEN NOW() ELSE provider_os_entitlements.starts_at END,
            expires_at = CASE WHEN EXCLUDED.status = 'active' THEN EXCLUDED.expires_at ELSE provider_os_entitlements.expires_at END,
            granted_by_user_id = COALESCE(EXCLUDED.granted_by_user_id, provider_os_entitlements.granted_by_user_id),
            granted_at = COALESCE(EXCLUDED.granted_at, provider_os_entitlements.granted_at),
            changed_by_user_id = EXCLUDED.changed_by_user_id, suspended_at = EXCLUDED.suspended_at,
            revoked_at = EXCLUDED.revoked_at,
            grant_source = CASE WHEN EXCLUDED.status = 'active' THEN EXCLUDED.grant_source ELSE provider_os_entitlements.grant_source END,
            source_purchase_id = CASE WHEN EXCLUDED.status = 'active' THEN EXCLUDED.source_purchase_id ELSE provider_os_entitlements.source_purchase_id END, reason = EXCLUDED.reason, updated_at = NOW()
          RETURNING *`,
    [
      input.organizationId,
      input.status,
      input.status === 'active' ? (input.expiresAt ?? null) : null,
      input.actorId,
      input.reason,
      input.purchaseId ? 'purchase' : 'manual_ops',
      input.purchaseId ?? null,
    ]
  );
  await query(
    `INSERT INTO ops_action_audit (actor_user_id, actor_label, action, target_type, target_id, meta)
          VALUES ($1, $4, 'PROVIDER_OS_ENTITLEMENT_CHANGED', 'business_organization', $2, $3::jsonb)`,
    [
      input.actorId,
      input.organizationId,
      JSON.stringify({
        before: before.rows[0] ?? null,
        after: result.rows[0],
        ...(input.purchaseId ? { purchaseId: input.purchaseId } : {}),
      }),
      input.purchaseId ? 'purchase' : 'ops',
    ]
  );
  return { entitlement: result.rows[0] };
}
