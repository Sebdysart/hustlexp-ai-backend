import { z } from 'zod';

import type {
  AcceptedUniversalV1ProviderEstimate,
  IssuedUniversalV1ProviderEstimateInvitation,
  IssueUniversalV1ProviderEstimateInvitation,
  SubmitUniversalV1ProviderEstimate,
  SubmittedUniversalV1ProviderEstimate,
} from './UniversalV1EstimateContracts.js';
import {
  UniversalV1EstimateLineItemSchema,
} from './UniversalV1EstimateContracts.js';
import {
  UniversalV1EstimateError,
  type UniversalV1EstimateService,
} from './UniversalV1EstimateService.js';

const uuidSchema = z.string().uuid();
const idempotencyKeySchema = z.string().trim().min(8).max(128)
  .regex(/^[A-Za-z0-9:_-]+$/u);
const positiveCentsSchema = z.number().int().positive().max(100_000_000);
const clientTimestampSchema = z.number().int().positive();

/**
 * Only fields a provider may propose for the customer to review are accepted
 * over the public boundary. Category, region, location, risk, proof policy,
 * currency, provider identity, and every aggregate identifier are deliberately
 * absent and are injected from a server-issued invitation.
 */
export const UniversalV1PublicEstimateScopeSchema = z.object({
  title: z.string().trim().min(3).max(255),
  description: z.string().trim().min(10).max(5_000),
  requirements: z.string().trim().min(1).max(2_000).nullable().default(null),
  checklist: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
}).strict();

export const SubmitUniversalV1ProviderEstimatePublicSchema = z.object({
  quote_id: uuidSchema,
  expected_draft_version: z.number().int().positive(),
  expected_quote_version: z.number().int().nonnegative(),
  scope: UniversalV1PublicEstimateScopeSchema,
  line_items: z.array(UniversalV1EstimateLineItemSchema).min(1).max(100),
  customer_total_cents: positiveCentsSchema,
  provider_payout_cents: positiveCentsSchema,
  idempotency_key: idempotencyKeySchema,
  client_ts: clientTimestampSchema,
}).strict().superRefine((command, context) => {
  const itemTotal = command.line_items.reduce(
    (total, item) => total + item.total_amount_cents,
    0,
  );
  if (!Number.isSafeInteger(itemTotal) || itemTotal !== command.customer_total_cents) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'line-item totals must equal the customer total',
      path: ['customer_total_cents'],
    });
  }
  if (command.provider_payout_cents > command.customer_total_cents) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provider payout cannot exceed the customer total',
      path: ['provider_payout_cents'],
    });
  }
});

export const AcceptUniversalV1ProviderEstimatePublicSchema = z.object({
  provider_estimate_submission_id: uuidSchema,
  expected_draft_version: z.number().int().positive(),
  expected_quote_version: z.number().int().positive(),
  idempotency_key: idempotencyKeySchema,
  client_ts: clientTimestampSchema,
}).strict();

/**
 * A named Operations actor can reference one opaque eligibility fact and the
 * exact versions visible in its review surface. Provider identity, route,
 * credential, quote ID, validity, and every policy snapshot remain absent.
 */
export const IssueUniversalV1ProviderEstimateInvitationPublicSchema = z.object({
  eligibility_decision_id: uuidSchema,
  expected_draft_version: z.number().int().positive(),
  expected_eligibility_version: z.number().int().positive(),
  idempotency_key: idempotencyKeySchema,
  client_ts: clientTimestampSchema,
}).strict();

export type SubmitUniversalV1ProviderEstimatePublic = z.infer<
  typeof SubmitUniversalV1ProviderEstimatePublicSchema
>;
export type AcceptUniversalV1ProviderEstimatePublic = z.infer<
  typeof AcceptUniversalV1ProviderEstimatePublicSchema
>;
export type IssueUniversalV1ProviderEstimateInvitationPublic = z.infer<
  typeof IssueUniversalV1ProviderEstimateInvitationPublicSchema
>;

const trustedInvitationSchema = z.object({
  invitation_id: uuidSchema,
  quote_id: uuidSchema,
  task_draft_id: uuidSchema,
  routing_decision_id: uuidSchema,
  expected_draft_version: z.number().int().positive(),
  expected_quote_version: z.number().int().nonnegative(),
  provider_user_id: uuidSchema,
  provider_organization_id: uuidSchema.nullable(),
  work_category_code: z.string().trim().toLowerCase()
    .regex(/^[a-z][a-z0-9_]{1,63}$/u),
  region_code: z.string().trim().toUpperCase().regex(/^US-[A-Z]{2}$/u),
  rough_location: z.string().trim().min(2).max(120),
  risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'IN_HOME']),
  requires_proof: z.boolean(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/u),
}).strict();

const trustedAcceptanceSchema = z.object({
  provider_estimate_submission_id: uuidSchema,
  task_draft_id: uuidSchema,
  quote_id: uuidSchema,
  quote_version_id: uuidSchema,
  poster_user_id: uuidSchema,
  expected_draft_version: z.number().int().positive(),
  expected_quote_version: z.number().int().positive(),
}).strict();

