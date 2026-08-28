import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { StripeConnectService } from './StripeConnectService.js';
import { WorkerSkillService } from './WorkerSkillService.js';
import { getPrivateIdentityVerificationStatus } from './PrivateIdentityVerificationService.js';
import { getCapabilityProfile } from './CapabilityProfileService.js';

export type HustlerOnboardingStepStatus =
  | 'COMPLETE'
  | 'PENDING'
  | 'BLOCKED'
  | 'NOT_STARTED';

export interface HustlerOnboardingStatus {
  userId: string;
  role: 'worker';
  onboardingComplete: boolean;
  canWork: boolean;
  blockers: string[];

  steps: {
    account: {
      status: HustlerOnboardingStepStatus;
    };
    phone: {
      status: HustlerOnboardingStepStatus;
    };
    identity: {
      status: HustlerOnboardingStepStatus;
      verified: boolean;
      environment: string | null;
    };
    payouts: {
      status: HustlerOnboardingStepStatus;
      onboardingComplete: boolean;
      payoutsEnabled: boolean;
    };
    skills: {
      status: HustlerOnboardingStepStatus;
      selectedCount: number;
      pendingVerification: number;
    };
    capability: {
      status: HustlerOnboardingStepStatus;
      riskClearance: string[];
      insuranceValid: boolean;
      backgroundCheckValid: boolean;
      verifiedTradeCount: number;
    };
  };
}

export async function getHustlerOnboardingStatus(
  userId: string,
): Promise<ServiceResult<HustlerOnboardingStatus>> {
  try {
    const userResult = await db.query<{
      id: string;
      default_mode: string;
      phone: string | null;
      is_minor: boolean;
      is_banned: boolean;
      account_status: string;
      onboarding_completed_at: Date | null;
    }>(
      `
      SELECT
        id,
        default_mode,
        phone,
        is_minor,
        is_banned,
        account_status,
        onboarding_completed_at
      FROM users
      WHERE id = $1
      `,
      [userId],
    );

    const user = userResult.rows[0];

    if (!user) {
      return {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'User not found',
        },
      };
    }

    if (user.default_mode !== 'worker') {
      return {
        success: false,
        error: {
          code: 'NOT_HUSTLER',
          message: 'User is not configured as a Hustler.',
        },
      };
    }

    const identityResult =
      await getPrivateIdentityVerificationStatus(userId);

    const stripeResult =
      await StripeConnectService.getOnboardingStatus(userId);

    const skillsResult =
      await WorkerSkillService.getWorkerSkills(userId);

    const capability =
      await getCapabilityProfile(userId);

    const blockers: string[] = [];

    const accountComplete =
      user.account_status === 'ACTIVE'
      && !user.is_banned
      && !user.is_minor;

    if (!accountComplete) {
      blockers.push('ACCOUNT_NOT_READY');
    }

    const phoneComplete =
      Boolean(user.phone && user.phone.trim());

    if (!phoneComplete) {
      blockers.push('PHONE_REQUIRED');
    }

    const identityComplete =
      identityResult.success
      && identityResult.data.verified
      && identityResult.data.environment === 'PRODUCTION';

    if (!identityComplete) {
      blockers.push('IDENTITY_VERIFICATION_REQUIRED');
    }

    const payoutsComplete =
      stripeResult.success
      && stripeResult.data.isOnboarded
      && stripeResult.data.payoutsEnabled;

    if (!payoutsComplete) {
      blockers.push('PAYOUT_ONBOARDING_REQUIRED');
    }

    const selectedSkillCount =
      skillsResult.success
        ? skillsResult.data.length
        : 0;

    if (selectedSkillCount === 0) {
      blockers.push('SKILL_REQUIRED');
    }

    const capabilityReady =
      capability.verifiedTrades.length > 0
      || selectedSkillCount > 0;

    if (!capabilityReady) {
      blockers.push('CAPABILITY_PROFILE_REQUIRED');
    }

    const canWork = blockers.length === 0;

    return {
      success: true,
      data: {
        userId,
        role: 'worker',
        onboardingComplete: user.onboarding_completed_at !== null,
        canWork,
        blockers,

        steps: {
          account: {
            status: accountComplete ? 'COMPLETE' : 'BLOCKED',
          },

          phone: {
            status: phoneComplete ? 'COMPLETE' : 'BLOCKED',
          },

          identity: {
            status: identityComplete
              ? 'COMPLETE'
              : identityResult.success && identityResult.data.status !== 'UNVERIFIED'
                ? 'PENDING'
                : 'NOT_STARTED',
            verified: identityResult.success
              ? identityResult.data.verified
              : false,
            environment: identityResult.success
              ? identityResult.data.environment
              : null,
          },

          payouts: {
            status: payoutsComplete
              ? 'COMPLETE'
              : stripeResult.success && stripeResult.data.accountId
                ? 'PENDING'
                : 'NOT_STARTED',
            onboardingComplete: stripeResult.success
              ? stripeResult.data.isOnboarded
              : false,
            payoutsEnabled: stripeResult.success
              ? stripeResult.data.payoutsEnabled
              : false,
          },

          skills: {
            status: selectedSkillCount > 0
              ? 'COMPLETE'
              : 'NOT_STARTED',
            selectedCount: selectedSkillCount,
            pendingVerification: skillsResult.success
              ? skillsResult.data.filter(
                  skill => skill.skill.gate_type === 'hard'
                    && !skill.verified,
                ).length
              : 0,
          },

          capability: {
            status: capabilityReady
              ? 'COMPLETE'
              : 'BLOCKED',
            riskClearance: capability.riskClearance,
            insuranceValid: capability.insuranceValid,
            backgroundCheckValid: capability.backgroundCheckValid,
            verifiedTradeCount: capability.verifiedTrades.length,
          },
        },
      },
    };
  } catch (error) {
    console.error('[HustlerOnboardingService]', error);

    return {
      success: false,
      error: {
        code: 'DB_ERROR',
        message: 'Unable to determine Hustler onboarding status.',
      },
    };
  }
}