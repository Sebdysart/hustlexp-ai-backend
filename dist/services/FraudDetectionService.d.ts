/**
 * Fraud Detection Service v2
 *
 * Enterprise-grade fraud prevention for identity verification.
 *
 * Features:
 * - VoIP phone detection
 * - IP reputation scoring
 * - Device fingerprint correlation
 * - Multi-account detection
 * - Email domain reputation
 * - Velocity checks
 */
export interface FraudSignals {
    isVoip: boolean;
    isTempEmail: boolean;
    isHighRiskEmail: boolean;
    isVpnIp: boolean;
    isNewDevice: boolean;
    hasMultipleAccounts: boolean;
    velocityExceeded: boolean;
    deviceMismatch: boolean;
    countryMismatch: boolean;
}
export interface RiskAssessment {
    riskScore: number;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    signals: FraudSignals;
    recommendation: 'allow' | 'challenge' | 'block';
    reasons: string[];
}
export interface IdentityContext {
    userId: string;
    email: string;
    phone?: string;
    emailVerified: boolean;
    phoneVerified: boolean;
    emailVerifiedAt?: Date;
    phoneVerifiedAt?: Date;
    trustScore: number;
    riskLevel: 'low' | 'medium' | 'high';
    riskAssessment: RiskAssessment;
    verificationAge: number;
    isFullyVerified: boolean;
    deviceFingerprint?: string;
    countryCode?: string;
}
declare class FraudDetectionServiceClass {
    /**
     * Assess fraud risk for a verification attempt
     */
    assessRisk(userId: string, email: string, phone?: string, ip?: string, deviceFingerprint?: string): Promise<RiskAssessment>;
    /**
     * Get full identity context for AI onboarding
     */
    getIdentityContext(userId: string): Promise<IdentityContext | null>;
    /**
     * Update trust score based on behavior
     */
    updateTrustScore(userId: string, adjustment: number, reason: string): Promise<number>;
    /**
     * Record fraud signal for analysis
     */
    recordFraudSignal(userId: string, signalType: string, metadata: Record<string, any>): Promise<void>;
}
export declare const FraudDetectionService: FraudDetectionServiceClass;
export {};
//# sourceMappingURL=FraudDetectionService.d.ts.map