import type { BusinessPricingMode } from './BusinessOperationsPolicy.js';

export interface BusinessBudgetPolicySummary {
  id: string;
  locationId: string | null;
  serviceCategory: string;
  perTaskCapCents: number;
  monthlyCapCents: number;
  autoApproveLimitCents: number;
  poRequired: boolean;
  costCenterRequired: boolean;
  revision: number;
}

export interface BusinessApprovalSummary {
  id: string;
  canonicalTaskId: string | null;
  requesterName: string;
  locationId: string | null;
  locationName: string | null;
  serviceCategory: string;
  amountCents: number;
  poNumber: string | null;
  costCenter: string | null;
  status: 'AUTO_APPROVED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'BLOCKED' | 'CANCELLED';
  blockers: string[];
  createdAt: string;
}

export interface BusinessServiceProfileSummary {
  id: string;
  serviceCode: string;
  serviceName: string;
  serviceDescription: string;
  serviceExclusions: string[];
  bookingQuestions: string[];
  coveragePostalCodes: string[];
  maximumTravelMiles: number;
  weeklyCapacitySlots: number;
  blackoutDates: string[];
  pricingMode: BusinessPricingMode;
  corridorMinimumCents: number | null;
  corridorMaximumCents: number | null;
  responseMode: 'INDIVIDUAL_OFFERS' | 'ROUTE_BUNDLES' | 'RECURRING_CONTRACTS';
  proofChecklist: string[];
  credentialRequirements: string[];
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'RETIRED';
  assignedCrewCount: number;
  lastActivationBlockers: string[];
}
