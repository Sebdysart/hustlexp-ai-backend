/**
 * Identity Verification Middleware
 *
 * Gates access to protected routes based on identity verification status.
 * Must be verified (email + phone) before accessing AI onboarding.
 */
import { FastifyRequest, FastifyReply } from 'fastify';
export declare function requireEmailVerified(request: FastifyRequest, reply: FastifyReply): Promise<void>;
export declare function requirePhoneVerified(request: FastifyRequest, reply: FastifyReply): Promise<void>;
export declare function requireIdentityVerified(request: FastifyRequest, reply: FastifyReply): Promise<void>;
export declare function requireOnboardingUnlocked(request: FastifyRequest, reply: FastifyReply): Promise<void>;
export declare function getIdentityContextForAI(userId: string): Promise<{
    isVerified: boolean;
    emailVerifiedAt?: Date;
    phoneVerifiedAt?: Date;
    trustScore: number;
    riskLevel: 'low' | 'medium' | 'high';
} | null>;
//# sourceMappingURL=identityGate.d.ts.map