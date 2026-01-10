/**
 * SmartMatch AI Re-Ranking Service
 *
 * Takes top candidates from DB matching and uses AI to re-rank
 * based on deeper compatibility signals.
 */
import { serviceLogger } from '../utils/logger.js';
import { routedGenerate } from '../ai/router.js';
// ============================================
// SmartMatch AI Service
// ============================================
class SmartMatchAIServiceClass {
    /**
     * Re-rank candidates using AI
     */
    async reRankCandidates(task, candidates, limit = 5) {
        // If few candidates, skip AI and use DB scores
        if (candidates.length <= 3) {
            return {
                taskId: task.taskId,
                candidates: candidates.sort((a, b) => b.dbMatchScore - a.dbMatchScore),
                matchedAt: new Date(),
                aiReRanked: false,
                topPick: candidates[0],
                alternates: candidates.slice(1),
            };
        }
        try {
            // Prepare candidate summaries for AI
            const candidateSummaries = candidates.slice(0, 20).map((c, i) => ({
                id: i,
                name: c.displayName,
                rating: c.rating,
                level: c.level,
                completedTasks: c.completedTasks,
                categoryExp: c.categoryExperience,
                distance: c.distanceKm,
                skills: c.skills.slice(0, 5),
                availableNow: c.availableNow,
                responseTime: c.avgResponseTime,
                repeatClient: c.repeatClient || false,
            }));
            const result = await routedGenerate('matching_logic', {
                system: `You are a match-making AI for a gig marketplace.
Rank hustler candidates for a task based on fit, availability, and likelihood of success.

Consider:
1. Category experience (most important)
2. Rating and completion history
3. Distance (closer is better)
4. Response time
5. Repeat client relationship (big bonus)
6. Current availability

Return JSON:
{
    "rankings": [
        { "id": <candidate_index>, "score": <0-100>, "reason": "<brief why>" }
    ],
    "topPickReason": "<why #1 is best>",
    "alternateNote": "<note about alternatives>"
}

Only include top ${limit} candidates in rankings.`,
                messages: [{
                        role: 'user',
                        content: `Task: "${task.title}"
Category: ${task.category}
Location: ${task.location}
Price: $${task.price}
Urgency: ${task.urgency}
${task.specialRequirements?.length ? `Requirements: ${task.specialRequirements.join(', ')}` : ''}

Candidates:
${JSON.stringify(candidateSummaries, null, 2)}`,
                    }],
                json: true,
                maxTokens: 512,
            });
            const aiResult = JSON.parse(result.content);
            const rankings = aiResult.rankings || [];
            // Apply AI scores to candidates
            for (const ranking of rankings) {
                const candidate = candidates[ranking.id];
                if (candidate) {
                    candidate.aiMatchScore = ranking.score;
                    candidate.matchReason = ranking.reason;
                    // Weighted combination: 40% DB, 60% AI
                    candidate.finalScore = Math.round(candidate.dbMatchScore * 0.4 + ranking.score * 0.6);
                }
            }
            // Sort by final score
            const rankedCandidates = candidates
                .filter(c => c.finalScore !== undefined)
                .sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0))
                .slice(0, limit);
            // Add unranked candidates at the end
            const unranked = candidates
                .filter(c => c.finalScore === undefined)
                .sort((a, b) => b.dbMatchScore - a.dbMatchScore);
            if (rankedCandidates.length < limit) {
                rankedCandidates.push(...unranked.slice(0, limit - rankedCandidates.length));
            }
            const topPick = rankedCandidates[0];
            if (topPick) {
                topPick.aiNotes = aiResult.topPickReason;
            }
            serviceLogger.info({
                taskId: task.taskId,
                candidatesRanked: rankedCandidates.length,
                topPickScore: topPick?.finalScore,
            }, 'SmartMatch AI re-ranking complete');
            return {
                taskId: task.taskId,
                candidates: rankedCandidates,
                matchedAt: new Date(),
                aiReRanked: true,
                topPick,
                alternates: rankedCandidates.slice(1),
            };
        }
        catch (error) {
            serviceLogger.error({ error, taskId: task.taskId }, 'SmartMatch AI failed, using DB scores');
            // Fallback to DB ordering
            const sorted = candidates.sort((a, b) => b.dbMatchScore - a.dbMatchScore).slice(0, limit);
            return {
                taskId: task.taskId,
                candidates: sorted,
                matchedAt: new Date(),
                aiReRanked: false,
                topPick: sorted[0],
                alternates: sorted.slice(1),
            };
        }
    }
    /**
     * Get match explanation for a specific pairing
     */
    async explainMatch(task, candidate) {
        try {
            const result = await routedGenerate('small_aux', {
                system: `Explain why a hustler is a good match for a task.
Be concise and positive. Focus on strengths.

Return JSON:
{
    "explanation": "<1-2 sentence explanation>",
    "strengths": ["<strength1>", "<strength2>"],
    "considerations": ["<any note>"]
}`,
                messages: [{
                        role: 'user',
                        content: `Task: ${task.title} (${task.category}) - $${task.price}
Hustler: ${candidate.displayName}
- Rating: ${candidate.rating}/5
- Level: ${candidate.level}
- ${candidate.categoryExperience} tasks in ${task.category}
- ${candidate.distanceKm}km away
- ${candidate.availableNow ? 'Available now' : 'May be busy'}`,
                    }],
                json: true,
                maxTokens: 256,
            });
            return JSON.parse(result.content);
        }
        catch (error) {
            return {
                explanation: `${candidate.displayName} has ${candidate.categoryExperience} ${task.category} tasks completed with a ${candidate.rating}/5 rating.`,
                strengths: [
                    `${candidate.rating}/5 rating`,
                    `Level ${candidate.level} hustler`,
                ],
                considerations: [],
            };
        }
    }
    /**
     * Quick score without full re-ranking (for real-time UIs)
     */
    quickScore(task, candidate) {
        let score = 50; // Base score
        // Category experience (up to +25)
        score += Math.min(25, candidate.categoryExperience * 2.5);
        // Rating bonus (up to +15)
        score += (candidate.rating - 3) * 7.5;
        // Distance penalty (up to -15)
        if (candidate.distanceKm > 20) {
            score -= 15;
        }
        else if (candidate.distanceKm > 10) {
            score -= 8;
        }
        else if (candidate.distanceKm > 5) {
            score -= 3;
        }
        // Availability bonus
        if (candidate.availableNow) {
            score += 10;
        }
        // Repeat client bonus
        if (candidate.repeatClient) {
            score += 15;
        }
        // Level bonus (up to +10)
        score += Math.min(10, candidate.level);
        return Math.max(0, Math.min(100, Math.round(score)));
    }
    /**
     * Simulate candidates for testing
     */
    generateTestCandidates(count = 10) {
        const names = ['Alex', 'Jordan', 'Sam', 'Casey', 'Morgan', 'Taylor', 'Riley', 'Jamie', 'Drew', 'Quinn'];
        const categories = ['cleaning', 'moving', 'handyman', 'delivery', 'pet_care'];
        return Array.from({ length: count }, (_, i) => ({
            userId: `hustler_${i + 1}`,
            displayName: names[i % names.length],
            dbMatchScore: 60 + Math.floor(Math.random() * 40),
            skills: ['general', categories[i % categories.length]],
            categories: [categories[i % categories.length]],
            rating: 4 + Math.random(),
            completedTasks: 10 + Math.floor(Math.random() * 90),
            level: 1 + Math.floor(Math.random() * 8),
            distanceKm: 1 + Math.random() * 15,
            availableNow: Math.random() > 0.3,
            categoryExperience: 5 + Math.floor(Math.random() * 30),
            avgResponseTime: Math.random() > 0.5 ? '< 1 hour' : '< 4 hours',
        }));
    }
}
export const SmartMatchAIService = new SmartMatchAIServiceClass();
//# sourceMappingURL=SmartMatchAIService.js.map