/**
 * AI Memory Service
 *
 * Maintains persistent memory of AI conversations.
 * Extracts structured facts using AI, not regex.
 * Generates compressed summaries for long-term memory.
 *
 * "The more you talk to it, the smarter it feels."
 */
export interface ConversationTurn {
    id: string;
    role: 'user' | 'ai';
    content: string;
    timestamp: Date;
}
export interface ExtractedFact {
    category: 'goal' | 'constraint' | 'preference' | 'complaint' | 'context';
    key: string;
    value: string;
    confidence: number;
    source: string;
    extractedAt: Date;
}
export interface AIMemory {
    userId: string;
    conversationHistory: ConversationTurn[];
    extractedFacts: ExtractedFact[];
    summary: string;
    totalTurns: number;
    lastConversationAt: Date;
    summaryGeneratedAt: Date;
}
declare class AIMemoryServiceClass {
    /**
     * Get or create memory for a user
     */
    getMemory(userId: string): AIMemory;
    /**
     * Initialize empty memory
     */
    private initializeMemory;
    /**
     * Add a conversation turn and extract facts
     */
    addConversation(userId: string, userMessage: string, aiResponse?: string): Promise<{
        factsExtracted: number;
        newSummary: boolean;
    }>;
    /**
     * Extract facts from a message using AI
     */
    extractFactsFromMessage(userId: string, message: string): Promise<number>;
    /**
     * Regenerate the compressed summary
     */
    regenerateSummary(userId: string): Promise<string>;
    /**
     * Get the summary for AI context
     */
    getSummary(userId: string): string;
    /**
     * Get recent conversation turns
     */
    getRecentConversation(userId: string, limit?: number): ConversationTurn[];
    /**
     * Get extracted facts
     */
    getFacts(userId: string): ExtractedFact[];
    /**
     * Get structured data from facts for brain update
     */
    getStructuredData(userId: string): {
        goals: Record<string, any>;
        constraints: Record<string, any>;
        preferences: Record<string, any>;
    };
    /**
     * Get memory stats
     */
    getStats(userId: string): {
        totalTurns: number;
        totalFacts: number;
        hasSummary: boolean;
        lastActive: Date;
    };
    /**
     * Clear memory (for testing)
     */
    clearMemory(userId: string): void;
}
export declare const AIMemoryService: AIMemoryServiceClass;
export {};
//# sourceMappingURL=AIMemoryService.d.ts.map