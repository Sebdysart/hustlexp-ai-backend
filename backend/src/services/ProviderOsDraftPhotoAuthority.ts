import { TRPCError } from '@trpc/server';
import type { QueryFn } from '../db.js';
import { assertProviderOsAccess } from './ProviderOsAccess.js';
import { PROVIDER_OS_ELIGIBLE_DRAFT_STATUSES } from './ProviderOsPolicy.js';

export async function assertProviderOsDraftPhotoAuthority(input: {
  actorId: string; organizationId: string; taskDraftId: string;
}, query: QueryFn): Promise<void> {
  await assertProviderOsAccess({ ...input, operation: 'READ_WORKSPACE' }, query);
  const result = await query(`SELECT d.id FROM task_drafts d
    JOIN provider_os_relationships r ON r.poster_user_id = d.poster_user_id
      AND r.provider_organization_id = $2 AND r.status = 'active'
    JOIN users u ON u.id = d.poster_user_id AND u.account_status = 'ACTIVE'
    WHERE d.id = $1 AND d.task_id IS NULL AND d.claimed_at IS NULL AND d.quote_id IS NULL
      AND d.status = ANY($3::text[])
    FOR SHARE OF d, r, u`,
  [input.taskDraftId, input.organizationId, [...PROVIDER_OS_ELIGIBLE_DRAFT_STATUSES]]);
  if (!result.rows[0]) throw new TRPCError({ code: 'FORBIDDEN', message: 'Request photos unavailable.' });
}
