import { createHash } from 'node:crypto';

import type { ServiceResult } from '../types.js';
import type { TaskCreateQuery } from './TaskCreateService.js';
import type { GenerationContext } from './RecurringScheduleService.js';
import { recurringInvalid } from './RecurringWorkErrors.js';
import type { ControlledOccurrenceResult } from './RecurringWorkTypes.js';

export const RECURRING_UNIVERSAL_V1_BRIDGE_PAUSE_CODE =
  'UNIVERSAL_V1_TASK_DRAFT_BRIDGE_UNAVAILABLE';

export const RECURRING_UNIVERSAL_V1_BRIDGE_BLOCKERS = [
  'RECURRING_TASK_DRAFT_LINK_NOT_MODELED',
  'AUTHENTICATED_POSTER_CLAIM_NOT_AVAILABLE_TO_SCHEDULED_WORKER',
  'SERVICE_CELL_POSTAL_AUTHORITY_NOT_STORED',
  'CONTROLLED_OCCURRENCE_REQUIRES_LEGACY_TASK',
  'CANONICAL_RECURRING_CATEGORY_MAPPING_NOT_VERSIONED',
  'LEGACY_PROVIDER_SELECTION_PRECEDES_UNIVERSAL_ELIGIBILITY',
] as const;

export type RecurringUniversalV1BridgeBlocker =
  (typeof RECURRING_UNIVERSAL_V1_BRIDGE_BLOCKERS)[number];

export interface RecurringUniversalV1BridgeEvidence {
  bridge_contract: 'HUSTLEXP_RECURRING_UNIVERSAL_V1_TASK_DRAFT_BRIDGE';
  bridge_contract_version: 1;
  disposition: 'CONTAINED_NO_DRAFT_NO_TASK';
  bridge_intent_sha256: string;
  generation_key: string;
  series_id: string;
  template_revision_id: string;
  scheduled_start: string;
  blocker_codes: RecurringUniversalV1BridgeBlocker[];
  privacy_posture: 'NO_SCOPE_OR_LOCATION_COPIED';
  payment_creation_frozen: true;
  provider_selection_created: false;
  hard_assignment_created: false;
}

/**
 * Stable identity for the recurrence intent only. It is not a TaskDraft ID,
 * claim, route, opportunity, provider selection, or financial idempotency key.
 */
export function recurringUniversalV1BridgeIntentSha256(
  context: GenerationContext,
): string {
  return createHash('sha256')
    .update([
      'HUSTLEXP_RECURRING_UNIVERSAL_V1_TASK_DRAFT_BRIDGE',
      '1',
      context.row.id,
      context.row.current_revision_id,
      context.scheduledStart.toISOString(),
      context.generationKey,
    ].join('\0'))
    .digest('hex');
}

/**
 * This evidence intentionally excludes title, description, price, provider,
 * access instructions, and exact/coarse location. The current database cannot
 * bind them to a canonical TaskDraft with the required claim and service-cell
 * authority, so generation must remain contained instead of guessing.
 */
export function buildRecurringUniversalV1BridgeEvidence(
  context: GenerationContext,
): RecurringUniversalV1BridgeEvidence {
  return {
    bridge_contract: 'HUSTLEXP_RECURRING_UNIVERSAL_V1_TASK_DRAFT_BRIDGE',
    bridge_contract_version: 1,
    disposition: 'CONTAINED_NO_DRAFT_NO_TASK',
    bridge_intent_sha256: recurringUniversalV1BridgeIntentSha256(context),
    generation_key: context.generationKey,
    series_id: context.row.id,
    template_revision_id: context.row.current_revision_id,
    scheduled_start: context.scheduledStart.toISOString(),
    blocker_codes: [...RECURRING_UNIVERSAL_V1_BRIDGE_BLOCKERS],
    privacy_posture: 'NO_SCOPE_OR_LOCATION_COPIED',
    payment_creation_frozen: true,
    provider_selection_created: false,
    hard_assignment_created: false,
  };
}

export async function containRecurringUniversalV1Bridge(
  query: TaskCreateQuery,
  context: GenerationContext,
  actorId: string | null,
): Promise<ServiceResult<ControlledOccurrenceResult>> {
  const evidence = buildRecurringUniversalV1BridgeEvidence(context);
  const held = await query<{ paused: boolean }>(
    'SELECT pause_recurring_template($1,$2,$3::jsonb,$4) AS paused',
    [
      context.row.id,
      RECURRING_UNIVERSAL_V1_BRIDGE_PAUSE_CODE,
      JSON.stringify(evidence),
      actorId,
    ],
  );
  if (held.rows[0]?.paused !== true) {
    return recurringInvalid(
      'Recurring intent could not be placed on the Universal V1 bridge hold.',
      'RECURRING_UNIVERSAL_V1_CONTAINMENT_FAILED',
    );
  }
  return {
    success: true,
    data: {
      outcome: 'paused',
      pauseCode: RECURRING_UNIVERSAL_V1_BRIDGE_PAUSE_CODE,
      bridgeIntentSha256: evidence.bridge_intent_sha256,
      blockerCodes: [...evidence.blocker_codes],
    },
  };
}
