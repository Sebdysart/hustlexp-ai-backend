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
}

export interface ComplianceNotes {
  score: number;
  tier: ComplianceTier;
  triggered_rules: string[];
  suggested_alternative: string | null;
  admin_review_id: string | null;
  appeal_status: 'none' | 'pending' | 'approved' | 'rejected';
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
  /bring\s+your\s+own\s+(gun|weapon|firearm)/i,
  /no\s+address.{0,20}deliver/i,
];

const SOFT_FLAG_PATTERNS = [
  { pattern: /massage/i, rule: 'physical_contact_ambiguous', score: 35 },
  { pattern: /overnight.{0,20}(stay|companion)/i, rule: 'overnight_ambiguous', score: 45 },
  { pattern: /alone.{0,20}(house|home|apartment)/i, rule: 'isolation_flag', score: 30 },
  { pattern: /(notary|legal\s+document).{0,30}(home|house)/i, rule: 'unlicensed_legal', score: 40 },
  { pattern: /medical.{0,20}(advice|treatment|injection)/i, rule: 'unlicensed_medical', score: 50 },
  { pattern: /cash\s+only.{0,20}no\s+record/i, rule: 'unreported_payment', score: 45 },
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

    const heuristicResult = ComplianceGuardianService._heuristicCheck(description);

    let finalResult = heuristicResult;
    if (AIClient.isConfigured() && heuristicResult.score >= 15 && heuristicResult.score <= 50) {
      try {
        finalResult = await ComplianceGuardianService._aiCheck(description, heuristicResult);
      } catch (err) {
        log.warn({ err }, 'AI compliance check failed, using heuristic result');
      }
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
      suggestedAlternative ?? undefined
    );

    return {
      score: finalResult.score,
      tier,
      triggeredRules: finalResult.triggeredRules,
      suggestedAlternative: suggestedAlternative ?? undefined,
      notes,
    };
  },

  toNotes: (
    score: number,
    triggeredRules: string[],
    suggestedAlternative?: string
  ): ComplianceNotes => ({
    score,
    tier: ComplianceGuardianService._scoreTotier(score),
    triggered_rules: triggeredRules,
    suggested_alternative: suggestedAlternative ?? null,
    admin_review_id: null,
    appeal_status: 'none',
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

  _aiCheck: async (
    description: string,
    heuristic: { score: number; triggeredRules: string[] }
  ): Promise<{ score: number; triggeredRules: string[] }> => {
    const response = await AIClient.callJSON<{ score: number; rules: string[] }>({
      route: 'fast',
      temperature: 0.1,
      timeoutMs: 5000,
      systemPrompt: `You are HustleXP's Compliance Guardian. Score this IRL gig task description 0–100 for illegal content.
0–20 = clearly legal IRL gig task
21–60 = ambiguous, needs review
61–100 = likely illegal (drugs, adult services, weapons, fraud, exploitation)

PROHIBITED: controlled substances, adult/sexual services, unlicensed medical/legal/notary,
fraud/counterfeit, weapons, animal cruelty, child exploitation, "no questions asked" deliveries.

Return JSON: { "score": number, "rules": string[] }`,
      prompt: scrubPII(description),
    });

    return {
      score: Math.max(heuristic.score, response.data.score),
      triggeredRules: [...new Set([...heuristic.triggeredRules, ...response.data.rules])],
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
