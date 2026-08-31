import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { db, hasDb } from '../../src/db.js';
import {
  createControlledRecurringTemplate,
  generateControlledRecurringOccurrence,
} from '../../src/services/RecurringWorkService.js';
import {
  RECURRING_UNIVERSAL_V1_BRIDGE_BLOCKERS,
  RECURRING_UNIVERSAL_V1_BRIDGE_PAUSE_CODE,
} from '../../src/services/RecurringUniversalV1BridgeContainment.js';

const describePg = describe.sequential.skipIf(!hasDb);

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

describePg('controlled recurrence Universal V1 containment PostgreSQL proof', () => {
  it('serializes concurrent generation into one privacy-safe hold with no TaskDraft, Task, provider, or money effect', async () => {
    const posterId = randomUUID();
    const marker = randomUUID();
    const title = `Recurring containment ${marker}`;
    const description = `Private recurring scope ${marker}`;
    const exactLocation = `987 Secret Lane ${marker}`;
    const start = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const review = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
    await db.query(
      `INSERT INTO public.users(id,email,full_name)
       VALUES ($1,$2,$3)`,
      [posterId, `recurring-containment-${marker}@example.invalid`, `Poster ${marker}`],
    );

    const created = await createControlledRecurringTemplate({
      posterId,
      clientPrincipalType: 'HOUSEHOLD',
      clientPrincipalId: posterId,
      title,
      description,
      category: 'cleaning',
      taskRecipe: { version: 1, marker },
      exactLocation,
      roughLocation: 'Synthetic service area',
      accessProcedure: `Private access ${marker}`,
      regionCode: 'US-WA',
      riskLevel: 'LOW',
      pattern: 'weekly',
      dayOfWeek: 1,
      dayOfMonth: null,
      timeOfDay: '12:00',
      startDate: dateOnly(start),
      endDate: null,
      timezone: 'America/Los_Angeles',
      serviceWindowStart: '08:00',
      serviceWindowEnd: '18:00',
      expectedDurationMinutes: 60,
      customerTotalCents: 10_000,
      providerPayoutCents: 8_000,
      platformMarginCents: 2_000,
      corridorMinimumCents: 10_000,
      corridorMaximumCents: 10_000,
      maximumAdjustmentCents: 0,
      requiredTrustTier: 1,
      licenseRequirements: {},
      insuranceRequirements: {},
      credentialsValidUntil: null,
      requiredTools: [],
      requiredVehicle: null,
      completionChecklist: ['Synthetic completion proof'],
      preferredWorkerId: null,
      backupWorkerIds: [],
      cancellationRules: { noticeHours: 24 },
      holidayRules: {},
      budgetCapCents: 10_000,
      approverId: posterId,
      escalationRules: { onException: 'pause' },
      invoiceGrouping: { groupBy: 'occurrence' },
      nextReviewDate: dateOnly(review),
    });
    if (!created.success) {
      throw new Error(`${created.error.code}: ${created.error.message}`);
    }
    const seriesId = created.data.id;

    const outcomes = await Promise.all([
      generateControlledRecurringOccurrence({ seriesId, actorId: posterId }),
      generateControlledRecurringOccurrence({ seriesId, actorId: posterId }),
    ]);
    expect(outcomes.every((outcome) => outcome.success)).toBe(true);
    const pauseCodes = outcomes.flatMap((outcome) =>
      outcome.success && outcome.data.pauseCode ? [outcome.data.pauseCode] : []);
    expect(pauseCodes).toContain(RECURRING_UNIVERSAL_V1_BRIDGE_PAUSE_CODE);
    expect(pauseCodes).toContain('TEMPLATE_NOT_ACTIVE');
    const contained = outcomes.find((outcome) =>
      outcome.success
      && outcome.data.pauseCode === RECURRING_UNIVERSAL_V1_BRIDGE_PAUSE_CODE);
    expect(contained).toMatchObject({
      success: true,
      data: {
        outcome: 'paused',
        bridgeIntentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        blockerCodes: RECURRING_UNIVERSAL_V1_BRIDGE_BLOCKERS,
      },
    });

    const proof = await db.query<{
      status: string;
      pause_code: string;
      pause_metadata: Record<string, unknown>;
      occurrence_count: number;
      budget_spend_cents: number;
      tasks: number;
      occurrences: number;
      reservations: number;
      pause_events: number;
      copied_task_drafts: number;
    }>(
      `SELECT series.status,series.pause_code,series.pause_metadata,
              series.occurrence_count,series.budget_spend_cents,
              (SELECT COUNT(*)::integer FROM public.tasks task
                WHERE task.parent_series_id=series.id) AS tasks,
              (SELECT COUNT(*)::integer FROM public.recurring_task_occurrences occurrence
                WHERE occurrence.series_id=series.id) AS occurrences,
              (SELECT COUNT(*)::integer
                 FROM public.recurring_provider_reservations reservation
                 JOIN public.recurring_task_occurrences occurrence
                   ON occurrence.id=reservation.occurrence_id
                WHERE occurrence.series_id=series.id) AS reservations,
              (SELECT COUNT(*)::integer FROM public.recurring_template_pause_events event
                WHERE event.template_id=series.id
                  AND event.pause_code=$2) AS pause_events,
              (SELECT COUNT(*)::integer FROM public.task_drafts draft
                WHERE draft.raw_input=$3 OR draft.title=$4) AS copied_task_drafts
         FROM public.recurring_task_series series
        WHERE series.id=$1`,
      [seriesId, RECURRING_UNIVERSAL_V1_BRIDGE_PAUSE_CODE, description, title],
    );
    expect(proof.rows[0]).toMatchObject({
      status: 'paused',
      pause_code: RECURRING_UNIVERSAL_V1_BRIDGE_PAUSE_CODE,
      occurrence_count: 0,
      budget_spend_cents: 0,
      tasks: 0,
      occurrences: 0,
      reservations: 0,
      pause_events: 1,
      copied_task_drafts: 0,
    });
    expect(proof.rows[0]?.pause_metadata).toMatchObject({
      bridge_contract_version: 1,
      disposition: 'CONTAINED_NO_DRAFT_NO_TASK',
      blocker_codes: RECURRING_UNIVERSAL_V1_BRIDGE_BLOCKERS,
      privacy_posture: 'NO_SCOPE_OR_LOCATION_COPIED',
      payment_creation_frozen: true,
      provider_selection_created: false,
      hard_assignment_created: false,
    });
    const durableEvidence = JSON.stringify(proof.rows[0]?.pause_metadata);
    expect(durableEvidence).not.toContain(title);
    expect(durableEvidence).not.toContain(description);
    expect(durableEvidence).not.toContain(exactLocation);
  });
});
