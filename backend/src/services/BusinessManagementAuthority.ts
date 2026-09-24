import { TRPCError } from '@trpc/server';
import type { QueryFn } from '../db.js';
import type { BusinessAction } from './BusinessWorkspacePolicy.js';
import { recordOpsAudit } from './OpsAuditService.js';

/** Current membership, eligible account and exact organization; never UI mode. */
export async function requireBusinessManagementAuthority(query: QueryFn, actorId: string, organizationId: string, action: BusinessAction): Promise<void> {
  const result = await query<{ id: string }>(
    `SELECT o.id, business_require_action(o.id,$2,$3)
       FROM business_organizations o JOIN users u ON u.id=$2
      WHERE o.id=$1 AND o.status='ACTIVE' AND u.account_status='ACTIVE'
      FOR SHARE OF o,u`, [organizationId, actorId, action]);
  if (!result.rows[0]) throw new TRPCError({ code: 'FORBIDDEN', message: 'Active business workspace access is required.' });
}

/** Recheck capability inside privileged transactions, including private delivery. */
export async function requireOperationsAuthority(query: QueryFn, actorId: string): Promise<void> {
  const result = await query<{ allowed: boolean }>(
    `SELECT (a.role IN ('admin','founder') OR COALESCE(a.can_manage_operations,false)) AS allowed
       FROM admin_roles a JOIN users u ON u.id=a.user_id
      WHERE a.user_id=$1 AND u.account_status='ACTIVE'
        AND a.role IN ('admin','founder','support','finance','moderator') FOR SHARE OF a,u`, [actorId]);
  if (!result.rows[0]?.allowed) throw new TRPCError({ code: 'FORBIDDEN', message: 'Operations management access is required.' });
}

export async function recordBusinessManagementAudit(query: QueryFn, input: {
  actorId: string; organizationId: string; action: string; objectType: string; objectId: string;
  after: Record<string, unknown>; before?: Record<string, unknown>; ops?: boolean;
}): Promise<void> {
  await query(`INSERT INTO business_audit_events(organization_id,actor_id,action,object_type,object_id,before_state,after_state)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`, [input.organizationId,input.actorId,input.action,input.objectType,input.objectId,
    input.before ? JSON.stringify(input.before) : null, JSON.stringify(input.after)]);
  if (input.ops) await recordOpsAudit({actorUserId:input.actorId,action:input.action,targetType:input.objectType,
    targetId:input.objectId,meta:{organizationId:input.organizationId,...input.after}},query,true);
}
