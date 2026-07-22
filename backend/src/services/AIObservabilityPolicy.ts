export type AIConfidenceBand = 'STRONG_SIGNAL' | 'LIKELY' | 'SUGGESTION' | 'UNKNOWN';

export type AIUserControls = {
  apply: boolean;
  edit: boolean;
  dismiss: boolean;
  snooze: boolean;
  why: true;
  approve: boolean;
  override: boolean;
  autoExecute: false;
  reversible: true;
};

export type AIObservabilityContract = {
  surfaceId: string;
  authorityLevel: 'A2_PROPOSAL_ONLY' | 'INFORMATIONAL_ONLY';
  action: string;
  scopeAffected: string;
  reason: string;
  evidenceClasses: readonly string[];
  expectedBenefit: string;
  uncertainty: string;
  downside: string;
  policyVersion: string;
  confidenceBand: AIConfidenceBand;
  controls: AIUserControls;
  outcomeSource: string;
};

export type AIObservationContext = AIObservabilityContract & {
  actorUserId: string | null;
  affectedObjectType: string;
  affectedObjectId: string;
};

const proposalControls = (overrides: Partial<AIUserControls> = {}): AIUserControls => ({
  apply: false,
  edit: false,
  dismiss: true,
  snooze: false,
  why: true,
  approve: false,
  override: true,
  autoExecute: false,
  reversible: true,
  ...overrides,
});

const informationalControls = (): AIUserControls => proposalControls({ dismiss: true, override: true });

