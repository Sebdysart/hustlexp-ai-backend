import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { publicProcedure, router } from '../../trpc.js';

const LegacyPostTaskSchema = z.object({
  lead: z.object({
    submission_id: z.string().uuid(),
    lead_type: z.enum(['poster', 'hustler', 'business', 'founder']),
    email: z.string().email().max(254),
    name: z.string().max(200).optional(),
    phone: z.string().max(30).optional(),
    region: z.string().max(100).optional(),
    zip: z.string().max(20).optional(),
    answers: z.record(z.unknown()).default({}),
    utm: z.record(z.unknown()).default({}),
    consent_version: z.literal('v1'),
    ip_hash: z.string().optional(),
  }),
  task: z.object({
    category: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(255),
    raw_input: z.string().optional(),
    scope_summary: z.string().optional(),
    structured: z.record(z.unknown()).default({}),
    est_price_min_cents: z.number().int().nonnegative().optional(),
    est_price_max_cents: z.number().int().nonnegative().optional(),
    photo_count: z.number().int().nonnegative().default(0),
    zip: z.string().max(20).optional(),
    region: z.string().max(100).optional(),
    source: z.string().default('website'),
    utm: z.record(z.unknown()).default({}),
    ip_hash: z.string().optional(),
  }),
});

/**
 * Historical compatibility boundary. `webTaskDrafts.submit` is the sole public
 * TaskDraft writer and owns privacy minimization, bot protection, parsing,
 * versioning, idempotency, and the six-way routing fact. This route must never
 * recreate the former lead + draft + generated-quote side channel.
 */
function throwLegacyPostTaskTombstone(): never {
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message:
      'Legacy post-task intake is retired. Submit the request through the Universal V1 TaskDraft intake.',
    cause: { applicationCode: 'LEGACY_TASK_DRAFT_WRITER_TOMBSTONED' },
  });
}

export const webPostTaskRouter = router({
  start: publicProcedure
    .input(LegacyPostTaskSchema)
    .mutation(throwLegacyPostTaskTombstone),
});

export type WebPostTaskRouter = typeof webPostTaskRouter;
