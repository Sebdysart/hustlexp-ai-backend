import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db, type QueryFn } from '../db.js';
import {
  isPlausiblyRandomTaskDraftCardToken,
  taskDraftCardTokenHash,
} from './UniversalV1TaskDraftIngress.js';

export const UniversalV1TaskDraftClaimSchema = z.object({
  submission_id: z.string().uuid(),
  card_token: z.string().regex(/^[0-9a-f]{64}$/iu)
    .refine(isPlausiblyRandomTaskDraftCardToken, 'card token is an obvious low-entropy placeholder'),
  expected_version: z.literal(0),
  idempotency_key: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/u),
  client_ts: z.number().int().positive(),
}).strict();

export type UniversalV1TaskDraftClaimInput = z.infer<
  typeof UniversalV1TaskDraftClaimSchema
>;

export interface UniversalV1TaskDraftClaimResult {
  ok: true;
  submission_id: string;
  draft_id: string;
  status: 'account_claimed';
  claim_version: 1;
  claim_event_id: string;
  replayed: boolean;
  payment_creation_frozen: true;
  hard_assignment_created: false;
  correlation_id: string;
}

// This command links a Poster account to its own contact-captured TaskDraft.
// It is not the external provider "claim" action. Under the underwriting
// contract, that provider action is EXPRESS_INTEREST only and is separately
// forbidden from creating reservations, assignment, private-data release,
// eligibility, Financial Security Events, or money state.

interface ClaimDraftRow {
  id: string;
  submission_id: string;
  card_token_hash: string;
  status: string;
  lead_id: string | null;
  poster_user_id: string | null;
  ingress_origin: string;
}

interface ClaimEventRow {
  id: string;
  task_draft_id: string;
  actor_user_id: string;
  event_version: number;
  expected_version: number;
  idempotency_key: string;
  request_sha256: string;
  status_after: string;
  correlation_id: string;
}

export interface UniversalV1TaskDraftClaimDependencies {
  now: () => number;
  randomUuid: () => string;
  transaction: typeof db.transaction;
}

function fail(code: TRPCError['code'], message: string): never {
  throw new TRPCError({ code, message });
}

function assertFresh(clientTimestamp: number, serverTimestamp: number): void {
  if (Math.abs(serverTimestamp - clientTimestamp) > 10 * 60 * 1_000) {
    fail('BAD_REQUEST', 'Request timestamp too far from server time');
  }
}

function sameTokenHash(storedHash: string, rawToken: string): boolean {
  const suppliedHash = taskDraftCardTokenHash(rawToken);
  if (!/^[0-9a-f]{64}$/iu.test(storedHash) || suppliedHash.length !== storedHash.length) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(storedHash, 'hex'),
    Buffer.from(suppliedHash, 'hex'),
  );
}

export function universalTaskDraftClaimRequestHash(
  input: UniversalV1TaskDraftClaimInput,
  actorUserId: string,
): string {
  return createHash('sha256').update(JSON.stringify({
    submission_id: input.submission_id,
    card_token_sha256: taskDraftCardTokenHash(input.card_token),
    expected_version: input.expected_version,
    idempotency_key: input.idempotency_key,
    client_ts: input.client_ts,
    actor_user_id: actorUserId,
  })).digest('hex');
}

function response(
  input: UniversalV1TaskDraftClaimInput,
  draftId: string,
  eventId: string,
  replayed: boolean,
  correlationId: string,
): UniversalV1TaskDraftClaimResult {
  return {
    ok: true,
    submission_id: input.submission_id,
    draft_id: draftId,
    status: 'account_claimed',
    claim_version: 1,
    claim_event_id: eventId,
    replayed,
    payment_creation_frozen: true,
    hard_assignment_created: false,
    correlation_id: correlationId,
  };
}

async function loadDraftForClaim(
  query: QueryFn,
  submissionId: string,
): Promise<ClaimDraftRow | undefined> {
  const result = await query<ClaimDraftRow>(
    `SELECT id, submission_id, card_token_hash, status, lead_id,
            poster_user_id, ingress_origin
       FROM task_drafts
      WHERE submission_id = $1
      FOR UPDATE`,
    [submissionId],
  );
  return result.rows[0];
}

async function loadEventByIdempotency(
  query: QueryFn,
  actorUserId: string,
  idempotencyKey: string,
): Promise<ClaimEventRow | undefined> {
  const result = await query<ClaimEventRow>(
    `SELECT id, task_draft_id, actor_user_id, event_version,
            expected_version, idempotency_key, request_sha256, status_after,
            correlation_id
       FROM task_draft_account_claim_events
      WHERE actor_user_id = $1 AND idempotency_key = $2`,
    [actorUserId, idempotencyKey],
  );
  return result.rows[0];
}

async function loadEventByDraft(
  query: QueryFn,
  draftId: string,
): Promise<ClaimEventRow | undefined> {
  const result = await query<ClaimEventRow>(
    `SELECT id, task_draft_id, actor_user_id, event_version,
            expected_version, idempotency_key, request_sha256, status_after,
            correlation_id
       FROM task_draft_account_claim_events
      WHERE task_draft_id = $1`,
    [draftId],
  );
  return result.rows[0];
}