export const AI_OBSERVABILITY_CONTRACTS = {
  'AI-COMPLIANCE-ADVISORY': {
    surfaceId: 'AI-COMPLIANCE-ADVISORY', authorityLevel: 'A2_PROPOSAL_ONLY',
    action: 'Classify ambiguous task language for reviewer context', scopeAffected: 'task_compliance_advisory',
    reason: 'Typed compliance rules found an ambiguous or explicitly unusual task.',
    evidenceClasses: ['SANITIZED_TASK_LANGUAGE', 'DETERMINISTIC_COMPLIANCE_SIGNALS'],
    expectedBenefit: 'Give reviewers additional context without changing the executable compliance decision.',
    uncertainty: 'The model is uncalibrated for legal or safety truth; deterministic policy remains authoritative.',
    downside: 'The advisory can be wrong or over-sensitive and must not allow, deny, or price a task.',
    policyVersion: 'hxos-compliance-advisory-v1', confidenceBand: 'UNKNOWN',
    controls: proposalControls({ approve: true }), outcomeSource: 'compliance_violations and canonical task policy',
  },
  'AI-CONTENT-MODERATION-ROUTING': {
    surfaceId: 'AI-CONTENT-MODERATION-ROUTING', authorityLevel: 'A2_PROPOSAL_ONLY',
    action: 'Propose moderation category and queue priority', scopeAffected: 'content_review_queue',
    reason: 'Submitted content requires a privacy and safety classification before human review.',
    evidenceClasses: ['SANITIZED_CONTENT_TEXT', 'DETERMINISTIC_CONTENT_PATTERNS'],
    expectedBenefit: 'Route potentially harmful content to an attributable reviewer faster.',
    uncertainty: 'Context, dialect, and intent may be misunderstood; model confidence is not a final decision.',
    downside: 'False positives can delay legitimate content and false negatives can miss harmful content.',
    policyVersion: 'hxos-content-moderation-advisory-v1', confidenceBand: 'UNKNOWN',
    controls: proposalControls({ approve: true }), outcomeSource: 'content_moderation_queue review and appeal state',
  },
  'AI-DISPUTE-PROPOSAL': {
    surfaceId: 'AI-DISPUTE-PROPOSAL', authorityLevel: 'A2_PROPOSAL_ONLY',
    action: 'Organize dispute evidence and propose review questions or resolution', scopeAffected: 'dispute_review',
    reason: 'An authorized reviewer requested assistance organizing an active dispute.',
    evidenceClasses: ['DISPUTE_STATE', 'TASK_STATE', 'ESCROW_STATE', 'EVIDENCE_METADATA', 'TRANSACTION_HISTORY'],
    expectedBenefit: 'Reduce review time while preserving authorized human control over the outcome.',
    uncertainty: 'The model cannot determine contractual truth, credibility, or entitlement.',
    downside: 'A biased or incomplete synthesis can anchor a reviewer to the wrong conclusion.',
    policyVersion: 'hxos-dispute-advisory-v1', confidenceBand: 'UNKNOWN',
    controls: proposalControls({ approve: true }), outcomeSource: 'disputes, dispute events, and escrow resolution',
  },
  'AI-INCIDENT-DIAGNOSIS': {
    surfaceId: 'AI-INCIDENT-DIAGNOSIS', authorityLevel: 'INFORMATIONAL_ONLY',
    action: 'Summarize an operational incident and suggest a diagnostic next step', scopeAffected: 'operations_incident_diagnosis',
    reason: 'An operator requested a faster synthesis of recorded incident facts.',
    evidenceClasses: ['INCIDENT_FACTS', 'SERVICE_HEALTH', 'RECENT_ERROR_CLASSES'],
    expectedBenefit: 'Shorten time to a testable diagnosis without changing production state.',
    uncertainty: 'The diagnosis is a hypothesis and may omit an unobserved dependency or root cause.',
    downside: 'Following an unverified hypothesis can waste operator time or delay the correct repair.',
    policyVersion: 'hxos-incident-diagnosis-v1', confidenceBand: 'UNKNOWN',
    controls: informationalControls(), outcomeSource: 'incident status, operator remedy, and recovery telemetry',
  },
  'AI-INSTANT-TASK-ADVISORY': {
    surfaceId: 'AI-INSTANT-TASK-ADVISORY', authorityLevel: 'A2_PROPOSAL_ONLY',
    action: 'Assess whether task language appears complete enough for Instant mode', scopeAffected: 'instant_task_advisory',
    reason: 'Deterministic task checks completed and an advisory completeness opinion was requested.',
    evidenceClasses: ['TASK_SCOPE_FIELDS', 'DETERMINISTIC_INSTANT_GATES'],
    expectedBenefit: 'Explain missing scope while leaving Instant eligibility to typed policy.',
    uncertainty: 'The model cannot validate address, timing, eligibility, safety, or supply.',
    downside: 'A plausible-looking opinion can overstate task readiness.',
    policyVersion: 'hxos-instant-task-advisory-v1', confidenceBand: 'UNKNOWN',
    controls: proposalControls({ edit: true }), outcomeSource: 'instant eligibility result and canonical task state',
  },
  'AI-ENGINEERING-INTENT': {
    surfaceId: 'AI-ENGINEERING-INTENT', authorityLevel: 'INFORMATIONAL_ONLY',
    action: 'Suggest implementation scope for an engineering request', scopeAffected: 'internal_engineering_analysis',
    reason: 'An engineering user requested a repository-scoped implementation analysis.',
    evidenceClasses: ['DOCUMENTATION_RETRIEVAL', 'REPOSITORY_PATHS', 'REQUEST_TEXT'],
    expectedBenefit: 'Reduce discovery time before human engineering review.',
    uncertainty: 'Repository context may be incomplete or stale and no code change is authorized.',
    downside: 'Incorrect file or dependency suggestions can waste engineering effort.',
    policyVersion: 'hxos-engineering-intent-v1', confidenceBand: 'UNKNOWN',
    controls: informationalControls(), outcomeSource: 'human repository review and version-control evidence',
  },
  'AI-PROOF-JUDGE-ADVISORY': {
    surfaceId: 'AI-PROOF-JUDGE-ADVISORY', authorityLevel: 'A2_PROPOSAL_ONLY',
    action: 'Synthesize non-authoritative proof signals for a reviewer', scopeAffected: 'proof_review_advisory',
    reason: 'A proof package has deterministic verification signals that require attributable review.',
    evidenceClasses: ['PROOF_METADATA', 'CHECKLIST_COVERAGE', 'GPS_RISK', 'TRAVEL_RISK'],
    expectedBenefit: 'Organize proof inconsistencies without approving work or releasing money.',
    uncertainty: 'Evidence quality and contractual completion cannot be established by the model.',
    downside: 'An overconfident synthesis can bias proof review.',
    policyVersion: 'hxos-proof-judge-advisory-v1', confidenceBand: 'UNKNOWN',
    controls: proposalControls({ approve: true }), outcomeSource: 'proof review decision and canonical task/escrow state',
  },
  'AI-KNOWLEDGE-EMBEDDING': {
    surfaceId: 'AI-KNOWLEDGE-EMBEDDING', authorityLevel: 'INFORMATIONAL_ONLY',
    action: 'Create a documentation vector for similarity retrieval', scopeAffected: 'internal_document_retrieval',
    reason: 'Internal documentation was indexed or queried for engineering context.',
    evidenceClasses: ['DOCUMENT_TEXT_HASH', 'DOCUMENT_PATH'],
    expectedBenefit: 'Retrieve potentially relevant documentation without mutating marketplace state.',
    uncertainty: 'Vector similarity does not prove relevance, completeness, or correctness.',
    downside: 'Poor retrieval can omit the authoritative source or surface irrelevant context.',
    policyVersion: 'hxos-knowledge-retrieval-v1', confidenceBand: 'UNKNOWN',
    controls: informationalControls(), outcomeSource: 'retrieved document list and human interpretation',
  },
  'AI-MATCHMAKER-PROPOSALS': {
    surfaceId: 'AI-MATCHMAKER-PROPOSALS', authorityLevel: 'A2_PROPOSAL_ONLY',
    action: 'Propose candidate order, match explanation, or non-binding price hint', scopeAffected: 'task_match_proposal',
    reason: 'Eligible candidate and task facts are available for a non-binding marketplace recommendation.',
    evidenceClasses: ['ELIGIBLE_CANDIDATES', 'TASK_REQUIREMENTS', 'DISTANCE', 'VERIFIED_SKILLS', 'PRICE_POLICY'],
    expectedBenefit: 'Help users review qualified matches without assigning work.',
    uncertainty: 'Availability, travel, preference, and task fit can change after the proposal.',
    downside: 'A weak proposal can create ranking bias or a misleading price anchor.',
    policyVersion: 'hxos-matchmaker-proposal-v1', confidenceBand: 'UNKNOWN',
    controls: proposalControls({ edit: true }), outcomeSource: 'offer, reservation, assignment, and task outcomes',
  },
  'AI-ONBOARDING-ROLE-INFERENCE': {
    surfaceId: 'AI-ONBOARDING-ROLE-INFERENCE', authorityLevel: 'A2_PROPOSAL_ONLY',
    action: 'Suggest a default Poster or Hustler onboarding mode', scopeAffected: 'onboarding_mode_suggestion',
    reason: 'The user supplied optional onboarding text that may indicate their preferred mode.',
    evidenceClasses: ['SANITIZED_ONBOARDING_RESPONSE'],
    expectedBenefit: 'Reduce setup friction while requiring explicit confirmation.',
    uncertainty: 'Short or ambiguous text may not represent the user’s actual intent.',
    downside: 'A wrong default can confuse the user if it is mistaken for a final role.',
    policyVersion: 'hxos-onboarding-role-inference-v1', confidenceBand: 'UNKNOWN',
    controls: proposalControls({ apply: true, edit: true }), outcomeSource: 'confirmed onboarding mode and override flag',
  },
  'AI-PHOTO-COMPARISON-ADVISORY': {
    surfaceId: 'AI-PHOTO-COMPARISON-ADVISORY', authorityLevel: 'A2_PROPOSAL_ONLY',
    action: 'Compare private task media for reviewer context', scopeAffected: 'proof_photo_advisory',
    reason: 'An authorized proof-review workflow requested a consistency signal.',
    evidenceClasses: ['PURPOSE_BOUND_PROOF_MEDIA', 'CAPTURE_METADATA'],
    expectedBenefit: 'Identify possible evidence-quality issues without deciding completion.',
    uncertainty: 'Visual similarity cannot prove contractual completion, identity, or licensed qualification.',
    downside: 'Image ambiguity can create false approval or rejection pressure.',
    policyVersion: 'hxos-photo-consistency-advisory-v1', confidenceBand: 'UNKNOWN',
    controls: proposalControls({ approve: true }), outcomeSource: 'proof review decision and reviewer override',
  },
  'AI-REPUTATION-ADVISORY': {
    surfaceId: 'AI-REPUTATION-ADVISORY', authorityLevel: 'A2_PROPOSAL_ONLY',
    action: 'Propose a reputation analysis or explanatory insight', scopeAffected: 'reputation_advisory',
    reason: 'Verified transaction history is available for a non-authoritative summary.',
    evidenceClasses: ['VERIFIED_TRANSACTIONS', 'TRANSACTION_REVIEWS', 'DISPUTE_HISTORY', 'RECENCY'],
    expectedBenefit: 'Explain recorded performance without changing trust tier or dispatch eligibility.',
    uncertainty: 'Sparse history and local context can make the analysis unreliable.',
    downside: 'A misleading narrative can unfairly frame a new or low-volume worker.',
    policyVersion: 'hxos-reputation-advisory-v1', confidenceBand: 'UNKNOWN',
    controls: proposalControls({ dismiss: true }), outcomeSource: 'deterministic tier policy, appeals, and later task outcomes',
  },
  'AI-SCOPER-PROPOSAL': {
    surfaceId: 'AI-SCOPER-PROPOSAL', authorityLevel: 'A2_PROPOSAL_ONLY',
    action: 'Propose editable task scope, duration, difficulty, and price context', scopeAffected: 'task_draft_scope',
    reason: 'The Poster supplied a free-form local-work description that needs structured review.',
    evidenceClasses: ['SANITIZED_TASK_DESCRIPTION', 'CATEGORY', 'TEMPLATE_POLICY', 'DETERMINISTIC_COMPLIANCE_RESULT'],
    expectedBenefit: 'Turn intent into a faster editable draft before payment or dispatch.',
    uncertainty: 'Physical conditions, access, quantity, tools, risk, and local supply may still be unknown.',
    downside: 'An incomplete proposal can under-scope work or create a misleading price anchor.',
    policyVersion: 'hxos-scoper-proposal-v1', confidenceBand: 'UNKNOWN',
    controls: proposalControls({ apply: true, edit: true, snooze: true }), outcomeSource: 'scope confirmation, task creation, and canonical task outcomes',
  },
  'AI-TASK-BATCHING-PROPOSAL': {
    surfaceId: 'AI-TASK-BATCHING-PROPOSAL', authorityLevel: 'A2_PROPOSAL_ONLY',
    action: 'Propose a route-efficient set of independently reservable tasks', scopeAffected: 'route_chain_proposal',
    reason: 'A worker requested an optional grouping of currently eligible tasks.',
    evidenceClasses: ['ELIGIBLE_TASKS', 'DISTANCE', 'TIME_WINDOWS', 'GROSS_PAYOUT'],
    expectedBenefit: 'Reduce travel burden without reserving or accepting work automatically.',
    uncertainty: 'Duration, travel, availability, and downstream task state can change.',
    downside: 'A poor chain can increase lateness, cancellation, or uneconomic travel.',
    policyVersion: 'hxos-task-batching-proposal-v1', confidenceBand: 'UNKNOWN',
    controls: proposalControls({ apply: true }), outcomeSource: 'independent reservations, task completion, and route outcomes',
  },
  'AI-DISCOVERY-EXPLANATION': {
    surfaceId: 'AI-DISCOVERY-EXPLANATION', authorityLevel: 'INFORMATIONAL_ONLY',
    action: 'Explain an already calculated task match', scopeAffected: 'task_discovery_explanation',
    reason: 'The worker requested plain-language context for a deterministic match.',
    evidenceClasses: ['MATCH_SCORE', 'VERIFIED_SKILLS', 'DISTANCE', 'TASK_REQUIREMENTS'],
    expectedBenefit: 'Make ranking reasons easier to understand without changing rank.',
    uncertainty: 'The explanation may omit a relevant factor and does not guarantee fit or availability.',
    downside: 'Fluent text can appear more authoritative than the deterministic evidence.',
    policyVersion: 'hxos-discovery-explanation-v1', confidenceBand: 'UNKNOWN',
    controls: informationalControls(), outcomeSource: 'offer review and task outcome telemetry',
  },
  'AI-TASK-SUGGESTION-PROPOSAL': {
    surfaceId: 'AI-TASK-SUGGESTION-PROPOSAL', authorityLevel: 'A2_PROPOSAL_ONLY',
    action: 'Select and explain opportunities from an already eligible feed', scopeAffected: 'task_discovery_order',
    reason: 'The worker requested qualified opportunities within their capability and travel filters.',
    evidenceClasses: ['VERIFIED_SKILLS', 'DISTANCE', 'MATCH_SCORE', 'TRUST_TIER', 'COMPLETED_TASKS'],
    expectedBenefit: 'Help the worker find economically rational work faster.',
    uncertainty: 'Fit is an estimate and exact payout, travel, scope, tools, timing, and risk require review.',
    downside: 'A weak suggestion can waste review time; dismissal never lowers rank or trust.',
    policyVersion: 'hxos-task-suggestion-v1', confidenceBand: 'UNKNOWN',
    controls: proposalControls({ apply: true, snooze: true }), outcomeSource: 'recommendation events and canonical task outcomes',
  },
} as const satisfies Record<string, AIObservabilityContract>;

export type AIObservabilitySurfaceId = keyof typeof AI_OBSERVABILITY_CONTRACTS;

export function aiObservation(
  surfaceId: AIObservabilitySurfaceId,
  context: {
    actorUserId?: string | null;
    affectedObjectType: string;
    affectedObjectId?: string | null;
  },
): AIObservationContext {
  return {
    ...AI_OBSERVABILITY_CONTRACTS[surfaceId],
    actorUserId: context.actorUserId ?? null,
    affectedObjectType: context.affectedObjectType.trim().slice(0, 80),
    affectedObjectId: context.affectedObjectId?.trim().slice(0, 200) || 'UNBOUND',
  };
}
