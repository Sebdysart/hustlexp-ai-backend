/**
 * AI Memory Service
 *
 * Maintains persistent memory of AI conversations.
 * Extracts structured facts using AI, not regex.
 * Generates compressed summaries for long-term memory.
 *
 * "The more you talk to it, the smarter it feels."
 */
import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
import { routedGenerate } from '../ai/router.js';
// ============================================
// Extraction Prompt
// ============================================
const EXTRACTION_PROMPT = `You are an AI that extracts structured information from user messages.

Extract any of the following if present:

GOALS (income targets, savings goals, work objectives):
- monthlyIncome: number
- weeklyIncome: number
- shortTermGoal: string ("pay_off_debt", "save_for_trip", "side_income", "full_time_gig")

CONSTRAINTS (limitations, availability):
- hasCar: boolean
- petFriendly: boolean
- canDoHeavyLifting: boolean
- maxDistanceKm: number
- availableTimes: array of "mornings" | "afternoons" | "evenings" | "nights" | "weekends"

PREFERENCES (task types, work style):
- preferredCategories: array of "delivery" | "cleaning" | "moving" | "pet_care" | "errands" | "handyman" | "yard_work"
- avoidedCategories: array of same
- prefersShortTasks: boolean
- prefersIndoorTasks: boolean

CONTEXT (situation, feelings):
- currentSituation: string (brief context about their life situation)

Return JSON only. If nothing is extractable, return {"facts": []}.

Example input: "I want to make $800/month doing cleaning jobs on weekends. I don't have a car."
Example output:
{
  "facts": [
    {"category": "goal", "key": "monthlyIncome", "value": 800, "confidence": 0.95},
    {"category": "preference", "key": "preferredCategories", "value": ["cleaning"], "confidence": 0.9},
    {"category": "constraint", "key": "availableTimes", "value": ["weekends"], "confidence": 0.9},
    {"category": "constraint", "key": "hasCar", "value": false, "confidence": 0.95}
  ]
}`;
const SUMMARY_PROMPT = `You are an AI that creates brief user summaries from facts.

Create a 1-2 sentence summary that captures:
1. What they want (goals)
2. What they can/can't do (constraints)
3. What they prefer (task preferences)

Be concise and conversational. Write as if describing the user to a friend.

Example facts:
- monthlyIncome: 1000
- hasCar: false
- preferredCategories: ["cleaning", "errands"]
- availableTimes: ["evenings"]

Example summary:
"Wants to hit $1k/month with evening cleaning and errand jobs. No car, so needs local tasks."`;
// ============================================
// In-Memory Storage
// ============================================
const memories = new Map();
const MAX_CONVERSATION_HISTORY = 50; // Keep last 50 turns
const MAX_FACTS = 100; // Keep last 100 facts
const SUMMARY_REGENERATE_THRESHOLD = 10; // Regenerate summary every 10 new facts
// ============================================
// AI Memory Service
// ============================================
class AIMemoryServiceClass {
    /**
     * Get or create memory for a user
     */
    getMemory(userId) {
        let memory = memories.get(userId);
        if (!memory) {
            memory = this.initializeMemory(userId);
            memories.set(userId, memory);
        }
        return memory;
    }
    /**
     * Initialize empty memory
     */
    initializeMemory(userId) {
        return {
            userId,
            conversationHistory: [],
            extractedFacts: [],
            summary: '',
            totalTurns: 0,
            lastConversationAt: new Date(),
            summaryGeneratedAt: new Date(),
        };
    }
    /**
     * Add a conversation turn and extract facts
     */
    async addConversation(userId, userMessage, aiResponse) {
        const memory = this.getMemory(userId);
        // Add user turn
        memory.conversationHistory.push({
            id: uuidv4(),
            role: 'user',
            content: userMessage,
            timestamp: new Date(),
        });
        memory.totalTurns++;
        // Add AI turn if provided
        if (aiResponse) {
            memory.conversationHistory.push({
                id: uuidv4(),
                role: 'ai',
                content: aiResponse,
                timestamp: new Date(),
            });
            memory.totalTurns++;
        }
        // Trim history if too long
        if (memory.conversationHistory.length > MAX_CONVERSATION_HISTORY) {
            memory.conversationHistory = memory.conversationHistory.slice(-MAX_CONVERSATION_HISTORY);
        }
        // Extract facts using AI
        const factsExtracted = await this.extractFactsFromMessage(userId, userMessage);
        // Check if we should regenerate summary
        let newSummary = false;
        const factsSinceSummary = memory.extractedFacts.filter(f => f.extractedAt > memory.summaryGeneratedAt).length;
        if (factsSinceSummary >= SUMMARY_REGENERATE_THRESHOLD) {
            await this.regenerateSummary(userId);
            newSummary = true;
        }
        memory.lastConversationAt = new Date();
        memories.set(userId, memory);
        return { factsExtracted, newSummary };
    }
    /**
     * Extract facts from a message using AI
     */
    async extractFactsFromMessage(userId, message) {
        const memory = this.getMemory(userId);
        try {
            // Use fast model for extraction
            const result = await routedGenerate('small_aux', {
                system: EXTRACTION_PROMPT,
                messages: [{ role: 'user', content: message }],
                json: true,
                maxTokens: 512,
                temperature: 0.1, // Low temperature for consistent extraction
            });
            const parsed = JSON.parse(result.content);
            const facts = (parsed.facts || []).map((f) => ({
                category: f.category,
                key: f.key,
                value: f.value,
                confidence: f.confidence || 0.8,
                source: message.slice(0, 100),
                extractedAt: new Date(),
            }));
            // Add new facts
            memory.extractedFacts.push(...facts);
            // Trim if too many
            if (memory.extractedFacts.length > MAX_FACTS) {
                memory.extractedFacts = memory.extractedFacts.slice(-MAX_FACTS);
            }
            serviceLogger.debug({
                userId,
                factsExtracted: facts.length,
                facts: facts.map(f => `${f.category}:${f.key}`),
            }, 'AI extracted facts from message');
            memories.set(userId, memory);
            return facts.length;
        }
        catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to extract facts from message');
            return 0;
        }
    }
    /**
     * Regenerate the compressed summary
     */
    async regenerateSummary(userId) {
        const memory = this.getMemory(userId);
        if (memory.extractedFacts.length === 0) {
            memory.summary = '';
            return '';
        }
        try {
            // Build facts list for prompt
            const factsText = memory.extractedFacts
                .slice(-20) // Use last 20 facts
                .map(f => `- ${f.key}: ${JSON.stringify(f.value)}`)
                .join('\n');
            const result = await routedGenerate('small_aux', {
                system: SUMMARY_PROMPT,
                messages: [{ role: 'user', content: `Facts:\n${factsText}\n\nGenerate a brief summary.` }],
                maxTokens: 200,
                temperature: 0.3,
            });
            memory.summary = result.content.trim();
            memory.summaryGeneratedAt = new Date();
            memories.set(userId, memory);
            serviceLogger.debug({ userId, summary: memory.summary }, 'Regenerated AI memory summary');
            return memory.summary;
        }
        catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to regenerate summary');
            return memory.summary;
        }
    }
    /**
     * Get the summary for AI context
     */
    getSummary(userId) {
        const memory = this.getMemory(userId);
        return memory.summary || 'New user, still learning their preferences.';
    }
    /**
     * Get recent conversation turns
     */
    getRecentConversation(userId, limit = 10) {
        const memory = this.getMemory(userId);
        return memory.conversationHistory.slice(-limit);
    }
    /**
     * Get extracted facts
     */
    getFacts(userId) {
        const memory = this.getMemory(userId);
        return memory.extractedFacts;
    }
    /**
     * Get structured data from facts for brain update
     */
    getStructuredData(userId) {
        const memory = this.getMemory(userId);
        const goals = {};
        const constraints = {};
        const preferences = {};
        for (const fact of memory.extractedFacts) {
            switch (fact.category) {
                case 'goal':
                    goals[fact.key] = fact.value;
                    break;
                case 'constraint':
                    constraints[fact.key] = fact.value;
                    break;
                case 'preference':
                    preferences[fact.key] = fact.value;
                    break;
            }
        }
        return { goals, constraints, preferences };
    }
    /**
     * Get memory stats
     */
    getStats(userId) {
        const memory = this.getMemory(userId);
        return {
            totalTurns: memory.totalTurns,
            totalFacts: memory.extractedFacts.length,
            hasSummary: !!memory.summary,
            lastActive: memory.lastConversationAt,
        };
    }
    /**
     * Clear memory (for testing)
     */
    clearMemory(userId) {
        memories.delete(userId);
        serviceLogger.info({ userId }, 'AI memory cleared');
    }
}
export const AIMemoryService = new AIMemoryServiceClass();
//# sourceMappingURL=AIMemoryService.js.map