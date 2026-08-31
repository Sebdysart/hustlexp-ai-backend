import type {
  AcceptUniversalV1ProviderEstimate,
  AcceptedUniversalV1ProviderEstimate,
  IssuedUniversalV1ProviderEstimateInvitation,
  IssueUniversalV1ProviderEstimateInvitation,
  SubmitUniversalV1ProviderEstimate,
  SubmittedUniversalV1ProviderEstimate,
} from './UniversalV1EstimateContracts.js';
import {
  AcceptUniversalV1ProviderEstimateSchema,
  IssueUniversalV1ProviderEstimateInvitationSchema,
  SubmitUniversalV1ProviderEstimateSchema,
  universalV1EstimateAcceptanceRequestSha256,
  universalV1EstimateSubmissionRequestSha256,
} from './UniversalV1EstimateContracts.js';

export type UniversalV1EstimateErrorCode =
  | 'ESTIMATE_ACCEPTANCE_IDEMPOTENCY_CONFLICT'
  | 'ESTIMATE_ACCEPTANCE_NOT_ALLOWED'
  | 'ESTIMATE_ACCEPTANCE_VERSION_CONFLICT'
  | 'ESTIMATE_IDEMPOTENCY_CONFLICT'
  | 'ESTIMATE_INVITATION_REQUIRED'
  | 'ESTIMATE_INVITATION_ALREADY_ISSUED'
  | 'ESTIMATE_INVITATION_CONTEXT_INVALID'
  | 'ESTIMATE_INVITATION_CREATE_FAILED'
  | 'ESTIMATE_INVITATION_EXPIRED'
  | 'ESTIMATE_INVITATION_IDEMPOTENCY_CONFLICT'
  | 'ESTIMATE_INVITATION_NOT_FOUND'
  | 'ESTIMATE_INVITATION_NOT_ALLOWED'
  | 'ESTIMATE_INVITATION_OPERATOR_NOT_AUTHORIZED'
  | 'ESTIMATE_INVITATION_VERSION_CONFLICT'
  | 'ESTIMATE_PROVIDER_NOT_AUTHORIZED'
  | 'ESTIMATE_QUOTE_VERSION_CONFLICT'
  | 'ESTIMATE_ROUTE_NOT_ACTIVE'
  | 'ESTIMATE_ROUTE_NOT_ESTIMATE_REQUIRED'
  | 'ESTIMATE_TASK_MATERIALIZATION_FAILED'
  | 'ESTIMATE_TRADE_QUALIFICATION_REQUIRED'
  | 'ESTIMATE_REGION_POLICY_REFUSED'
  | 'ESTIMATE_WORK_CATEGORY_CONFLICT';

export class UniversalV1EstimateError extends Error {
  constructor(
    readonly code: UniversalV1EstimateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UniversalV1EstimateError';
  }
}

export interface UniversalV1EstimateRepository {
  issueProviderEstimateInvitation(
    command: IssueUniversalV1ProviderEstimateInvitation,
  ): Promise<IssuedUniversalV1ProviderEstimateInvitation>;

  submitProviderEstimate(
    command: SubmitUniversalV1ProviderEstimate,
    requestSha256: string,
  ): Promise<SubmittedUniversalV1ProviderEstimate>;

  acceptProviderEstimate(
    command: AcceptUniversalV1ProviderEstimate,
    requestSha256: string,
  ): Promise<AcceptedUniversalV1ProviderEstimate>;
}

/**
 * Provider-neutral application boundary for the estimate lane. It records no
 * Financial Security Event, processor operation, escrow, or assignment. The
 * PostgreSQL repository is responsible for one serializable transaction per
 * command and for exact replay/conflict enforcement against immutable facts.
 */
export class UniversalV1EstimateService {
  constructor(private readonly repository: UniversalV1EstimateRepository) {}

  async issueProviderEstimateInvitation(
    rawCommand: IssueUniversalV1ProviderEstimateInvitation,
  ): Promise<IssuedUniversalV1ProviderEstimateInvitation> {
    const command = IssueUniversalV1ProviderEstimateInvitationSchema.parse(rawCommand);
    return this.repository.issueProviderEstimateInvitation(command);
  }

  async submitProviderEstimate(
    rawCommand: SubmitUniversalV1ProviderEstimate,
  ): Promise<SubmittedUniversalV1ProviderEstimate> {
    const command = SubmitUniversalV1ProviderEstimateSchema.parse(rawCommand);
    return this.repository.submitProviderEstimate(
      command,
      universalV1EstimateSubmissionRequestSha256(command),
    );
  }

  async acceptProviderEstimate(
    rawCommand: AcceptUniversalV1ProviderEstimate,
  ): Promise<AcceptedUniversalV1ProviderEstimate> {
    const command = AcceptUniversalV1ProviderEstimateSchema.parse(rawCommand);
    return this.repository.acceptProviderEstimate(
      command,
      universalV1EstimateAcceptanceRequestSha256(command),
    );
  }
}
