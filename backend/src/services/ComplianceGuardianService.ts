import { db } from '../db.js';
import { AIClient } from './AIClient.js';
import { logger } from '../logger.js';
import { scrubPII } from '../lib/pii-scrubber.js';

const log = logger.child({ service: 'ComplianceGuardianService' });

export type ComplianceTier = 'clean' | 'soft_flag' | 'hard_block';

export interface ComplianceResult {
  score: number;
  tier: ComplianceTier;
  triggeredRules: string[];
  suggestedAlternative?: string;
  notes: ComplianceNotes;
  deception_detected: boolean;
  is_genuinely_bizarre: boolean;
  ai_signals_computed: boolean;
}

export interface ComplianceNotes {
  score: number;
  tier: ComplianceTier;
  triggered_rules: string[];
  suggested_alternative: string | null;
  admin_review_id: string | null;
  appeal_status: 'none' | 'pending' | 'approved' | 'rejected';
  deception_detected: boolean;
  is_genuinely_bizarre: boolean;
  ai_signals_computed: boolean;
}

interface EvaluateInput {
  description: string;
  userId: string;
  templateSlug?: string;
  ipAddress?: string;
  deviceFingerprint?: string;
}

const HARD_BLOCK_PATTERNS = [
  /no\s+questions?\s+asked/i,
  /discreet\s+(only|delivery|service)/i,
  /with\s+benefits/i,
  /adult\s+(service|entertainment|modeling)/i,
  /happy\s+ending/i,
  /erotic|sexual\s+service/i,
  /unlicensed\s+(medical|legal|therapy)/i,
  /\b(deliver|bring|transport|carry|drop.?off).{0,30}(gun|firearm|weapon|pistol|rifle|ammo|ammunition)\b/i,
  /\b(gun|firearm|weapon|pistol|rifle).{0,30}(delivery|transport|drop.?off|location)\b/i,
  /no\s+address.{0,20}deliver/i,
];

const SOFT_FLAG_PATTERNS = [
  { pattern: /massage/i, rule: 'physical_contact_ambiguous', score: 35 },
  { pattern: /overnight.{0,30}(stay|companion|babysit|nanny|childcare|caregiver|sitter|care)/i, rule: 'overnight_ambiguous', score: 45 },
  { pattern: /alone.{0,20}(house|home|apartment)/i, rule: 'isolation_flag', score: 30 },
  { pattern: /(notary|legal\s+document).{0,30}(home|house)/i, rule: 'unlicensed_legal', score: 40 },
  { pattern: /medical.{0,20}(advice|treatment|injection)/i, rule: 'unlicensed_medical', score: 50 },
  { pattern: /cash\s+only.{0,20}no\s+record/i, rule: 'unreported_payment', score: 45 },
];

// ============================================================
// FLAGGED PATTERNS — 12 high-signal coded phrases
// Code-first exact match (normalize: lowercase, trim, strip punctuation, collapse whitespace)
// These populate flagged_phrase_counter on the users table for cross-task detection.
// ============================================================
export const FLAGGED_PATTERNS: string[] = [
  'no questions asked',
  'dont ask questions',
  'no questions',
  'drop it off no details',
  'deliver for a friend no questions',
  'discreet delivery',
  'cash only no record',
  'split payment later',
  'deliver for a friend',
  'bring it just leave it',
  'no address needed',
  'package for a friend no details',
];

// Override: if description contains license-affirming words, suppress soft flags
const LICENSE_AFFIRMERS = [/licensed/i, /certified/i, /credentials/i, /professional/i];

const SUGGESTED_ALTERNATIVES: Record<string, string> = {
  physical_contact_ambiguous: 'specialized_licensed',
  unlicensed_medical: 'specialized_licensed',
  unlicensed_legal: 'specialized_licensed',
};

