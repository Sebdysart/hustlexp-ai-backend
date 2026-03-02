/* eslint-disable @typescript-eslint/no-unused-vars */
export enum PayoutDecision { ALLOW = "ALLOW", BLOCK = "BLOCK", ESCALATE = "ESCALATE" }
export interface AdminOverride { enabled: boolean; adminId: string; reason: string; }
export const PayoutEligibilityResolver = {
  resolve: async (_input?: Record<string, unknown>) => ({ decision: PayoutDecision.ALLOW }),
};
