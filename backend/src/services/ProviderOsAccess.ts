import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../db.js';

export type ProviderOsOperation = 'READ_WORKSPACE' | 'MANAGE_MEMBERS' | 'ASSIGN_CREW';

export function entitlementState(row: {
  status: string; starts_at: Date; expires_at: Date | null;
} | undefined, now = Date.now()): string {
  if (!row) return 'inactive';
  if (row.status !== 'active') return row.status;
  if (row.starts_at.getTime() > now) return 'scheduled';
  if (row.expires_at && row.expires_at.getTime() <= now) return 'expired';
  return 'active';
}

/** Call in the acquisition transaction to hold eligibility through the write.
 * Never used by canonical task execution, payment, proof or address release. */
export async function providerOsOrganizationState(
  organizationId: string, query: QueryFn = db.query.bind(db),
) {
  const org = await query<{ id: string; status: string; provider_enabled: boolean }>(
    `SELECT id, status, provider_enabled FROM business_organizations WHERE id = $1 FOR SHARE`,
    [organizationId],
  );
  if (!org.rows[0] || org.rows[0].status !== 'ACTIVE' || !org.rows[0].provider_enabled) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'This business is not eligible for Provider OS.' });
  }
  const entitlement = await query<{ status: string; starts_at: Date; expires_at: Date | null }>(
    `SELECT status, starts_at, expires_at FROM provider_os_entitlements WHERE organization_id = $1 FOR SHARE`,
    [organizationId],
  );
  return { organizationId, state: entitlementState(entitlement.rows[0]),
    expiresAt: entitlement.rows[0]?.expires_at?.toISOString() ?? null };
}

export async function getProviderOsAccessStatus(input: {
  actorId: string; organizationId: string; operation?: ProviderOsOperation;
}, query: QueryFn = db.query.bind(db)) {
  const member = await query<{ id: string }>(
    `SELECT m.id FROM business_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'ACTIVE'
       AND u.account_status = 'ACTIVE' AND NOT COALESCE(u.is_banned, false)
       AND NOT COALESCE(u.trust_hold, false) FOR SHARE OF m, u`,
    [input.organizationId, input.actorId],
  );
  if (!member.rows[0]) throw new TRPCError({ code: 'FORBIDDEN', message: 'Active business membership required.' });
  await query(`SELECT business_require_action($1, $2, $3)`,
    [input.organizationId, input.actorId, input.operation ?? 'READ_WORKSPACE']);
  return providerOsOrganizationState(input.organizationId, query);
}

export async function assertProviderOsAccess(input: {
  actorId: string; organizationId: string; operation: ProviderOsOperation;
}, query: QueryFn = db.query.bind(db)): Promise<void> {
  const access = await getProviderOsAccessStatus(input, query);
  if (access.state !== 'active') throw new TRPCError({
    code: 'FORBIDDEN', message: 'Provider OS access is not active for this business.',
  });
}
