import {
  exactVersion,
  fail,
  iso,
  type InterestJourneyRow,
  type InterestRow,
  type OpportunityRow,
  universalV1TaskOpportunityAuthority,
  universalV1TaskOpportunityPreEstimateJourneyAuthority,
} from './UniversalV1TaskOpportunityModel.js';

function requiredStandardizedValue<T>(
  value: T | null | undefined,
  message: string
): T {
  return value ?? fail('INTERNAL_SERVER_ERROR', message);
}

function standardizedScopeArtifact(row: OpportunityRow) {
  if (!row.standardized_quote_id) return null;
  return {
    kind: requiredStandardizedValue(
      row.standardized_scope_artifact_kind,
      'Standardized scope artifact kind is missing.'
    ),
    id: requiredStandardizedValue(
      row.standardized_scope_artifact_id,
      'Standardized scope artifact id is missing.'
    ),
    version: exactVersion(
      requiredStandardizedValue(
        row.standardized_scope_artifact_version,
        'Standardized scope artifact version is missing.'
      ),
      'Standardized scope artifact'
    ),
    sha256: requiredStandardizedValue(
      row.standardized_scope_artifact_sha256?.trim(),
      'Standardized scope artifact digest is missing.'
    ),
  };
}

function scopeArtifactProjection(row: OpportunityRow) {
  const interestScopeArtifact = {
    kind: row.scope_artifact_kind,
    id: row.scope_artifact_id,
    version: exactVersion(row.scope_artifact_version, 'Interest scope artifact'),
    sha256: row.scope_artifact_sha256.trim(),
  };
  return {
    interestScopeArtifact,
    standardizedScopeArtifact: standardizedScopeArtifact(row),
  };
}

function standardizedQuoteProjection(
  row: OpportunityRow,
  scopeArtifact: NonNullable<ReturnType<typeof standardizedScopeArtifact>> | null
) {
  if (!row.standardized_quote_id) return null;
  return {
    quoteVersionId: row.standardized_quote_id,
    quoteVersion: exactVersion(
      requiredStandardizedValue(
        row.standardized_quote_version,
        'Standardized quote version is missing.'
      ),
      'Standardized quote'
    ),
    quoteEvidenceSha256: requiredStandardizedValue(
      row.standardized_quote_sha256?.trim(),
      'Standardized quote evidence is missing.'
    ),
    scopeArtifact: requiredStandardizedValue(
      scopeArtifact,
      'Standardized scope artifact is missing.'
    ),
    customerTotalCents: exactVersion(
      requiredStandardizedValue(
        row.customer_total_cents,
        'Standardized quote total is missing.'
      ),
      'Customer total'
    ),
    currency: requiredStandardizedValue(
      row.currency,
      'Standardized quote currency is missing.'
    ),
    fakePaymentMethodReady: row.fake_payment_method_ready,
    paymentMethodReadinessPosture: row.payment_method_readiness_posture,
    paymentCreationCreated: false as const,
    financialSecurityEventCreated: false as const,
  };
}

export function opportunityResult(row: OpportunityRow) {
  const artifacts = scopeArtifactProjection(row);
  return {
    opportunityId: row.opportunity_id,
    opportunityVersion: exactVersion(row.opportunity_version, 'Task Opportunity'),
    taskDraftId: row.task_draft_id,
    routing: {
      decisionId: row.routing_decision_id,
      decisionVersion: exactVersion(row.routing_decision_version, 'Routing decision'),
      policyVersion: row.routing_policy_version,
      outcome: row.routing_outcome,
    },
    relationshipOrigin: {
      id: row.relationship_origin_id,
      version: exactVersion(row.relationship_origin_version, 'Relationship origin'),
      kind: row.relationship_origin_kind,
      policyVersion: exactVersion(
        row.relationship_origin_policy_version,
        'Relationship origin policy'
      ),
    },
    // The provider-facing scope may use the standardized artifact; the
    // interest command remains bound to the immutable route-context artifact.
    scopeArtifact: artifacts.standardizedScopeArtifact ?? artifacts.interestScopeArtifact,
    interestScopeArtifact: artifacts.interestScopeArtifact,
    publicScope: row.public_scope,
    serviceCell: {
      authorityId: row.service_cell_authority_id,
      authorityVersion: exactVersion(row.service_cell_authority_version, 'Service cell authority'),
      evidenceSha256: row.service_cell_evidence_sha256.trim(),
      regionCode: row.region_code,
    },
    workCategoryCode: row.work_category_code,
    roughLocation: row.rough_location,
    riskLevel: row.risk_level,
    requiresProof: row.requires_proof,
    routedAt: iso(row.routed_at),
    privacyPosture: artifacts.standardizedScopeArtifact
      ? ('STANDARDIZED_SCOPE_ALLOWLIST_ONLY' as const)
      : row.privacy_posture,
    eligibilityStatus: 'PENDING' as const,
    eligibilityPosture: row.eligibility_posture,
    assignmentStatus: 'PENDING' as const,
    assignmentAuthority: row.assignment_authority,
    addressContactAuthority: row.address_contact_authority,
    financialAuthority: row.financial_authority,
    guaranteedEarningAuthority: row.guaranteed_earning_authority,
    standardizedQuote: standardizedQuoteProjection(row, artifacts.standardizedScopeArtifact),
  };
}

