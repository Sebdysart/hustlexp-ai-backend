/**
 * PromptInjectionGuard - Pure regex/string analysis for detecting prompt injection attacks
 *
 * Assigns a risk score (0-100) to user input and returns a decision:
 *   ALLOW  (score < 20)  - Clean input, pass through
 *   FLAG   (score 20-60) - Log the attempt, allow through
 *   BLOCK  (score > 60)  - Reject the input
 *
 * No AI calls - speed is the priority here.
 */

import { createLogger } from '../utils/logger.js';

const guardLogger = createLogger('prompt-injection-guard');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InjectionAnalysis {
    score: number; // 0-100
    decision: 'ALLOW' | 'FLAG' | 'BLOCK';
    matchedPatterns: string[];
    sanitizedInput?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PatternRule {
    name: string;
    pattern: RegExp;
    weight: number; // how much this contributes to the score
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

/**
 * English instruction-override patterns
 */
const INSTRUCTION_OVERRIDE_PATTERNS: PatternRule[] = [
    {
        name: 'ignore_previous_instructions',
        pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier|preceding|original)\s+(instructions?|prompts?|rules?|guidelines?|directives?|context)/i,
        weight: 40,
    },
    {
        name: 'disregard_instructions',
        pattern: /disregard\s+(all\s+)?(previous|prior|above|your)\s+(instructions?|prompts?|rules?|guidelines?)/i,
        weight: 40,
    },
    {
        name: 'forget_instructions',
        pattern: /forget\s+(all\s+)?(previous|prior|above|your|everything)\s+(instructions?|prompts?|rules?|context)/i,
        weight: 35,
    },
    {
        name: 'override_instructions',
        pattern: /override\s+(all\s+)?(previous|prior|your|system)\s+(instructions?|prompts?|rules?|settings?)/i,
        weight: 40,
    },
    {
        name: 'new_instructions',
        pattern: /(?:your\s+)?new\s+instructions?\s+(?:are|is|:)/i,
        weight: 35,
    },
    {
        name: 'do_not_follow',
        pattern: /do\s+not\s+follow\s+(your|the|any)\s+(original|previous|prior|system)\s+(instructions?|prompts?|rules?)/i,
        weight: 40,
    },
];

/**
 * Role-override / identity manipulation patterns
 */
const ROLE_OVERRIDE_PATTERNS: PatternRule[] = [
    {
        name: 'you_are_now',
        pattern: /you\s+are\s+now\s+(a|an|my|the|acting\s+as)\b/i,
        weight: 30,
    },
    {
        name: 'act_as',
        pattern: /(?:please\s+)?act\s+as\s+(a|an|if|though)\b/i,
        weight: 25,
    },
    {
        name: 'pretend_to_be',
        pattern: /pretend\s+(to\s+be|you\s*(?:are|'re))\b/i,
        weight: 30,
    },
    {
        name: 'roleplay_as',
        pattern: /(?:role\s*-?\s*play|impersonate|simulate|emulate)\s+(as\s+)?(a|an|the)?\s*\w/i,
        weight: 25,
    },
    {
        name: 'switch_mode',
        pattern: /(?:switch|change|enter|activate|enable)\s+(to|into)?\s*(?:developer|admin|debug|root|sudo|unrestricted|jailbreak|god)\s*mode/i,
        weight: 45,
    },
    {
        name: 'dan_jailbreak',
        pattern: /\bDAN\b.*(?:do\s+anything\s+now|jailbreak)/i,
        weight: 50,
    },
    {
        name: 'from_now_on',
        pattern: /from\s+now\s+on,?\s+you\s+(will|must|should|are|shall)\b/i,
        weight: 30,
    },
];

/**
 * System prompt extraction / reconnaissance patterns
 */
const SYSTEM_PROMPT_EXTRACTION_PATTERNS: PatternRule[] = [
    {
        name: 'repeat_instructions',
        pattern: /(?:repeat|recite|display|show|print|output|reveal|tell\s+me)\s+(your|the|all)?\s*(system\s+)?(instructions?|prompts?|rules?|guidelines?|configuration|directives?)/i,
        weight: 35,
    },
    {
        name: 'what_are_your_rules',
        pattern: /what\s+(?:are|were)\s+(?:your|the)\s+(system\s+)?(instructions?|rules?|prompts?|guidelines?|directives?)/i,
        weight: 25,
    },
    {
        name: 'show_system_prompt',
        pattern: /(?:show|display|print|output|dump|leak|reveal|expose)\s+(me\s+)?(your|the)\s*(full\s+|complete\s+|original\s+)?(system\s+)?prompt/i,
        weight: 40,
    },
    {
        name: 'initial_prompt',
        pattern: /(?:what|show|tell|give|repeat|reveal)\s+(?:me\s+)?(?:is\s+)?(?:your|the)\s+(initial|original|first|starting|hidden)\s+(prompt|instruction|message)/i,
        weight: 35,
    },
    {
        name: 'system_message_content',
        pattern: /(?:content|text|body)\s+of\s+(?:your|the)\s+system\s+(?:message|prompt)/i,
        weight: 35,
    },
    {
        name: 'echo_above',
        pattern: /(?:echo|print|output|write)\s+(?:everything|all|the\s+text)\s+(?:above|before\s+this|preceding)/i,
        weight: 30,
    },
];

/**
 * Delimiter / context-escape attacks
 */
const DELIMITER_ATTACK_PATTERNS: PatternRule[] = [
    {
        name: 'triple_backtick_break',
        pattern: /`{3,}[\s\S]*?(?:system|instruction|prompt|ignore|override)/i,
        weight: 30,
    },
    {
        name: 'markdown_heading_injection',
        pattern: /^#{1,3}\s*(?:system|instruction|new\s+role|admin)/im,
        weight: 25,
    },
    {
        name: 'xml_tag_injection',
        pattern: /<\/?(?:system|instruction|prompt|context|admin|role|assistant|user|message)>/i,
        weight: 35,
    },
    {
        name: 'separator_with_instruction',
        pattern: /(?:-{3,}|={3,}|\*{3,}|_{3,})\s*(?:system|instruction|new\s+prompt|ignore|override|admin)/i,
        weight: 30,
    },
    {
        name: 'fake_conversation_turn',
        pattern: /(?:^|\n)\s*(?:assistant|system|ai|bot|chatgpt|gpt|claude)\s*:\s*\S/im,
        weight: 30,
    },
    {
        name: 'end_of_prompt_marker',
        pattern: /(?:END|STOP|TERMINATE)\s*(?:OF\s+)?(?:SYSTEM\s+)?(?:PROMPT|INSTRUCTIONS?|MESSAGE)/i,
        weight: 35,
    },
];

/**
 * Encoding & obfuscation attacks
 */
const ENCODING_ATTACK_PATTERNS: PatternRule[] = [
    {
        name: 'base64_payload',
        // Matches long base64-looking strings (40+ chars of valid base64 alphabet ending with optional padding)
        pattern: /(?:[A-Za-z0-9+/]{40,}={0,2})/,
        weight: 15,
    },
    {
        name: 'hex_encoded_sequence',
        // Sequences of hex escape codes (\x41\x42...) or 0x41 0x42
        pattern: /(?:\\x[0-9a-fA-F]{2}){4,}|(?:0x[0-9a-fA-F]{2}\s*){4,}/,
        weight: 20,
    },
    {
        name: 'unicode_escape_sequence',
        // Unicode escapes: \u0041\u0042 or &#x41; &#65;
        pattern: /(?:\\u[0-9a-fA-F]{4}){3,}|(?:&#x?[0-9a-fA-F]+;\s*){3,}/,
        weight: 20,
    },
    {
        name: 'rot13_mention',
        pattern: /(?:rot13|caesar\s*cipher|decode\s+this|base64\s+decode|hex\s+decode)\s*:/i,
        weight: 25,
    },
    {
        name: 'leetspeak_instruction_override',
        // Common leetspeak variants of "ignore" or "system"
        pattern: /[1i!][gq9][nN][0o][rR][3e]\s+[pP][rR][3e][vV][1i!][0o][uU][sS5]/i,
        weight: 20,
    },
    {
        name: 'invisible_unicode_chars',
        // Zero-width characters, right-to-left overrides, and other invisible Unicode
        // eslint-disable-next-line no-misleading-character-class
        pattern: /[\u200B\u200C\u200D\u200E\u200F\u202A-\u202E\u2060\u2061-\u2064\uFEFF\u00AD]{2,}/,
        weight: 25,
    },
    {
        name: 'homoglyph_mixed_scripts',
        // Mixing Cyrillic/Latin characters that look similar (common obfuscation trick)
        // Detect Cyrillic characters mixed into primarily Latin text
        pattern: /(?=[A-Za-z]*[\u0400-\u04FF])(?=[\u0400-\u04FF]*[A-Za-z])[A-Za-z\u0400-\u04FF]{5,}/,
        weight: 15,
    },
];

/**
 * Multi-language injection patterns
 */
const MULTILANG_PATTERNS: PatternRule[] = [
    // Spanish
    {
        name: 'spanish_ignore_instructions',
        pattern: /ignora\s+(las?\s+)?(instrucciones?|reglas?|indicaciones?)\s+(anteriores?|previas?)/i,
        weight: 35,
    },
    {
        name: 'spanish_you_are_now',
        pattern: /ahora\s+eres\s+(un|una|mi)\b/i,
        weight: 25,
    },
    // French
    {
        name: 'french_ignore_instructions',
        pattern: /ignore[rz]?\s+(les?\s+)?(instructions?|r[eè]gles?|consignes?)\s+(pr[eé]c[eé]dentes?|ant[eé]rieures?)/i,
        weight: 35,
    },
    {
        name: 'french_you_are_now',
        pattern: /(?:tu\s+es|vous\s+[eê]tes)\s+maintenant\s+(un|une)\b/i,
        weight: 25,
    },
    // German
    {
        name: 'german_ignore_instructions',
        pattern: /ignorier(?:e|en)?\s+(die\s+)?(vorherigen?|bisherigen?)\s+(Anweisungen?|Regeln?|Instruktionen?)/i,
        weight: 35,
    },
    // Portuguese
    {
        name: 'portuguese_ignore_instructions',
        pattern: /ignor(?:e|ar)\s+(as?\s+)?(instru[cç][oõ]es?|regras?)\s+(anteriores?|pr[eé]vias?)/i,
        weight: 35,
    },
    // Chinese (Simplified & Traditional)
    {
        name: 'chinese_ignore_instructions',
        pattern: /(?:忽略|无视|不要遵循|不要遵守|忘记)(?:之前的|以前的|先前的|原来的|上面的)?(?:指令|指示|规则|提示|说明|命令)/,
        weight: 35,
    },
    {
        name: 'chinese_you_are_now',
        pattern: /(?:你现在是|从现在起你是|你的新角色是|扮演|假装你是)/,
        weight: 25,
    },
    // Japanese
    {
        name: 'japanese_ignore_instructions',
        pattern: /(?:前の|以前の|元の)(?:指示|指令|ルール|命令)(?:を|は)(?:無視|忘れ|無効)/,
        weight: 35,
    },
    // Korean
    {
        name: 'korean_ignore_instructions',
        pattern: /(?:이전|기존|원래)\s*(?:지시|지침|규칙|명령)(?:을|를)\s*(?:무시|잊어|무효)/,
        weight: 35,
    },
    // Russian
    {
        name: 'russian_ignore_instructions',
        pattern: /(?:игнорируй|забудь|проигнорируй)\s+(?:все\s+)?(?:предыдущие|прежние|прошлые)\s+(?:инструкции|правила|указания)/i,
        weight: 35,
    },
    // Arabic
    {
        name: 'arabic_ignore_instructions',
        pattern: /(?:تجاهل|انسى|لا تتبع)\s+(?:التعليمات|القواعد|الأوامر)\s+(?:السابقة|القديمة)/,
        weight: 35,
    },
];

/**
 * Miscellaneous / compound attack patterns
 */
const MISC_PATTERNS: PatternRule[] = [
    {
        name: 'token_smuggling',
        // Requests to concatenate or decode tokens to form hidden instructions
        pattern: /(?:concatenate|combine|join|merge)\s+(?:the\s+)?(?:tokens?|characters?|letters?|words?)\s+(?:to\s+)?(?:form|get|reveal|make)/i,
        weight: 20,
    },
    {
        name: 'payload_injection_marker',
        // Common injection payload markers
        pattern: /(?:INJECTION|PAYLOAD|EXPLOIT|JAILBREAK|PWNED|BYPASS)\s*[=:]/i,
        weight: 40,
    },
    {
        name: 'prompt_leaking_request',
        pattern: /(?:leak|exfiltrate|extract|steal)\s+(?:the\s+)?(?:prompt|instructions?|system\s+message)/i,
        weight: 40,
    },
    {
        name: 'confidence_manipulation',
        // Trying to get the AI to agree it has no restrictions
        pattern: /(?:you\s+(?:have|has)\s+no|there\s+are\s+no|remove\s+all)\s+(?:restrictions?|limitations?|filters?|guardrails?|constraints?|boundaries)/i,
        weight: 35,
    },
    {
        name: 'developer_override_claim',
        pattern: /(?:i\s+am|this\s+is)\s+(?:the|a|your|an?)\s+(?:developer|admin|administrator|creator|owner|maintainer|operator)\b/i,
        weight: 30,
    },
    {
        name: 'testing_bypass',
        pattern: /(?:this\s+is\s+(?:just\s+)?a\s+test|testing\s+mode|debug\s+mode|maintenance\s+mode)\s*[,.]?\s*(?:ignore|disable|turn\s+off|remove)\s+(?:safety|filter|guard|restrict)/i,
        weight: 35,
    },
    {
        name: 'hypothetical_framing',
        pattern: /(?:hypothetically|theoretically|in\s+a\s+fictional\s+scenario|imagine\s+you\s+had\s+no\s+(?:rules|restrictions))\s*,?\s*(?:how\s+would\s+you|what\s+would\s+you|could\s+you)/i,
        weight: 15,
    },
];

/**
 * All pattern categories combined
 */
const ALL_PATTERN_GROUPS: { category: string; rules: PatternRule[] }[] = [
    { category: 'instruction_override', rules: INSTRUCTION_OVERRIDE_PATTERNS },
    { category: 'role_override', rules: ROLE_OVERRIDE_PATTERNS },
    { category: 'system_prompt_extraction', rules: SYSTEM_PROMPT_EXTRACTION_PATTERNS },
    { category: 'delimiter_attack', rules: DELIMITER_ATTACK_PATTERNS },
    { category: 'encoding_attack', rules: ENCODING_ATTACK_PATTERNS },
    { category: 'multilang_injection', rules: MULTILANG_PATTERNS },
    { category: 'misc', rules: MISC_PATTERNS },
];

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

export class PromptInjectionGuard {
    /**
     * Analyze user input for prompt injection patterns.
     * Returns a risk score (0-100), a decision, and the list of matched patterns.
     */
    static analyze(input: string): InjectionAnalysis {
        if (!input || typeof input !== 'string') {
            return { score: 0, decision: 'ALLOW', matchedPatterns: [] };
        }

        const matchedPatterns: string[] = [];
        let rawScore = 0;

        // Run every pattern group
        for (const group of ALL_PATTERN_GROUPS) {
            for (const rule of group.rules) {
                if (rule.pattern.test(input)) {
                    matchedPatterns.push(`${group.category}:${rule.name}`);
                    rawScore += rule.weight;
                }
            }
        }

        // Structural heuristics that add additional weight
        rawScore += PromptInjectionGuard.structuralHeuristics(input, matchedPatterns);

        // Cap the score at 100
        const score = Math.min(100, rawScore);

        // Determine decision
        let decision: InjectionAnalysis['decision'];
        if (score > 60) {
            decision = 'BLOCK';
        } else if (score >= 20) {
            decision = 'FLAG';
        } else {
            decision = 'ALLOW';
        }

        // Log flagged or blocked inputs
        if (decision === 'FLAG') {
            guardLogger.warn(
                { score, matchedPatterns, inputPreview: input.slice(0, 120) },
                'Prompt injection FLAGGED'
            );
        } else if (decision === 'BLOCK') {
            guardLogger.error(
                { score, matchedPatterns, inputPreview: input.slice(0, 120) },
                'Prompt injection BLOCKED'
            );
        }

        return {
            score,
            decision,
            matchedPatterns,
            sanitizedInput: decision !== 'ALLOW' ? PromptInjectionGuard.sanitize(input) : undefined,
        };
    }

    /**
     * Sanitize user input by stripping or neutralizing dangerous patterns.
     * Returns the cleaned string. Use this when decision is FLAG but you
     * still want to pass input through to the AI (with dangerous parts removed).
     */
    static sanitize(input: string): string {
        if (!input || typeof input !== 'string') {
            return '';
        }

        let sanitized = input;

        // Remove invisible unicode characters
        // eslint-disable-next-line no-misleading-character-class
        sanitized = sanitized.replace(/[\u200B\u200C\u200D\u200E\u200F\u202A-\u202E\u2060\u2061-\u2064\uFEFF\u00AD]/g, '');

        // Remove XML-style injection tags
        sanitized = sanitized.replace(/<\/?(?:system|instruction|prompt|context|admin|role|assistant|user|message)>/gi, '');

        // Collapse triple+ backticks to single backtick (prevent delimiter escape)
        sanitized = sanitized.replace(/`{3,}/g, '`');

        // Collapse long separator runs (--- === *** ___) to max 2 chars
        sanitized = sanitized.replace(/(-{3,}|={3,}|\*{3,}|_{3,})/g, (match) => match[0].repeat(2));

        // Strip fake conversation turn markers at line starts
        sanitized = sanitized.replace(/^(\s*)(assistant|system|ai|bot|chatgpt|gpt|claude)\s*:\s*/gim, '$1');

        // Remove hex escape sequences
        sanitized = sanitized.replace(/(?:\\x[0-9a-fA-F]{2}){3,}/g, '[removed]');

        // Remove unicode escape sequences
        sanitized = sanitized.replace(/(?:\\u[0-9a-fA-F]{4}){3,}/g, '[removed]');

        // Remove HTML entity sequences
        sanitized = sanitized.replace(/(?:&#x?[0-9a-fA-F]+;\s*){3,}/g, '[removed]');

        // Trim excess whitespace that sanitization may have created
        sanitized = sanitized.replace(/\n{3,}/g, '\n\n').trim();

        return sanitized;
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Structural heuristics that look at overall input shape rather than
     * specific keyword patterns. Returns additional score to add.
     */
    private static structuralHeuristics(input: string, matchedPatterns: string[]): number {
        let bonus = 0;

        // High density of newlines + mixed instruction keywords is suspicious
        const newlineCount = (input.match(/\n/g) || []).length;
        const lineCount = newlineCount + 1;
        if (lineCount > 10 && matchedPatterns.length >= 2) {
            bonus += 10;
        }

        // Unusually long input with injection markers is higher risk
        if (input.length > 2000 && matchedPatterns.length >= 1) {
            bonus += 5;
        }

        // Multiple distinct attack categories detected = coordinated attack
        const categories = new Set(matchedPatterns.map((p) => p.split(':')[0]));
        if (categories.size >= 3) {
            bonus += 15; // Multi-vector attack
        } else if (categories.size === 2) {
            bonus += 5;
        }

        // Excessive use of special characters relative to input length
        // (often seen in delimiter / encoding attacks)
        const specialCharRatio = (input.match(/[`~<>{}|\\^]/g) || []).length / Math.max(input.length, 1);
        if (specialCharRatio > 0.1 && input.length > 30) {
            bonus += 10;
        }

        // ALL-CAPS screaming (common in aggressive injection attempts)
        const upperRatio = (input.match(/[A-Z]/g) || []).length / Math.max((input.match(/[a-zA-Z]/g) || []).length, 1);
        if (upperRatio > 0.8 && input.length > 40 && matchedPatterns.length >= 1) {
            bonus += 5;
        }

        return bonus;
    }
}