export type TrustedUniversalV1EstimateInvitation = z.infer<typeof trustedInvitationSchema>;
export type TrustedUniversalV1EstimateAcceptance = z.infer<typeof trustedAcceptanceSchema>;

export interface UniversalV1EstimatePublicFactReader {
  loadSubmissionInvitation(input: {
    actorUserId: string;
    quoteId: string;
    expectedDraftVersion: number;
    expectedQuoteVersion: number;
  }): Promise<TrustedUniversalV1EstimateInvitation | null>;

  loadAcceptance(input: {
    actorUserId: string;
    providerEstimateSubmissionId: string;
    expectedDraftVersion: number;
    expectedQuoteVersion: number;
  }): Promise<TrustedUniversalV1EstimateAcceptance | null>;
}

export interface UniversalV1EstimateCommandService {
  issueProviderEstimateInvitation(
    command: IssueUniversalV1ProviderEstimateInvitation,
  ): Promise<IssuedUniversalV1ProviderEstimateInvitation>;

  submitProviderEstimate(
    command: SubmitUniversalV1ProviderEstimate,
  ): Promise<SubmittedUniversalV1ProviderEstimate>;

  acceptProviderEstimate(command: {
    task_draft_id: string;
    provider_estimate_submission_id: string;
    quote_id: string;
    quote_version_id: string;
    poster_user_id: string;
    actor_user_id: string;
    expected_draft_version: number;
    idempotency_key: string;
  }): Promise<AcceptedUniversalV1ProviderEstimate>;
}

export type UniversalV1EstimatePublicErrorCode =
  | 'ESTIMATE_PUBLIC_CONTEXT_UNAVAILABLE'
  | 'ESTIMATE_PUBLIC_NOT_FOUND'
  | 'ESTIMATE_PUBLIC_REQUEST_STALE'
  | 'ESTIMATE_PUBLIC_VERSION_CONFLICT';

export class UniversalV1EstimatePublicError extends Error {
  constructor(
    readonly code: UniversalV1EstimatePublicErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UniversalV1EstimatePublicError';
  }
}

const MAX_COMMAND_CLOCK_SKEW_MS = 10 * 60 * 1_000;

function publicFailure(
  code: UniversalV1EstimatePublicErrorCode,
  message: string,
): never {
  throw new UniversalV1EstimatePublicError(code, message);
}

function assertFresh(clientTimestamp: number, serverTimestamp: number): void {
  if (Math.abs(serverTimestamp - clientTimestamp) > MAX_COMMAND_CLOCK_SKEW_MS) {
    publicFailure(
      'ESTIMATE_PUBLIC_REQUEST_STALE',
      'The estimate command timestamp is outside the allowed window.',
    );
  }
}

function isKnownEstimateError(error: unknown): error is UniversalV1EstimateError {
  return error instanceof UniversalV1EstimateError;
}

/**
 * Public application adapter for the payment-free estimate lane.
 *
 * The fact reader is the only component allowed to resolve a wire reference
 * into domain identifiers. The domain service remains authoritative for the
 * serializable write and never receives a client-selected actor or policy
 * field.
 */
export class UniversalV1EstimateApplication {
  constructor(
    private readonly facts: UniversalV1EstimatePublicFactReader,
    private readonly estimates: UniversalV1EstimateCommandService,
    private readonly now: () => number = Date.now,
  ) {}

  async issueProviderEstimateInvitation(
    actorUserId: string,
    rawInput: IssueUniversalV1ProviderEstimateInvitationPublic,
  ): Promise<IssuedUniversalV1ProviderEstimateInvitation> {
    const input = IssueUniversalV1ProviderEstimateInvitationPublicSchema.parse(rawInput);
    assertFresh(input.client_ts, this.now());

    try {
      return await this.estimates.issueProviderEstimateInvitation({
        eligibility_decision_id: input.eligibility_decision_id,
        expected_draft_version: input.expected_draft_version,
        expected_eligibility_version: input.expected_eligibility_version,
        actor_user_id: actorUserId,
        idempotency_key: input.idempotency_key,
      });
    } catch (error) {
      if (isKnownEstimateError(error)) throw error;
      return publicFailure(
        'ESTIMATE_PUBLIC_CONTEXT_UNAVAILABLE',
        'The estimate invitation could not be issued.',
      );
    }
  }

