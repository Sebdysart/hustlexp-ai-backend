import { db } from '../db.js';
import type { Context } from '../trpc-context.js';
import { expressUniversalV1TaskInterest } from './UniversalV1TaskOpportunityInterestCommand.js';
import type {
  BrowseUniversalV1TaskOpportunitiesInput,
  ExpressUniversalV1TaskInterestInput,
  GetUniversalV1TaskInterestJourneyInput,
  ListUniversalV1TaskInterestsForOpsInput,
  ListUniversalV1TaskInterestsInput,
  OpportunityDatabase,
} from './UniversalV1TaskOpportunityModel.js';
import {
  browseUniversalV1TaskOpportunities,
  getMyPreEstimateJourneyState,
  listMyUniversalV1TaskInterests,
  listUniversalV1TaskInterestsForOps,
} from './UniversalV1TaskOpportunityReads.js';

export {
  universalV1TaskOpportunityAuthority,
  universalV1TaskOpportunityPreEstimateJourneyAuthority,
  universalV1TaskOpportunityProviderClasses,
} from './UniversalV1TaskOpportunityModel.js';
export type {
  BrowseUniversalV1TaskOpportunitiesInput,
  ExpressUniversalV1TaskInterestInput,
  GetUniversalV1TaskInterestJourneyInput,
  ListUniversalV1TaskInterestsForOpsInput,
  ListUniversalV1TaskInterestsInput,
  UniversalV1TaskOpportunityProviderClass,
  UniversalV1TaskOpportunityProviderSelection,
} from './UniversalV1TaskOpportunityModel.js';

export class UniversalV1TaskOpportunityService {
  constructor(private readonly database: OpportunityDatabase = db) {}

  async browse(context: Context, input: BrowseUniversalV1TaskOpportunitiesInput) {
    return browseUniversalV1TaskOpportunities(this.database, context, input);
  }

  async expressInterest(context: Context, input: ExpressUniversalV1TaskInterestInput) {
    return expressUniversalV1TaskInterest(this.database, context, input);
  }

  async getMyPreEstimateJourneyState(
    context: Context,
    input: GetUniversalV1TaskInterestJourneyInput
  ) {
    return getMyPreEstimateJourneyState(this.database, context, input);
  }

  async listMine(context: Context, input: ListUniversalV1TaskInterestsInput) {
    return listMyUniversalV1TaskInterests(this.database, context, input);
  }

  async listForOps(context: Context, input: ListUniversalV1TaskInterestsForOpsInput) {
    return listUniversalV1TaskInterestsForOps(this.database, context, input);
  }
}

export const universalV1TaskOpportunityService = new UniversalV1TaskOpportunityService();
