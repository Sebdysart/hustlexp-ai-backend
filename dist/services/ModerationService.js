import { routedGenerate } from '../ai/router.js';
import { getModerationFastPrompt, getModerationDeepPrompt } from '../ai/prompts/moderation.js';
import { serviceLogger } from '../utils/logger.js';
class ModerationServiceClass {
    /**
     * Fast check using Qwen/Groq for initial filtering
     */
    async fastCheck(content) {
        try {
            const result = await routedGenerate('safety', {
                system: getModerationFastPrompt(),
                messages: [{ role: 'user', content: `Review this content: "${content}"` }],
                json: true,
                maxTokens: 256,
                temperature: 0.1,
            });
            const parsed = JSON.parse(result.content);
            serviceLogger.debug({
                contentLength: content.length,
                decision: parsed.decision
            }, 'Fast moderation check completed');
            return {
                decision: parsed.decision,
                reason: parsed.reason,
            };
        }
        catch (error) {
            serviceLogger.error({ error }, 'Fast moderation check failed');
            // On error, default to suspicious for safety
            return {
                decision: 'suspicious',
                reason: 'Moderation check failed, flagging for review',
            };
        }
    }
    /**
     * Deep check using GPT-4o for suspicious content
     */
    async deepCheck(content, context) {
        try {
            const result = await routedGenerate('safety', {
                system: getModerationDeepPrompt(),
                messages: [{
                        role: 'user',
                        content: `Review this content that was flagged as suspicious.

Content: "${content}"
${context ? `Context: ${context}` : ''}

Provide your final decision.`
                    }],
                json: true,
                maxTokens: 512,
                temperature: 0.1,
            });
            const parsed = JSON.parse(result.content);
            serviceLogger.info({
                decision: parsed.decision,
                confidence: parsed.confidence,
            }, 'Deep moderation check completed');
            return {
                decision: parsed.decision === 'allow' ? 'safe' :
                    parsed.decision === 'warn' ? 'suspicious' : 'blocked',
                reason: parsed.reason,
                userMessage: parsed.userMessage,
            };
        }
        catch (error) {
            serviceLogger.error({ error }, 'Deep moderation check failed');
            return {
                decision: 'suspicious',
                reason: 'Deep moderation check failed',
                userMessage: 'Your content is being reviewed. Please try again shortly.',
            };
        }
    }
    /**
     * Full moderation flow: fast check -> deep check if suspicious
     */
    async check(content, context) {
        // First, do fast check
        const fastResult = await this.fastCheck(content);
        // If safe or blocked, return immediately
        if (fastResult.decision !== 'suspicious') {
            return fastResult;
        }
        // If suspicious, escalate to deep check
        serviceLogger.info('Escalating to deep moderation check');
        return this.deepCheck(content, context);
    }
}
export const ModerationService = new ModerationServiceClass();
//# sourceMappingURL=ModerationService.js.map