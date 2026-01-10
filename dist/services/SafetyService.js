/**
 * Safety Service - Phase C
 *
 * Content moderation for:
 * - Task creation
 * - Proof submission
 * - Chat messages
 * - Profile content
 *
 * Uses AI (Groq fast check → GPT-4o deep check) for risk assessment
 */
import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
import { routedGenerate } from '../ai/router.js';
import { DisputeService } from './DisputeService.js';
// ============================================
// Risk Patterns (for fast local check)
// ============================================
const HIGH_RISK_PATTERNS = [
    // Contact outside platform
    /\b(venmo|cashapp|paypal|zelle|call me|text me|my number|whatsapp|telegram)\b/i,
    // Explicit
    /\b(xxx|porn|nude|escort|sex)\b/i,
    // Drugs
    /\b(weed|cocaine|heroin|meth|drugs|420|dealer)\b/i,
    // Violence
    /\b(kill|murder|weapon|gun for sale|bomb)\b/i,
    // Scams
    /\b(wire transfer|western union|bitcoin payment|crypto only|gift card payment|cash only)\b/i,
];
const MEDIUM_RISK_PATTERNS = [
    // Suspicious pricing
    /\$\d{4,}/i, // Very high amounts
    /\bfree\s+money\b/i,
    /\b(no receipt|under the table)\b/i,
    // Personal info requests
    /\b(ssn|social security|bank account|credit card)\b/i,
    // Meeting strangers
    /\b(come to my house|home alone|parents gone)\b/i,
];
// Seattle-specific safety (home entry tasks)
const HOME_ENTRY_CATEGORIES = ['cleaning', 'handyman', 'moving'];
// ============================================
// In-memory store
// ============================================
const moderationLogs = [];
// ============================================
// Service Class
// ============================================
class SafetyServiceClass {
    // ============================================
    // Main Moderation Entry Point
    // ============================================
    /**
     * Moderate content before allowing action
     */
    async moderateContent(content, type, userId, taskId, options) {
        const startTime = Date.now();
        // 1. Fast local pattern check
        const localResult = this.localPatternCheck(content);
        if (localResult.riskScore >= 0.9) {
            // Critical - block immediately
            this.logModerationResult(localResult, content, type, userId, taskId, 'local');
            // Add strike for critical violations
            if (userId && localResult.severity === 'critical') {
                DisputeService.addStrike(userId, localResult.reason || localResult.label, 3, 'ai', { taskId });
            }
            return localResult;
        }
        if (options?.skipAI) {
            return localResult;
        }
        // 2. AI check for non-obvious cases
        try {
            const aiResult = await this.aiModerationCheck(content, type, localResult);
            this.logModerationResult(aiResult, content, type, userId, taskId, 'groq');
            // Add strike for high-risk AI detections
            if (userId && aiResult.severity === 'critical') {
                DisputeService.addStrike(userId, aiResult.reason || aiResult.label, 3, 'ai', { taskId });
            }
            else if (userId && aiResult.severity === 'warn' && aiResult.riskScore >= 0.7) {
                DisputeService.addStrike(userId, aiResult.reason || aiResult.label, 2, 'ai', { taskId });
            }
            serviceLogger.info({
                type,
                riskScore: aiResult.riskScore,
                label: aiResult.label,
                action: aiResult.action,
                latencyMs: Date.now() - startTime,
            }, 'Moderation complete');
            return aiResult;
        }
        catch (error) {
            serviceLogger.error({ error }, 'AI moderation failed, using local result');
            return localResult;
        }
    }
    /**
     * Quick local pattern-based check
     */
    localPatternCheck(content) {
        // Check high-risk patterns
        for (const pattern of HIGH_RISK_PATTERNS) {
            if (pattern.test(content)) {
                return {
                    allowed: false,
                    riskScore: 0.95,
                    label: this.getLabelFromPattern(pattern),
                    severity: 'critical',
                    action: 'auto_blocked',
                    reason: `Content matched high-risk pattern`,
                };
            }
        }
        // Check medium-risk patterns
        for (const pattern of MEDIUM_RISK_PATTERNS) {
            if (pattern.test(content)) {
                return {
                    allowed: true, // Allow but flag
                    riskScore: 0.6,
                    label: 'policy_violation',
                    severity: 'warn',
                    action: 'auto_flagged',
                    reason: `Content matched medium-risk pattern`,
                };
            }
        }
        // Safe
        return {
            allowed: true,
            riskScore: 0.1,
            label: 'safe',
            severity: 'info',
            action: 'none',
        };
    }
    /**
     * Get risk label from pattern match
     */
    getLabelFromPattern(pattern) {
        const patternStr = pattern.source.toLowerCase();
        if (patternStr.includes('venmo') || patternStr.includes('whatsapp')) {
            return 'contact_outside_platform';
        }
        if (patternStr.includes('xxx') || patternStr.includes('escort')) {
            return 'explicit_content';
        }
        if (patternStr.includes('weed') || patternStr.includes('cocaine')) {
            return 'illegal_activity';
        }
        if (patternStr.includes('kill') || patternStr.includes('weapon')) {
            return 'illegal_activity';
        }
        if (patternStr.includes('wire transfer') || patternStr.includes('gift card')) {
            return 'possible_scam';
        }
        return 'policy_violation';
    }
    /**
     * AI-powered moderation check (Groq for speed)
     */
    async aiModerationCheck(content, type, localResult) {
        const prompt = `You are a content safety moderator for HustleXP, a gig marketplace in Seattle.

Analyze this ${type} content and rate its safety:

Content: "${content.slice(0, 500)}"

Respond in JSON format:
{
  "riskScore": <0.0 to 1.0, where 1.0 is most dangerous>,
  "label": <one of: "safe", "possible_scam", "harassment", "policy_violation", "illegal_activity", "hate_speech", "explicit_content", "spam", "contact_outside_platform">,
  "reason": <brief explanation if riskScore > 0.3>
}

Consider these as HIGH RISK (0.8+):
- Attempts to move payment off-platform
- Illegal services or items
- Exploitation or harassment
- Threats or violence

Consider these as MEDIUM RISK (0.5-0.7):
- Suspicious pricing
- Requests for personal info
- Meeting at private residences without proper context

Be strict about safety for this Seattle beta launch.`;
        try {
            const result = await routedGenerate('safety', {
                system: 'You are a content safety moderator. Always respond with valid JSON.',
                messages: [{ role: 'user', content: prompt }],
            });
            // Parse JSON from response content
            const responseText = result.content || '';
            const parsed = JSON.parse(responseText);
            const riskScore = Math.max(parsed.riskScore || 0, localResult.riskScore);
            const isCritical = riskScore >= 0.8;
            const isWarning = riskScore >= 0.5;
            return {
                allowed: riskScore < 0.8,
                riskScore,
                label: parsed.label || localResult.label,
                severity: isCritical ? 'critical' : isWarning ? 'warn' : 'info',
                action: isCritical ? 'auto_blocked' : isWarning ? 'auto_flagged' : 'none',
                reason: parsed.reason,
            };
        }
        catch (error) {
            // Fallback to local result
            return localResult;
        }
    }
    /**
     * Log moderation result
     */
    logModerationResult(result, content, type, userId, taskId, model = 'local') {
        const log = {
            id: uuidv4(),
            userId,
            taskId,
            type,
            severity: result.severity,
            label: result.label,
            rawInputSnippet: content.slice(0, 200),
            aiModelUsed: model,
            aiScore: result.riskScore,
            actionTaken: result.action,
            createdAt: new Date(),
        };
        moderationLogs.push(log);
        // Keep only last 10000 logs in memory
        if (moderationLogs.length > 10000) {
            moderationLogs.shift();
        }
    }
    // ============================================
    // Specific Content Type Checks
    // ============================================
    /**
     * Moderate task creation
     */
    async moderateTaskCreation(title, description, category, userId) {
        const content = `${title}\n${description}`;
        // Check user suspension first
        const suspension = await DisputeService.isUserSuspended(userId);
        if (suspension.suspended) {
            return {
                allowed: false,
                riskScore: 1.0,
                label: 'policy_violation',
                severity: 'critical',
                action: 'auto_blocked',
                reason: `User is suspended: ${suspension.reason}`,
            };
        }
        // Extra scrutiny for home entry tasks
        if (HOME_ENTRY_CATEGORIES.includes(category)) {
            // Could add extra validation here
            serviceLogger.debug({ category }, 'Home entry task - extra scrutiny');
        }
        return this.moderateContent(content, 'task_creation', userId);
    }
    /**
     * Moderate proof submission caption
     */
    async moderateProof(caption, hustlerId, taskId) {
        if (!caption || caption.length < 5) {
            return {
                allowed: true,
                riskScore: 0,
                label: 'safe',
                severity: 'info',
                action: 'none',
            };
        }
        return this.moderateContent(caption, 'proof', hustlerId, taskId);
    }
    /**
     * Moderate chat message (stub for future)
     */
    async moderateChat(message, userId, taskId) {
        return this.moderateContent(message, 'chat', userId, taskId);
    }
    /**
     * Moderate profile content
     */
    async moderateProfile(bio, userId) {
        return this.moderateContent(bio, 'profile', userId);
    }
    // ============================================
    // Queries
    // ============================================
    /**
     * Get moderation logs with filters
     */
    getModerationLogs(filters) {
        let result = [...moderationLogs];
        if (filters?.userId) {
            result = result.filter(l => l.userId === filters.userId);
        }
        if (filters?.taskId) {
            result = result.filter(l => l.taskId === filters.taskId);
        }
        if (filters?.type) {
            result = result.filter(l => l.type === filters.type);
        }
        if (filters?.severity) {
            result = result.filter(l => l.severity === filters.severity);
        }
        result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (filters?.limit) {
            result = result.slice(0, filters.limit);
        }
        return result;
    }
    /**
     * Get moderation stats
     */
    getStats() {
        const byAction = moderationLogs.reduce((acc, l) => {
            acc[l.actionTaken] = (acc[l.actionTaken] || 0) + 1;
            return acc;
        }, {});
        const byType = moderationLogs.reduce((acc, l) => {
            acc[l.type] = (acc[l.type] || 0) + 1;
            return acc;
        }, {});
        const bySeverity = moderationLogs.reduce((acc, l) => {
            acc[l.severity] = (acc[l.severity] || 0) + 1;
            return acc;
        }, {});
        return {
            total: moderationLogs.length,
            blocked: byAction['auto_blocked'] || 0,
            flagged: byAction['auto_flagged'] || 0,
            byType,
            bySeverity,
        };
    }
}
export const SafetyService = new SafetyServiceClass();
//# sourceMappingURL=SafetyService.js.map