export const ComplianceGuardianService = {
  evaluate: async (input: EvaluateInput): Promise<ComplianceResult> => {
    const { description, userId, ipAddress, deviceFingerprint } = input;

    const patternMatch = await ComplianceGuardianService._codeLevelPatternMatch(description, userId);
    let heuristicResult = ComplianceGuardianService._heuristicCheck(description);

    let codedPhraseMatched = false;
    if (patternMatch.matched && patternMatch.matchedPhrase) {
      codedPhraseMatched = true;
      if (patternMatch.isRepeat) {
        // Repeat occurrence: +25 to push firmly into soft_flag range
        heuristicResult = {
          score: heuristicResult.score + 25,
          triggeredRules: [...heuristicResult.triggeredRules, 'cross_task_pattern_repeat'],
        };
      } else {
        // First occurrence: +15 to push into soft_flag range
        heuristicResult = {
          score: heuristicResult.score + 15,
          triggeredRules: [...heuristicResult.triggeredRules, 'coded_phrase_first_occurrence'],
        };
      }
    }

    if (codedPhraseMatched) {
      heuristicResult = {
        ...heuristicResult,
        score: Math.max(heuristicResult.score, 21), // Ensure coded phrase alone reaches soft_flag
      };
    }

    let finalResult: { score: number; triggeredRules: string[]; deception_detected: boolean; is_genuinely_bizarre: boolean } = {
      ...heuristicResult,
      deception_detected: false,
      is_genuinely_bizarre: false,
    };

    const isWildcardTask = input.templateSlug === 'wildcard_bizarre';
    const scoreInAmbiguousRange = heuristicResult.score >= 15 && heuristicResult.score <= 50;
    const shouldRunAI = AIClient.isConfigured() && (scoreInAmbiguousRange || isWildcardTask);

    let aiSignalsComputed = false;

    if (shouldRunAI) {
      try {
        finalResult = await ComplianceGuardianService._aiCheck(description, heuristicResult, input.templateSlug);
        aiSignalsComputed = true;
      } catch (err) {
        log.warn({ err }, 'AI compliance check failed, using heuristic result');
      }
    }

    if (!AIClient.isConfigured() && isWildcardTask) {
      log.warn(
        { templateSlug: input.templateSlug },
        'AI not configured — deception_detected and is_genuinely_bizarre unavailable for wildcard task. Bizarre cap will not apply, deception will not be detected.'
      );
    }

    const tier = ComplianceGuardianService._scoreTotier(finalResult.score);

    if (finalResult.score >= 21) {
      await ComplianceGuardianService._logViolation({
        userId, ipAddress, deviceFingerprint,
        description, score: finalResult.score,
        triggeredRules: finalResult.triggeredRules,
      });
    }

    const suggestedAlternative = finalResult.triggeredRules
      .map(r => SUGGESTED_ALTERNATIVES[r])
      .find(Boolean) ?? null;

    const notes = ComplianceGuardianService.toNotes(
      finalResult.score,
      finalResult.triggeredRules,
      suggestedAlternative ?? undefined,
      finalResult.deception_detected,
      finalResult.is_genuinely_bizarre,
      aiSignalsComputed,
    );

    return {
      score: finalResult.score,
      tier,
      triggeredRules: finalResult.triggeredRules,
      suggestedAlternative: suggestedAlternative ?? undefined,
      notes,
      deception_detected: finalResult.deception_detected ?? false,
      is_genuinely_bizarre: finalResult.is_genuinely_bizarre ?? false,
      ai_signals_computed: aiSignalsComputed,
    };
  },

  toNotes: (
    score: number,
    triggeredRules: string[],
    suggestedAlternative?: string,
    deception_detected: boolean = false,
    is_genuinely_bizarre: boolean = false,
    ai_signals_computed: boolean = false
  ): ComplianceNotes => ({
    score,
    tier: ComplianceGuardianService._scoreTotier(score),
    triggered_rules: triggeredRules,
    suggested_alternative: suggestedAlternative ?? null,
    admin_review_id: null,
    appeal_status: 'none',
    deception_detected,
    is_genuinely_bizarre,
    ai_signals_computed,
  }),

  _scoreTotier: (score: number): ComplianceTier => {
    if (score >= 61) return 'hard_block';
    if (score >= 21) return 'soft_flag';
    return 'clean';
  },

  _heuristicCheck: (description: string): { score: number; triggeredRules: string[] } => {
    for (const pattern of HARD_BLOCK_PATTERNS) {
      if (pattern.test(description)) {
        return { score: 85, triggeredRules: ['hard_block_pattern'] };
      }
    }

    // Check if description contains license affirmers (suppress soft flags)
    const hasLicenseAffirmer = LICENSE_AFFIRMERS.some(p => p.test(description));

    let highestScore = 0;
    const triggeredRules: string[] = [];
    for (const { pattern, rule, score } of SOFT_FLAG_PATTERNS) {
      if (pattern.test(description)) {
        // If description has license-affirming words, suppress physical_contact_ambiguous
        if (rule === 'physical_contact_ambiguous' && hasLicenseAffirmer) continue;
        highestScore = Math.max(highestScore, score);
        triggeredRules.push(rule);
      }
    }

    return { score: highestScore, triggeredRules };
  },

  _normalizeDescription: (description: string): string => {
    return description
      .toLowerCase()
      .trim()
      .replace(/[^\w\s]/g, '') // strip punctuation
      .replace(/\s+/g, ' ')    // collapse whitespace
      .trim();
  },

  _codeLevelPatternMatch: async (
    description: string,
    userId: string
  ): Promise<{ matched: boolean; isRepeat: boolean; matchedPhrase: string | null }> => {
    const normalized = ComplianceGuardianService._normalizeDescription(description);
    const matchedPhrase = FLAGGED_PATTERNS.find(p => normalized.includes(p)) ?? null;

    if (!matchedPhrase) {
      return { matched: false, isRepeat: false, matchedPhrase: null };
    }

    // CTE approach: capture OLD counter in old_data before the UPDATE so that
    // repeat_check reflects pre-update state. RETURNING then reads from repeat_check
    // (pre-update), not from the newly updated column — fixing the bug where
    // was_repeat was always true after the first use.
    try {
      const newEntry = JSON.stringify({ phrase: matchedPhrase, matched_at: new Date().toISOString() });

      const atomicResult = await db.query<{ was_repeat: boolean }>(
        `WITH old_data AS (
          SELECT COALESCE(flagged_phrase_counter, '[]'::jsonb) AS counter
          FROM users
          WHERE id = $1
        ),
        pruned_data AS (
          SELECT jsonb_agg(entry ORDER BY (entry->>'matched_at')) AS arr
          FROM old_data,
               jsonb_array_elements(old_data.counter) AS entry
          WHERE (entry->>'matched_at')::timestamptz > NOW() - INTERVAL '30 days'
        ),
        repeat_check AS (
          SELECT bool_or(entry->>'phrase' = $3) AS was_repeat
          FROM old_data,
               jsonb_array_elements(old_data.counter) AS entry
          WHERE (entry->>'matched_at')::timestamptz > NOW() - INTERVAL '30 days'
        ),
        new_counter AS (
          -- Keep the 19 most-recent entries from the 30-day window, then append the new
          -- entry — capping the stored array at 20 total elements.
          -- Inner subquery orders DESC (most recent first), LIMIT 19, then re-aggregates
          -- ascending so the array stays chronologically ordered.
          SELECT (
            COALESCE(
              (
                SELECT jsonb_agg(entry ORDER BY (entry->>'matched_at'))
                FROM (
                  SELECT entry
                  FROM jsonb_array_elements(
                    COALESCE((SELECT arr FROM pruned_data), '[]'::jsonb)
                  ) AS entry
                  ORDER BY (entry->>'matched_at') DESC
                  LIMIT 19
                ) t
              ),
              '[]'::jsonb
            ) || jsonb_build_array($2::jsonb)
          ) AS counter
        )
        UPDATE users
        SET flagged_phrase_counter = (SELECT counter FROM new_counter)
        WHERE id = $1
        RETURNING (SELECT was_repeat FROM repeat_check) AS was_repeat`,
        [userId, newEntry, matchedPhrase]
      );

      const isRepeat = atomicResult.rows[0]?.was_repeat ?? false;
      return { matched: true, isRepeat, matchedPhrase };
    } catch (err) {
      log.warn({ err }, 'Failed to update flagged_phrase_counter atomically, continuing without cross-task check');
      return { matched: true, isRepeat: false, matchedPhrase };
    }
  },

  _aiCheck: async (
    description: string,
    heuristic: { score: number; triggeredRules: string[] },
    templateSlug?: string,
  ): Promise<{ score: number; triggeredRules: string[]; deception_detected: boolean; is_genuinely_bizarre: boolean }> => {
    const templateContext = templateSlug === 'wildcard_bizarre'
      ? '\nTEMPLATE CONTEXT: This task was submitted under the wildcard_bizarre template. The Poster intentionally classified it as a custom or unusual one-off gig. Use this as context when evaluating is_genuinely_bizarre — the Poster has already signalled they expect this to be unusual.\n'
      : '';

    const response = await AIClient.callJSON<{
      score: number;
      rules: string[];
      deception_detected: boolean;
      is_genuinely_bizarre: boolean;
    }>({
      route: 'fast',
      temperature: 0.1,
      timeoutMs: 5000,
      systemPrompt: `You are HustleXP's Compliance Guardian v2.7. ${templateContext}Score this IRL gig task description 0–100 for illegal content. Return JSON with exactly these fields: score, rules, deception_detected, is_genuinely_bizarre.

SCORING:
0–20 = clearly legal IRL gig task
21–60 = ambiguous, needs review
61–100 = likely illegal (drugs, adult services, weapons, fraud, exploitation)

PROHIBITED: controlled substances, adult/sexual services, unlicensed medical/legal/notary,
fraud/counterfeit, weapons, animal cruelty, child exploitation, "no questions asked" deliveries.

ALSO FLAG (add to rules array, raise score appropriately):
"no questions asked", "dont ask questions", "deliver for a friend no details",
"discreet delivery", "cash only no record", "split payment later",
"bring it just leave it", "no address needed", "package for a friend no details"

DECEPTION DETECTION:
Set deception_detected: true if the task involves the Hustler pretending to be someone
they are not in a social context (fake boyfriend/girlfriend/friend/professional/colleague).
Innocent roleplay for creative/performance tasks is NOT deception.

GENUINE BIZARRENESS HEURISTIC (5 rules):
Active rules (at least one must fire):
  Rule 1: Task requires acting, roleplay, or scripted dialogue
  Rule 3: Task requires audience interaction or performance for an audience
  Rule 4: Task is a one-off ceremonial or ritual element (scattering ashes, cultural ceremony, unique life-event ritual)
Corroborating rules (at least one must also fire alongside an active rule):
  Rule 2: Task has no standard physical labor outcome (not delivery/assembly/cleaning/repair)
  Rule 5: Task is explicitly a performance in a private setting (private show, private ceremony, private serenade) — NOT simply a task that takes place at home

Set is_genuinely_bizarre: true ONLY IF (Rule1 OR Rule3 OR Rule4) AND (Rule2 OR Rule5).
Rule 2 and Rule 5 alone cannot satisfy the threshold.

Return JSON: { "score": number, "rules": string[], "deception_detected": boolean, "is_genuinely_bizarre": boolean }`,
      prompt: scrubPII(description),
    });

    return {
      score: Math.max(heuristic.score, response.data.score),
      triggeredRules: [...new Set([...heuristic.triggeredRules, ...response.data.rules])],
      deception_detected: response.data.deception_detected ?? false,
      is_genuinely_bizarre: response.data.is_genuinely_bizarre ?? false,
    };
  },

  _logViolation: async (params: {
    userId: string;
    ipAddress?: string;
    deviceFingerprint?: string;
    description: string;
    score: number;
    triggeredRules: string[];
  }) => {
    try {
      await db.query(
        `INSERT INTO compliance_violations
           (user_id, ip_address, device_fingerprint, raw_description, risk_score, triggered_rules)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          params.userId,
          params.ipAddress ?? null,
          params.deviceFingerprint ?? null,
          params.description,
          params.score,
          JSON.stringify(params.triggeredRules),
        ]
      );
    } catch (err) {
      log.error({ err }, 'Failed to log compliance violation');
    }
  },
};
