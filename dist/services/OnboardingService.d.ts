export type UserRole = 'hustler' | 'client';
export type AnimationType = 'confetti' | 'glow' | 'shake' | 'pulse' | 'sparkle' | 'levelUp' | 'badge' | 'streak';
export type VerificationLevel = 0 | 1 | 2 | 3 | 4 | 5;
export interface OnboardingSession {
    sessionId: string;
    userId: string;
    role: UserRole | null;
    step: number;
    totalSteps: number;
    answers: Record<string, string>;
    skippedQuestions: string[];
    profile: Record<string, unknown> | null;
    xpEarned: number;
    badges: string[];
    referralCode: string | null;
    referredBy: string | null;
    verificationLevel: VerificationLevel;
    createdAt: Date;
    updatedAt: Date;
}
export interface OnboardingResponse {
    sessionId: string;
    step: number;
    totalSteps: number;
    xpEarned: number;
    xpAwarded: number;
    badges: string[];
    badgeAwarded?: string;
    animations: AnimationType[];
    data: Record<string, unknown>;
    nextAction: string;
    canSkip: boolean;
    canResume: boolean;
}
declare class OnboardingServiceClass {
    /**
     * Start or resume onboarding session
     */
    startOnboarding(userId: string, referralCode?: string): Promise<OnboardingResponse>;
    /**
     * Resume an existing session
     */
    private resumeOnboarding;
    /**
     * User chooses their role (hustler or client)
     */
    chooseRole(sessionId: string, role: UserRole): Promise<OnboardingResponse>;
    /**
     * Process an interview answer (or skip)
     */
    answerQuestion(sessionId: string, questionKey: string, answer: string, skip?: boolean): Promise<OnboardingResponse>;
    /**
     * Get question data for current step
     */
    private getQuestionData;
    /**
     * Complete onboarding - build profile, create quest, show money path
     */
    private completeOnboarding;
    /**
     * Build profile from interview answers using AI
     */
    private buildProfile;
    /**
     * Generate money path (earnings projection) for hustlers
     */
    private generateMoneyPath;
    /**
     * Generate first quest for new user
     */
    private generateFirstQuest;
    /**
     * Get instant task recommendations for new hustler
     */
    private getInstantRecommendations;
    /**
     * Generate a unique referral code for user
     */
    private generateReferralCode;
    /**
     * Get referral stats for a user
     */
    getReferralStats(userId: string): {
        code: string;
        uses: number;
        xpEarned: number;
    } | null;
    /**
     * Calculate verification level based on XP
     */
    private calculateVerificationLevel;
    /**
     * Get XP needed for next verification level
     */
    private getNextVerificationXP;
    /**
     * Get verification level info
     */
    getVerificationInfo(level: VerificationLevel): {
        name: string;
        xpRequired: number;
        perks: string[];
    };
    /**
     * Get onboarding status for a user
     * This allows the frontend to determine if a user needs to go through onboarding
     */
    getOnboardingStatus(userId: string): {
        userId: string;
        onboardingComplete: boolean;
        currentStep?: number;
        totalSteps?: number;
        role?: UserRole | null;
        message: string;
    };
    private saveSession;
    private getSession;
}
export declare const OnboardingService: OnboardingServiceClass;
export {};
//# sourceMappingURL=OnboardingService.d.ts.map