export function interestResult(row: InterestRow, idempotencyReplayed: boolean) {
  return {
    interestId: row.interest_id,
    opportunityId: row.opportunity_id,
    opportunityVersion: exactVersion(row.opportunity_version, 'Task Opportunity'),
    taskDraftId: row.task_draft_id,
    providerClass: row.provider_class,
    providerBindingSha256: row.provider_binding_sha256.trim(),
    providerCapabilitySha256: row.provider_capability_sha256.trim(),
    tradeQualificationSha256: row.trade_qualification_sha256?.trim() ?? null,
    routing: {
      decisionId: row.routing_decision_id,
      decisionVersion: exactVersion(row.routing_decision_version, 'Routing decision'),
      policyVersion: row.routing_policy_version,
      outcome: row.routing_outcome,
    },
    relationshipOrigin: {
      id: row.relationship_origin_id,
      version: exactVersion(row.relationship_origin_version, 'Relationship origin'),
    },
    scopeArtifact: {
      kind: row.scope_artifact_kind,
      id: row.scope_artifact_id,
      version: exactVersion(row.scope_artifact_version, 'Scope artifact'),
      sha256: row.scope_artifact_sha256.trim(),
    },
    serviceCell: {
      authorityId: row.service_cell_authority_id,
      authorityVersion: exactVersion(row.service_cell_authority_version, 'Service cell authority'),
      regionCode: row.region_code,
    },
    workCategoryCode: row.work_category_code,
    roughLocation: row.rough_location,
    riskLevel: row.risk_level,
    requiresProof: row.requires_proof,
    status: row.status,
    expressedAt: iso(row.created_at),
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256.trim(),
    idempotencyReplayed,
    eligibilityStatus: 'PENDING' as const,
    assignmentStatus: 'PENDING' as const,
    reservationCreated: false as const,
    eligibilityDecisionCreated: false as const,
    assignmentCreated: false as const,
    addressContactAccessGranted: false as const,
    financialEventCreated: false as const,
    payableCreated: false as const,
    guaranteedEarning: false as const,
    authority: universalV1TaskOpportunityAuthority,
  };
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function nullableExactVersion(value: number | string | null, label: string): number | null {
  return value === null ? null : exactVersion(value, label);
}

function nullableNonnegativeExactVersion(
  value: number | string | null,
  label: string
): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return fail('INTERNAL_SERVER_ERROR', `${label} returned an invalid exact version.`);
  }
  return parsed;
}

function eligibilityProjection(row: InterestJourneyRow) {
  const current = row.eligibility_is_current === true
    && row.opportunity_is_current === true
    && row.task_specific_provider_observation_current === true;
  const state = row.eligibility_decision_id === null
    ? 'NOT_DECIDED' as const
    : !current
      ? 'STALE' as const
      : row.eligibility_task_eligible === true
        ? 'CURRENT_ELIGIBLE' as const
        : 'CURRENT_INELIGIBLE' as const;
  return {
    state,
    decisionId: row.eligibility_decision_id,
    decisionVersion: nullableExactVersion(
      row.eligibility_decision_version,
      'Task eligibility decision'
    ),
    taskEligible: row.eligibility_task_eligible,
    validUntil: nullableIso(row.eligibility_valid_until),
    current,
  };
}

