/**
 * Trust & Pricing Enforcement Engine (TPEE) - Phase 1
 *
 * DETERMINISTIC LAYER ONLY - No AI (yet)
 *
 * This is the spinal cord of HustleXP's trust system.
 * Every task must pass through this gate before creation.
 *
 * Decision Order (NEVER DEVIATE):
 * 1. Schema validation
 * 2. Hard policy blocks (regex)
 * 3. Price floor enforcement
 * 4. Trust score gating
 * 5. Velocity limits
 * 6. AI escalation (Phase 2)
 */
import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
import { RulesService } from './RulesService.js';
import { FraudDetectionService } from './FraudDetectionService.js';
// ============================================
// High-Risk Patterns (Zero Tolerance)
// ============================================
const HIGH_RISK_PATTERNS = [
    // Off-platform payment attempts
    { pattern: /\b(venmo|cashapp|zelle|paypal|crypto|bitcoin|wire\s*transfer)\b/i, code: 'SCAM_RISK' },
    // Contact outside platform
    { pattern: /\b(call|text|dm|message)\s*me\s*(at|on|direct)/i, code: 'POLICY_VIOLATION' },
    { pattern: /\b(my|personal)\s*(phone|number|cell|email)/i, code: 'POLICY_VIOLATION' },
    // Reshipping scams
    { pattern: /\b(reship|remail|forward\s+package|receive\s+package)/i, code: 'SCAM_RISK' },
    // Account verification scams
    { pattern: /\b(verify\s+my\s+account|verify\s+identity|verification\s+code)/i, code: 'SCAM_RISK' },
    // Money laundering red flags
    { pattern: /\b(cash\s+advance|wire\s+money|money\s+order|western\s+union)/i, code: 'SCAM_RISK' },
    // Sexual/adult content
    { pattern: /\b(massage|escort|companionship|intimate|adult\s+services)/i, code: 'POLICY_VIOLATION' },
    // Illegal activities - use full word boundaries to avoid false positives (e.g., 'weeding')
    { pattern: /\b(drugs?|weed|marijuana|prescription|pills)\b/i, code: 'POLICY_VIOLATION' },
    { pattern: /\bfake\s+id\b/i, code: 'POLICY_VIOLATION' },
    // Prompt injection attempts - HOSTILE INTENT (distinct from policy violation)
    { pattern: /\b(ignore\s+previous|ignore\s+instructions|system\s+override|admin\s+mode)/i, code: 'PROMPT_INJECTION_ATTEMPT' },
    { pattern: /\b(pre-?approved|automatically\s+accept|bypass\s+review)/i, code: 'PROMPT_INJECTION_ATTEMPT' },
    // Additional injection patterns
    { pattern: /\b(role\s*:\s*admin|sudo|root\s+access|developer\s+mode)/i, code: 'PROMPT_INJECTION_ATTEMPT' },
    { pattern: /\[\s*(hidden|system|ignore)\s*:/i, code: 'PROMPT_INJECTION_ATTEMPT' },
];
// ============================================
// Allowed Categories (Seattle Beta)
// ============================================
const ALLOWED_CATEGORIES = [
    'delivery', 'moving', 'cleaning', 'handyman', 'errands',
    'pet_care', 'yard_work', 'tech_help', 'event_help', 'general', 'other'
];
// ============================================
// Thresholds (Configurable)
// ============================================
const TRUST_BLOCK_THRESHOLD = 20; // Below this = block with review
const TRUST_WARN_THRESHOLD = 40; // Below this = flag for review
const MAX_TASKS_PER_HOUR = 10; // Per poster
const MAX_TASKS_PER_DAY = 50; // Per poster
const velocityStore = new Map();
const tpeeLogStore = [];
// ============================================
// TPEE Service Class
// ============================================
class TPEEServiceClass {
    policyVersion = '1.0.0-seattle-beta';
    shadowMode = true; // Start in shadow mode
    // ============================================
    // Main Entry Point
    // ============================================
    async evaluateTask(input) {
        const evaluationId = uuidv4();
        const checksPassedList = [];
        const checksFailedList = [];
        serviceLogger.info({ evaluationId, posterId: input.poster_id }, 'TPEE evaluation started');
        // 1. Schema validation
        const schemaResult = this.validateSchema(input);
        if (schemaResult) {
            checksFailedList.push('schema');
            return this.logAndReturn(input, schemaResult, evaluationId, checksPassedList, checksFailedList);
        }
        checksPassedList.push('schema');
        // 2. Hard policy regex checks
        const regexResult = this.checkHighRiskPatterns(input);
        if (regexResult) {
            checksFailedList.push('regex_patterns');
            return this.logAndReturn(input, regexResult, evaluationId, checksPassedList, checksFailedList);
        }
        checksPassedList.push('regex_patterns');
        // 3. Category validation
        const categoryResult = this.validateCategory(input);
        if (categoryResult) {
            checksFailedList.push('category');
            return this.logAndReturn(input, categoryResult, evaluationId, checksPassedList, checksFailedList);
        }
        checksPassedList.push('category');
        // 4. Price floor enforcement
        const priceResult = this.checkPriceFloor(input);
        if (priceResult) {
            checksFailedList.push('price_floor');
            return this.logAndReturn(input, priceResult, evaluationId, checksPassedList, checksFailedList);
        }
        checksPassedList.push('price_floor');
        // 5. Trust score gating
        const trustResult = await this.checkTrustScore(input);
        if (trustResult) {
            checksFailedList.push('trust_score');
            return this.logAndReturn(input, trustResult, evaluationId, checksPassedList, checksFailedList);
        }
        checksPassedList.push('trust_score');
        // 6. Velocity limits
        const velocityResult = this.checkVelocity(input);
        if (velocityResult) {
            checksFailedList.push('velocity');
            return this.logAndReturn(input, velocityResult, evaluationId, checksPassedList, checksFailedList);
        }
        checksPassedList.push('velocity');
        // All deterministic checks passed
        const acceptResult = {
            decision: 'ACCEPT',
            recommended_price: { amount: null, currency: 'USD' },
            enforcement_reason_code: 'NONE',
            confidence_score: 0.85,
            human_review_required: false,
            model_version: 'deterministic-v1',
            policy_version: this.policyVersion,
            evaluation_id: evaluationId,
            evaluated_at: new Date(),
            checks_passed: checksPassedList,
            checks_failed: checksFailedList,
        };
        return this.logAndReturn(input, acceptResult, evaluationId, checksPassedList, checksFailedList);
    }
    // ============================================
    // Individual Checks
    // ============================================
    validateSchema(input) {
        if (!input.task_title || input.task_title.trim().length < 3) {
            return this.block('INSUFFICIENT_INFO', 0.95, false, 'Title too short');
        }
        if (!input.task_description || input.task_description.trim().length < 10) {
            return this.block('INSUFFICIENT_INFO', 0.95, false, 'Description too short');
        }
        if (!input.task_category) {
            return this.block('INSUFFICIENT_INFO', 0.95, false, 'Category required');
        }
        if (!input.proposed_price || input.proposed_price <= 0) {
            return this.block('INSUFFICIENT_INFO', 0.95, false, 'Valid price required');
        }
        if (!input.poster_id) {
            return this.block('INSUFFICIENT_INFO', 0.99, false, 'Poster ID required');
        }
        return null; // Passed
    }
    checkHighRiskPatterns(input) {
        const textToCheck = `${input.task_title} ${input.task_description}`.toLowerCase();
        for (const { pattern, code } of HIGH_RISK_PATTERNS) {
            if (pattern.test(textToCheck)) {
                serviceLogger.warn({
                    posterId: input.poster_id,
                    pattern: pattern.source,
                    code
                }, 'TPEE high-risk pattern detected');
                return this.block(code, 0.98, code === 'SCAM_RISK');
            }
        }
        return null; // Passed
    }
    validateCategory(input) {
        if (!ALLOWED_CATEGORIES.includes(input.task_category)) {
            return this.block('CATEGORY_MISMATCH', 0.9, false, `Category ${input.task_category} not allowed`);
        }
        return null; // Passed
    }
    checkPriceFloor(input) {
        const minPrice = RulesService.getMinTaskPrice(input.city_id || null);
        if (input.proposed_price < minPrice) {
            return this.adjust(minPrice, 'UNDERPRICED', 0.85);
        }
        return null; // Passed
    }
    async checkTrustScore(input) {
        try {
            const identityContext = await FraudDetectionService.getIdentityContext(input.poster_id);
            if (!identityContext) {
                // New user without identity context - flag but don't block
                return null;
            }
            if (identityContext.trustScore < TRUST_BLOCK_THRESHOLD) {
                return this.block('LOW_TRUST', 0.9, true);
            }
            if (identityContext.trustScore < TRUST_WARN_THRESHOLD) {
                // Don't block, but flag for review
                serviceLogger.warn({
                    posterId: input.poster_id,
                    trustScore: identityContext.trustScore
                }, 'TPEE low trust score warning');
            }
            return null; // Passed
        }
        catch (error) {
            serviceLogger.error({ error }, 'TPEE trust score check failed');
            // Fail open for now (Phase 1)
            return null;
        }
    }
    checkVelocity(input) {
        const now = new Date();
        let record = velocityStore.get(input.poster_id);
        if (!record) {
            record = {
                hourlyCount: 0,
                dailyCount: 0,
                lastHourReset: now,
                lastDayReset: now,
            };
        }
        // Reset counters if needed
        const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        if (record.lastHourReset < hourAgo) {
            record.hourlyCount = 0;
            record.lastHourReset = now;
        }
        if (record.lastDayReset < dayAgo) {
            record.dailyCount = 0;
            record.lastDayReset = now;
        }
        // Check limits
        if (record.hourlyCount >= MAX_TASKS_PER_HOUR) {
            return this.block('VELOCITY_EXCEEDED', 0.85, true, 'Too many tasks this hour');
        }
        if (record.dailyCount >= MAX_TASKS_PER_DAY) {
            return this.block('VELOCITY_EXCEEDED', 0.85, true, 'Too many tasks today');
        }
        // Increment and store
        record.hourlyCount++;
        record.dailyCount++;
        velocityStore.set(input.poster_id, record);
        return null; // Passed
    }
    // ============================================
    // Result Builders
    // ============================================
    block(reason, confidence, humanReview, _debugNote) {
        return {
            decision: 'BLOCK',
            recommended_price: { amount: null, currency: 'USD' },
            enforcement_reason_code: reason,
            confidence_score: confidence,
            human_review_required: humanReview,
            model_version: 'deterministic-v1',
            policy_version: this.policyVersion,
            evaluation_id: '',
            evaluated_at: new Date(),
            checks_passed: [],
            checks_failed: [],
        };
    }
    adjust(price, reason, confidence) {
        return {
            decision: 'ADJUST',
            recommended_price: { amount: price, currency: 'USD' },
            enforcement_reason_code: reason,
            confidence_score: confidence,
            human_review_required: false,
            model_version: 'deterministic-v1',
            policy_version: this.policyVersion,
            evaluation_id: '',
            evaluated_at: new Date(),
            checks_passed: [],
            checks_failed: [],
        };
    }
    logAndReturn(input, result, evaluationId, checksPassedList, checksFailedList) {
        // Fill in evaluation details
        result.evaluation_id = evaluationId;
        result.checks_passed = checksPassedList;
        result.checks_failed = checksFailedList;
        // Log for analytics
        const logEntry = {
            id: evaluationId,
            input,
            result,
            timestamp: new Date(),
            shadow_mode: this.shadowMode,
        };
        tpeeLogStore.push(logEntry);
        // Keep log bounded
        if (tpeeLogStore.length > 10000) {
            tpeeLogStore.shift();
        }
        serviceLogger.info({
            evaluationId,
            decision: result.decision,
            reason: result.enforcement_reason_code,
            confidence: result.confidence_score,
            shadowMode: this.shadowMode,
        }, 'TPEE evaluation complete');
        return result;
    }
    // ============================================
    // Convenience: Convert TaskDraft to TPEEInput
    // ============================================
    taskDraftToTPEEInput(draft, posterId, cityId) {
        return {
            task_title: draft.title,
            task_description: draft.description,
            task_category: draft.category,
            proposed_price: draft.recommendedPrice,
            location_text: draft.locationText,
            poster_id: posterId,
            city_id: cityId,
        };
    }
    // ============================================
    // Admin & Observability
    // ============================================
    setShadowMode(enabled) {
        this.shadowMode = enabled;
        serviceLogger.info({ shadowMode: enabled }, 'TPEE shadow mode updated');
    }
    isShadowMode() {
        return this.shadowMode;
    }
    getRecentLogs(limit = 100) {
        return tpeeLogStore.slice(-limit);
    }
    getStats() {
        const logs = tpeeLogStore;
        const byReason = {};
        let accepted = 0, adjusted = 0, blocked = 0;
        for (const log of logs) {
            switch (log.result.decision) {
                case 'ACCEPT':
                    accepted++;
                    break;
                case 'ADJUST':
                    adjusted++;
                    break;
                case 'BLOCK':
                    blocked++;
                    break;
            }
            const reason = log.result.enforcement_reason_code;
            byReason[reason] = (byReason[reason] || 0) + 1;
        }
        return {
            total: logs.length,
            accepted,
            adjusted,
            blocked,
            byReason,
        };
    }
}
export const TPEEService = new TPEEServiceClass();
//# sourceMappingURL=TPEEService.js.map