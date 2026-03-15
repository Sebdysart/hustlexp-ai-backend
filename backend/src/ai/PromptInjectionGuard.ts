/**
 * PromptInjectionGuard v1.0.0
 *
 * Detects and blocks prompt injection / jailbreak attempts before they
 * reach AI providers. Used by the AIRouter to screen user-supplied text.
 *
 * Decision thresholds:
 *   score < 20  → ALLOW  (no action)
 *   score 20-60 → FLAG   (log + sanitize, continue with sanitizedInput)
 *   score > 60  → BLOCK  (reject request entirely)
 */

export interface InjectionAnalysisResult {
  decision: 'ALLOW' | 'FLAG' | 'BLOCK';
  score: number;
  matchedPatterns: string[];
  sanitizedInput?: string;
}

interface PatternRule {
  id: string;
  weight: number;
  test: (input: string) => boolean;
}

const PATTERNS: PatternRule[] = [
  {
    id: 'instruction_override:ignore_previous_instructions',
    weight: 70,
    test: (s) => /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i.test(s),
  },
  {
    id: 'instruction_override:disregard_instructions',
    weight: 65,
    test: (s) => /disregard\s+(all\s+)?(prior|previous|above)?\s*(rules?|instructions?|constraints?)/i.test(s),
  },
  {
    id: 'jailbreak:dan_pattern',
    weight: 50,
    test: (s) => /\bDAN\b.*do\s+anything\s+now|do\s+anything\s+now.*\bDAN\b/i.test(s),
  },
  {
    id: 'role_override:switch_mode',
    weight: 50,
    test: (s) => /switch\s+to\s+(developer|dev|unrestricted|god|admin)\s+mode/i.test(s),
  },
  {
    id: 'role_override:act_as',
    weight: 25,
    test: (s) => /\bact\s+as\s+(a\s+|an\s+)?(?!task|poster|hustler|worker)/i.test(s),
  },
  {
    id: 'system_prompt_extraction:show_system_prompt',
    weight: 70,
    test: (s) => /(show|reveal|print|output|display|tell me)\s+(me\s+)?(the\s+)?(full\s+)?system\s+prompt/i.test(s),
  },
  {
    id: 'system_prompt_extraction:what_is_your_prompt',
    weight: 60,
    test: (s) => /what\s+(is|are|was)\s+your\s+(system\s+)?prompt/i.test(s),
  },
  {
    id: 'delimiter_attack:xml_tag_injection',
    weight: 30,
    test: (s) => /<(system|instruction|prompt|human|assistant|user)\s*>/i.test(s),
  },
  {
    id: 'misc:payload_injection_marker',
    weight: 65,
    test: (s) => /^(INJECTION|PAYLOAD|OVERRIDE|SYSTEM)[:>]/im.test(s),
  },
];

function sanitize(input: string, patterns: string[]): string {
  // Remove matched pattern trigger phrases — rough but effective for logging/fallback
  let sanitized = input;
  if (patterns.some((p) => p.startsWith('instruction_override'))) {
    sanitized = sanitized.replace(/ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/gi, '[REDACTED]');
    sanitized = sanitized.replace(/disregard\s+(all\s+)?(prior|previous|above)?\s*(rules?|instructions?|constraints?)/gi, '[REDACTED]');
  }
  if (patterns.some((p) => p.startsWith('system_prompt'))) {
    sanitized = sanitized.replace(/(show|reveal|print|output|display|tell me)\s+(me\s+)?(the\s+)?(full\s+)?system\s+prompt/gi, '[REDACTED]');
  }
  if (patterns.some((p) => p.startsWith('delimiter_attack'))) {
    sanitized = sanitized.replace(/<(system|instruction|prompt|human|assistant|user)\s*>/gi, '[TAG_REMOVED]');
  }
  if (patterns.some((p) => p === 'misc:payload_injection_marker')) {
    sanitized = sanitized.replace(/^(INJECTION|PAYLOAD|OVERRIDE|SYSTEM)[:>]/gim, '[MARKER_REMOVED]:');
  }
  return sanitized.trim();
}

export const PromptInjectionGuard = {
  analyze(input: unknown): InjectionAnalysisResult {
    if (!input || typeof input !== 'string') {
      return { decision: 'ALLOW', score: 0, matchedPatterns: [] };
    }

    if (input.length === 0) {
      return { decision: 'ALLOW', score: 0, matchedPatterns: [] };
    }

    const matched: PatternRule[] = PATTERNS.filter((p) => p.test(input));
    const rawScore = matched.reduce((sum, p) => sum + p.weight, 0);
    const score = Math.min(rawScore, 100);
    const matchedPatterns = matched.map((p) => p.id);

    if (score < 20) {
      return { decision: 'ALLOW', score, matchedPatterns };
    }

    const sanitizedInput = sanitize(input, matchedPatterns);

    if (score > 60) {
      return { decision: 'BLOCK', score, matchedPatterns, sanitizedInput };
    }

    return { decision: 'FLAG', score, matchedPatterns, sanitizedInput };
  },
};
