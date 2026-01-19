/**
 * SmartMatch AI Re-Ranking Service
 *
 * Takes top candidates from DB matching and uses AI to re-rank
 * based on deeper compatibility signals.
 */
import type { TaskCategory } from '../types/index.js';
export interface HustlerCandidate {
    userId: string;
    displayName: string;
    dbMatchScore: number;
    aiMatchScore?: number;
    finalScore?: number;
    skills: string[];
    categories: TaskCategory[];
    rating: number;
    completedTasks: number;
    level: number;
    distanceKm: number;
    availableNow: boolean;
    categoryExperience: number;
    repeatClient?: boolean;
    avgResponseTime: string;
    matchReason?: string;
    aiNotes?: string;
}
export interface SmartMatchResult {
    taskId: string;
    candidates: HustlerCandidate[];
    matchedAt: Date;
    aiReRanked: boolean;
    topPick?: HustlerCandidate;
    alternates: HustlerCandidate[];
}
export interface TaskMatchContext {
    taskId: string;
    title: string;
    description: string;
    category: TaskCategory;
    price: number;
    location: string;
    urgency: 'normal' | 'urgent' | 'asap';
    posterRating?: number;
    specialRequirements?: string[];
}
declare class SmartMatchAIServiceClass {
    /**
     * Re-rank candidates using AI
     */
    reRankCandidates(task: TaskMatchContext, candidates: HustlerCandidate[], limit?: number): Promise<SmartMatchResult>;
    /**
     * Get match explanation for a specific pairing
     */
    explainMatch(task: TaskMatchContext, candidate: HustlerCandidate): Promise<{
        explanation: string;
        strengths: string[];
        considerations: string[];
    }>;
    /**
     * Quick score without full re-ranking (for real-time UIs)
     */
    quickScore(task: TaskMatchContext, candidate: HustlerCandidate): number;
    /**
     * Simulate candidates for testing
     */
    generateTestCandidates(count?: number): HustlerCandidate[];
}
export declare const SmartMatchAIService: SmartMatchAIServiceClass;
export {};
//# sourceMappingURL=SmartMatchAIService.d.ts.map