function assertExactReplay(
  event: ClaimEventRow,
  draft: ClaimDraftRow,
  actorUserId: string,
  requestHash: string,
): void {
  if (
    event.task_draft_id !== draft.id
    || event.actor_user_id !== actorUserId
    || event.expected_version !== 0
    || event.event_version !== 1
    || event.status_after !== 'account_claimed'
    || event.request_sha256 !== requestHash
  ) {
    fail('CONFLICT', 'Idempotency key was already used for a different claim command');
  }
}

function assertCanonicalExistingClaim(
  event: ClaimEventRow,
  draft: ClaimDraftRow,
  actorUserId: string,
): void {
  if (
    event.task_draft_id !== draft.id
    || event.actor_user_id !== actorUserId
    || event.expected_version !== 0
    || event.event_version !== 1
    || event.status_after !== 'account_claimed'
  ) {
    fail('CONFLICT', 'TaskDraft claim lacks canonical event evidence');
  }
}

async function persistClaim(
  input: UniversalV1TaskDraftClaimInput,
  actorUserId: string,
  correlationId: string,
  dependencies: UniversalV1TaskDraftClaimDependencies,
): Promise<UniversalV1TaskDraftClaimResult> {
  const requestHash = universalTaskDraftClaimRequestHash(input, actorUserId);
  return dependencies.transaction(async (query) => {
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 3))', [
      `${actorUserId}:${input.idempotency_key}`,
    ]);
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 2))', [input.submission_id]);
    const draft = await loadDraftForClaim(query, input.submission_id);
    if (!draft) fail('NOT_FOUND', 'TaskDraft not found');
    if (!sameTokenHash(draft.card_token_hash, input.card_token)) {
      fail('FORBIDDEN', 'TaskDraft capability is invalid');
    }
    if (draft.ingress_origin !== 'BACKEND_POSTGRESQL') {
      fail('FORBIDDEN', 'TaskDraft is not eligible for canonical account claim');
    }
    if (!draft.lead_id) {
      fail('CONFLICT', 'TaskDraft requires canonical contact evidence before account claim');
    }

    const idempotentEvent = await loadEventByIdempotency(
      query,
      actorUserId,
      input.idempotency_key,
    );
    if (idempotentEvent) {
      assertExactReplay(idempotentEvent, draft, actorUserId, requestHash);
      if (draft.status !== 'account_claimed' || draft.poster_user_id !== actorUserId) {
        fail('CONFLICT', 'TaskDraft claim evidence does not match current state');
      }
      return response(
        input,
        draft.id,
        idempotentEvent.id,
        true,
        idempotentEvent.correlation_id,
      );
    }

    if (draft.status === 'account_claimed') {
      if (draft.poster_user_id !== actorUserId) {
        fail('FORBIDDEN', 'TaskDraft belongs to a different account');
      }
      const existingEvent = await loadEventByDraft(query, draft.id);
      if (!existingEvent) {
        fail('CONFLICT', 'TaskDraft claim lacks canonical event evidence');
      }
      assertCanonicalExistingClaim(existingEvent, draft, actorUserId);
      // Browser/session loss can remove the original idempotency key. Recover
      // the immutable claim without adopting the replacement key or writing a
      // second event. Capability token and authoritative owner were checked.
      return response(
        input,
        draft.id,
        existingEvent.id,
        true,
        existingEvent.correlation_id,
      );
    }
    assertFresh(input.client_ts, dependencies.now());
    if (draft.status !== 'contact_captured' || draft.poster_user_id !== null) {
      fail('CONFLICT', 'TaskDraft is not claimable');
    }

    const eventId = dependencies.randomUuid();
    await query(
      `INSERT INTO task_draft_account_claim_events(
         id, task_draft_id, actor_user_id, event_version, expected_version,
         idempotency_key, request_sha256, status_before, status_after,
         correlation_id
       ) VALUES ($1, $2, $3, 1, 0, $4, $5,
                 'contact_captured', 'account_claimed', $6)`,
      [eventId, draft.id, actorUserId, input.idempotency_key, requestHash, correlationId],
    );
    const updated = await query<{ id: string }>(
      `UPDATE task_drafts
          SET poster_user_id = $2,
              claimed_at = clock_timestamp(),
              status = 'account_claimed',
              updated_at = clock_timestamp()
        WHERE id = $1
          AND status = 'contact_captured'
          AND poster_user_id IS NULL
          AND ingress_origin = 'BACKEND_POSTGRESQL'
      RETURNING id`,
      [draft.id, actorUserId],
    );
    if (!updated.rows[0]) fail('CONFLICT', 'TaskDraft changed concurrently');
    return response(input, draft.id, eventId, false, correlationId);
  });
}

export async function claimUniversalV1TaskDraft(
  input: UniversalV1TaskDraftClaimInput,
  actorUserId: string,
  dependencyOverrides: Partial<UniversalV1TaskDraftClaimDependencies> = {},
): Promise<UniversalV1TaskDraftClaimResult> {
  const dependencies: UniversalV1TaskDraftClaimDependencies = {
    now: Date.now,
    randomUuid: randomUUID,
    transaction: db.transaction,
    ...dependencyOverrides,
  };
  return persistClaim(
    input,
    actorUserId,
    dependencies.randomUuid(),
    dependencies,
  );
}
