/**
 * ZONE TAKEOVER ENGINE (Phase 17 - Component 5)
 *
 * Purpose: Declare when a zone crosses winner-take-most threshold.
 *
 * Takeover criteria:
 * - ≥65% task share
 * - ≥80% repeat usage
 * - ≥30% faster fill time
 * - ≥2× trust velocity vs city average
 *
 * This engine answers: "Have we won this zone?"
 *
 * CONSTRAINTS:
 * - READ-ONLY: Declaration only
 * - NO KERNEL: Financial layer frozen
 * - ADVISORY: Strategic intelligence
 */
export type TakeoverStatus = 'contested' | 'tipping' | 'captured';
export interface ZoneTakeoverState {
    id: string;
    zone: string;
    generatedAt: Date;
    status: TakeoverStatus;
    moatDepth: number;
    defensePriority: 'low' | 'medium' | 'high' | 'critical';
    criteria: {
        taskSharePct: number;
        repeatUsagePct: number;
        fillTimeAdvantagePct: number;
        trustVelocityMultiple: number;
    };
    criteriaStatus: {
        taskShareMet: boolean;
        repeatUsageMet: boolean;
        fillTimeAdvantageMet: boolean;
        trustVelocityMet: boolean;
        totalMet: number;
    };
    context: {
        timeSinceTipping?: string;
        projectedCaptureDate?: string;
        threatLevel: string;
        competitorPresence: string;
    };
    recommendations: string[];
}
export interface CityTakeoverSummary {
    city: string;
    generatedAt: Date;
    capturedZones: string[];
    tippingZones: string[];
    contestedZones: string[];
    cityDominance: {
        overallStatus: string;
        avgMoatDepth: number;
        totalCriteriaMet: number;
        projectedFullCapture: string;
    };
    priorities: {
        defend: string[];
        accelerate: string[];
        contest: string[];
    };
}
export declare class ZoneTakeoverEngine {
    /**
     * GET ZONE TAKEOVER STATE
     */
    static getZoneState(zone: string): Promise<ZoneTakeoverState>;
    /**
     * GET CITY TAKEOVER SUMMARY
     */
    static getCityTakeoverSummary(city: string): Promise<CityTakeoverSummary>;
    /**
     * CHECK IF ZONE IS CAPTURED
     */
    static isZoneCaptured(zone: string): Promise<{
        captured: boolean;
        status: TakeoverStatus;
        moatDepth: number;
        missingCriteria: string[];
    }>;
    private static calculateCriteria;
    private static evaluateCriteria;
    private static determineStatus;
    private static calculateMoatDepth;
    private static determineDefensePriority;
    private static buildContext;
    private static generateRecommendations;
    private static getCityZones;
    private static determineOverallStatus;
    private static projectFullCapture;
    private static determinePriorities;
    private static persistState;
}
//# sourceMappingURL=ZoneTakeoverEngine.d.ts.map