  async submitProviderEstimate(
    actorUserId: string,
    rawInput: SubmitUniversalV1ProviderEstimatePublic,
  ): Promise<SubmittedUniversalV1ProviderEstimate> {
    const input = SubmitUniversalV1ProviderEstimatePublicSchema.parse(rawInput);
    assertFresh(input.client_ts, this.now());

    let rawInvitation: TrustedUniversalV1EstimateInvitation | null;
    try {
      rawInvitation = await this.facts.loadSubmissionInvitation({
        actorUserId,
        quoteId: input.quote_id,
        expectedDraftVersion: input.expected_draft_version,
        expectedQuoteVersion: input.expected_quote_version,
      });
    } catch {
      return publicFailure(
        'ESTIMATE_PUBLIC_CONTEXT_UNAVAILABLE',
        'The estimate context could not be loaded.',
      );
    }
    if (!rawInvitation) {
      return publicFailure('ESTIMATE_PUBLIC_NOT_FOUND', 'The estimate is unavailable.');
    }

    let invitation: TrustedUniversalV1EstimateInvitation;
    try {
      invitation = trustedInvitationSchema.parse(rawInvitation);
    } catch {
      return publicFailure(
        'ESTIMATE_PUBLIC_CONTEXT_UNAVAILABLE',
        'The estimate context is not canonical.',
      );
    }
    if (invitation.quote_id !== input.quote_id) {
      return publicFailure('ESTIMATE_PUBLIC_NOT_FOUND', 'The estimate is unavailable.');
    }
    if (
      invitation.expected_draft_version !== input.expected_draft_version
      || invitation.expected_quote_version !== input.expected_quote_version
    ) {
      return publicFailure(
        'ESTIMATE_PUBLIC_VERSION_CONFLICT',
        'The estimate invitation changed before submission.',
      );
    }

    try {
      return await this.estimates.submitProviderEstimate({
        task_draft_id: invitation.task_draft_id,
        routing_decision_id: invitation.routing_decision_id,
        expected_draft_version: invitation.expected_draft_version,
        quote_id: invitation.quote_id,
        expected_quote_version: invitation.expected_quote_version,
        provider: {
          actor_user_id: actorUserId,
          provider_user_id: invitation.provider_user_id,
          provider_organization_id: invitation.provider_organization_id,
        },
        scope: {
          ...input.scope,
          work_category_code: invitation.work_category_code,
          region_code: invitation.region_code,
          rough_location: invitation.rough_location,
          risk_level: invitation.risk_level,
          requires_proof: invitation.requires_proof,
        },
        line_items: input.line_items,
        customer_total_cents: input.customer_total_cents,
        provider_payout_cents: input.provider_payout_cents,
        currency: invitation.currency,
        idempotency_key: input.idempotency_key,
      });
    } catch (error) {
      if (isKnownEstimateError(error)) throw error;
      return publicFailure(
        'ESTIMATE_PUBLIC_CONTEXT_UNAVAILABLE',
        'The estimate command could not be completed.',
      );
    }
  }

  async acceptProviderEstimate(
    actorUserId: string,
    rawInput: AcceptUniversalV1ProviderEstimatePublic,
  ): Promise<AcceptedUniversalV1ProviderEstimate> {
    const input = AcceptUniversalV1ProviderEstimatePublicSchema.parse(rawInput);
    assertFresh(input.client_ts, this.now());

    let rawAcceptance: TrustedUniversalV1EstimateAcceptance | null;
    try {
      rawAcceptance = await this.facts.loadAcceptance({
        actorUserId,
        providerEstimateSubmissionId: input.provider_estimate_submission_id,
        expectedDraftVersion: input.expected_draft_version,
        expectedQuoteVersion: input.expected_quote_version,
      });
    } catch {
      return publicFailure(
        'ESTIMATE_PUBLIC_CONTEXT_UNAVAILABLE',
        'The estimate context could not be loaded.',
      );
    }
    if (!rawAcceptance) {
      return publicFailure('ESTIMATE_PUBLIC_NOT_FOUND', 'The estimate is unavailable.');
    }

    let acceptance: TrustedUniversalV1EstimateAcceptance;
    try {
      acceptance = trustedAcceptanceSchema.parse(rawAcceptance);
    } catch {
      return publicFailure(
        'ESTIMATE_PUBLIC_CONTEXT_UNAVAILABLE',
        'The estimate context is not canonical.',
      );
    }
    if (
      acceptance.provider_estimate_submission_id
        !== input.provider_estimate_submission_id
      || acceptance.poster_user_id !== actorUserId
    ) {
      return publicFailure('ESTIMATE_PUBLIC_NOT_FOUND', 'The estimate is unavailable.');
    }
    if (
      acceptance.expected_draft_version !== input.expected_draft_version
      || acceptance.expected_quote_version !== input.expected_quote_version
    ) {
      return publicFailure(
        'ESTIMATE_PUBLIC_VERSION_CONFLICT',
        'The estimate changed before acceptance.',
      );
    }

    try {
      return await this.estimates.acceptProviderEstimate({
        task_draft_id: acceptance.task_draft_id,
        provider_estimate_submission_id: acceptance.provider_estimate_submission_id,
        quote_id: acceptance.quote_id,
        quote_version_id: acceptance.quote_version_id,
        poster_user_id: actorUserId,
        actor_user_id: actorUserId,
        expected_draft_version: acceptance.expected_draft_version,
        idempotency_key: input.idempotency_key,
      });
    } catch (error) {
      if (isKnownEstimateError(error)) throw error;
      return publicFailure(
        'ESTIMATE_PUBLIC_CONTEXT_UNAVAILABLE',
        'The estimate command could not be completed.',
      );
    }
  }
}

export function asUniversalV1EstimateCommandService(
  service: UniversalV1EstimateService,
): UniversalV1EstimateCommandService {
  return service;
}
