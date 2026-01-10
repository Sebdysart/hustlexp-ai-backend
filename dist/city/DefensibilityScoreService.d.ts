/**
 * DEFENSIBILITY SCORE SERVICE (Phase 16 - Component 4)
 *
 * Purpose: Calculate how hard HustleXP is to displace in each zone.
 *
 * A zone is "locked" when:
 * - High repeat user rate
 * - Low time-to-fill
 * - Strong trust scores
 * - Stable dispute rate
 * - Dense task network
 *
 * CONSTRAINTS:
 * - READ-ONLY: Analysis only
 * - NO KERNEL: Financial layer frozen
 * - ADVISORY: Powers strategy, not execution
 */
export type DefensibilityClass = 'fragile' | 'contestable' | 'dominant' | 'locked';
export interface ZoneDefensibility {
    zone: string;
    taskDensity: number;
    repeatUserRate: number;
    timeToFillHours: number;
    trustScore: number;
    disputeStability: number;
    defensibilityScore: number;
    classification: DefensibilityClass;
    vulnerabilities: string[];
    moatStrengths: string[];
    scoreChange30d: number;
    trend: 'strengthening' | 'stable' | 'weakening';
}
export interface CityDefensibility {
    id: string;
    city: string;
    generatedAt: Date;
    zones: ZoneDefensibility[];
    cityScore: number;
    cityClassification: DefensibilityClass;
    summary: {
        lockedZones: string[];
        dominantZones: string[];
        contestableZones: string[];
        fragileZones: string[];
    };
    competitivePosition: {
        overallMoat: string;
        primaryVulnerability: string;
        defensePriority: string[];
    };
}
export declare class DefensibilityScoreService {
    /**
     * GET CITY DEFENSIBILITY
     */
    static getCityDefensibility(city: string): Promise<CityDefensibility>;
    /**
     * GET ZONE DEFENSIBILITY
     */
    static getZoneDefensibility(zone: string): Promise<ZoneDefensibility>;
    /**
     * GET COMPETITIVE THREATS
     */
    static getCompetitiveThreats(city: string): Promise<{
        zone: string;
        threatLevel: 'high' | 'medium' | 'low';
        reason: string;
        recommendedAction: string;
    }[]>;
    private static calculateZoneDefensibility;
    private static classifyScore;
    private static identifyVulnerabilities;
    private static identifyStrengths;
    private static assessCompetitivePosition;
    private static persistSnapshot;
}
//# sourceMappingURL=DefensibilityScoreService.d.ts.map