function invitationState(
  row: InterestJourneyRow,
  eligibilityState: ReturnType<typeof eligibilityProjection>['state']
) {
  if (eligibilityState !== 'CURRENT_ELIGIBLE') return 'BLOCKED_BY_TASK_ELIGIBILITY' as const;
  if (row.invitation_id === null) return 'HELD_PENDING_AUTHORIZED_INVITATION_COMMAND' as const;
  if (row.invitation_is_current === true) return 'ISSUED' as const;
  return 'EXPIRED_OR_STALE' as const;
}

function invitationProjection(
  row: InterestJourneyRow,
  state: ReturnType<typeof invitationState>
) {
  return {
    state,
    invitationId: row.invitation_is_current ? row.invitation_id : null,
    quoteId: row.invitation_is_current ? row.invitation_quote_id : null,
    expectedQuoteVersion: row.invitation_is_current
      ? nullableNonnegativeExactVersion(row.expected_quote_version, 'Provider estimate quote')
      : null,
    validUntil: row.invitation_is_current ? nullableIso(row.invitation_valid_until) : null,
  };
}

function observationsAreStale(
  row: InterestJourneyRow,
  eligibilityState: ReturnType<typeof eligibilityProjection>['state']
): boolean {
  return row.opportunity_is_current !== true
    || row.task_specific_provider_observation_current !== true
    || eligibilityState === 'STALE';
}

function journeyNextStep(
  row: InterestJourneyRow,
  eligibilityState: ReturnType<typeof eligibilityProjection>['state'],
  estimateInvitationState: ReturnType<typeof invitationState>
) {
  if (row.status !== 'pending') {
    return { nextStep: 'INTEREST_CLOSED' as const, blockerCodes: [] as string[] };
  }
  if (observationsAreStale(row, eligibilityState)) {
    return {
      nextStep: 'RECORD_NEW_INTEREST_FOR_CURRENT_OPPORTUNITY' as const,
      blockerCodes: [
        row.opportunity_is_current === true
          ? 'PROVIDER_OR_ELIGIBILITY_OBSERVATION_CHANGED'
          : 'OPPORTUNITY_VERSION_CHANGED',
      ],
    };
  }
  if (eligibilityState === 'NOT_DECIDED') {
    const blockerCodes = ['ACTOR_ATTESTATION_DECISION_REQUIRED'];
    if (row.routing_outcome === 'FULFILLMENT_CANDIDATE') {
      blockerCodes.push('STANDARDIZED_QUOTE_COMMAND_NOT_IMPLEMENTED');
    }
    return {
      nextStep: row.routing_outcome === 'ESTIMATE_REQUIRED'
        ? 'AWAIT_APPROVED_INITIAL_ELIGIBILITY_COMMAND' as const
        : 'AWAIT_APPROVED_QUOTE_AND_ELIGIBILITY_COMMAND' as const,
      blockerCodes,
    };
  }
  if (eligibilityState === 'CURRENT_INELIGIBLE') {
    return {
      nextStep: 'NO_ESTIMATE_INVITATION_FOR_INELIGIBLE_PROVIDER' as const,
      blockerCodes: ['TASK_ELIGIBILITY_NOT_MET'],
    };
  }
  if (estimateInvitationState !== 'ISSUED') {
    return {
      nextStep: 'AWAIT_AUTHORIZED_ESTIMATE_INVITATION' as const,
      blockerCodes: ['ACTOR_ATTESTATION_DECISION_REQUIRED'],
    };
  }
  return { nextStep: 'SUBMIT_PROVIDER_ESTIMATE' as const, blockerCodes: [] as string[] };
}

export function interestJourneyResult(row: InterestJourneyRow) {
  const taskEligibility = eligibilityProjection(row);
  const estimateInvitationState = invitationState(row, taskEligibility.state);
  const continuation = journeyNextStep(row, taskEligibility.state, estimateInvitationState);
  return {
    interest: interestResult(row, false),
    interestStatus: row.status,
    opportunityCurrent: row.opportunity_is_current,
    providerObservationCurrent: row.task_specific_provider_observation_current,
    taskEligibility,
    processorEligibility: {
      decisionPresent: row.eligibility_decision_id !== null,
      paymentEligibleObservation: row.processor_payment_eligible ?? false,
      payoutFundingEligibleObservation: row.payout_funding_eligible ?? false,
      positiveAuthority: 'NONE' as const,
    },
    estimateInvitation: invitationProjection(row, estimateInvitationState),
    nextStep: continuation.nextStep,
    blockerCodes: continuation.blockerCodes,
    commandMutationPerformed: false as const,
    authority: universalV1TaskOpportunityPreEstimateJourneyAuthority,
  };
}
