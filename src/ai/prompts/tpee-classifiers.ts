/**
 * TPEE AI Classifiers - Phase 2B Prompt Contracts
 * 
 * RULES (CONSTITUTIONAL):
 * - AI NEVER overrides deterministic BLOCK
 * - AI can only escalate: ACCEPT → ADJUST → REVIEW
 * - All outputs are strict JSON with predefined enums
 * - Parse failure = REVIEW (not accept)
 * - UNCERTAIN = REVIEW (model abstention)
 */

// ============================================
// Types (Strict Output Contracts)
// ============================================

export interface PricingClassifierInput {
    task_title: string;
    task_description: string;
    category: string;
    location_text: string | null;
    proposed_price: number;
    median_price: number;
    median_duration_minutes: number;
    median_source: 'PRE_AI' | 'POST_AI';
}

export interface PricingClassifierOutput {
    price_verdict: 'OK' | 'TOO_LOW' | 'TOO_HIGH' | 'UNCERTAIN';
    recommended_price: number | null;
    confidence: number;
}

export interface ScamClassifierInput {
    task_text: string;
    trust_score: number;
    prior_flags: string[];
}

export interface ScamClassifierOutput {
    risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
    risk_reason: 'COERCION' | 'OFF_PLATFORM' | 'SOCIAL_ENGINEERING' | 'UNKNOWN';
    confidence: number;
}

// ============================================
// Pricing Realism Classifier (DeepSeek)
// ============================================

export const PRICING_CLASSIFIER_SYSTEM = `You are a pricing analyst for HustleXP, a gig marketplace in Seattle.

Evaluate whether a proposed task price is realistic given market data.

You will receive:
- Task details (title, description, category, location)
- Proposed price
- Historical median price for similar tasks
- Historical median duration

Your job: Determine if the price is realistic for the work described.

RETURN ONLY valid JSON in this exact format:
{
    "price_verdict": "OK" | "TOO_LOW" | "TOO_HIGH" | "UNCERTAIN",
    "recommended_price": <number or null>,
    "confidence": <0.0-1.0>
}

RULES:
- "OK" = price is reasonable for the described work
- "TOO_LOW" = price significantly undervalues the work (recommend higher)
- "TOO_HIGH" = price overvalues the work (recommend lower)
- "UNCERTAIN" = cannot make a confident determination

If "TOO_LOW" or "TOO_HIGH", you MUST provide recommended_price.
If "OK" or "UNCERTAIN", recommended_price should be null.

Confidence guidelines:
- >= 0.85: You are highly confident
- 0.60-0.84: Moderate confidence
- < 0.60: Low confidence (if this low, prefer UNCERTAIN)

Do NOT include any text outside the JSON object.`;

export function buildPricingClassifierPrompt(input: PricingClassifierInput): string {
    return `Analyze this task:

TITLE: ${input.task_title}
DESCRIPTION: ${input.task_description}
CATEGORY: ${input.category}
LOCATION: ${input.location_text || 'Not specified'}

PROPOSED PRICE: $${input.proposed_price}
MEDIAN PRICE (similar tasks): $${input.median_price}
MEDIAN DURATION: ${input.median_duration_minutes} minutes

Is $${input.proposed_price} a realistic price for this work?`;
}

// ============================================
// Subtle Scam / Coercion Classifier (GPT-4o)
// ============================================

export const SCAM_CLASSIFIER_SYSTEM = `You are a safety analyst for HustleXP, a gig marketplace.

Analyze task content for subtle abuse patterns that automated filters may miss.

You will receive:
- Task text content
- User's trust score (0-100, higher = more trusted)
- Prior flags on this user

Your job: Identify subtle patterns of:
- COERCION: Pressure tactics, urgency manipulation, emotional manipulation
- OFF_PLATFORM: Subtle hints to contact outside the app, alternative payment
- SOCIAL_ENGINEERING: Information extraction, trust exploitation
- UNKNOWN: Something concerning but not categorizable

RETURN ONLY valid JSON in this exact format:
{
    "risk_level": "LOW" | "MEDIUM" | "HIGH",
    "risk_reason": "COERCION" | "OFF_PLATFORM" | "SOCIAL_ENGINEERING" | "UNKNOWN",
    "confidence": <0.0-1.0>
}

RULES:
- "LOW" = No concerning patterns detected
- "MEDIUM" = Some concerning patterns, warrants review
- "HIGH" = Strong indicators of malicious intent

If risk_level is "LOW", risk_reason should be "UNKNOWN" (placeholder).

Confidence guidelines:
- >= 0.80: Highly confident in risk assessment
- 0.60-0.79: Moderate confidence
- < 0.60: Low confidence (be conservative)

Be CONSERVATIVE. When uncertain, prefer MEDIUM over HIGH.
Do NOT include any text outside the JSON object.`;

export function buildScamClassifierPrompt(input: ScamClassifierInput): string {
    return `Analyze this task for subtle abuse patterns:

TASK CONTENT:
${input.task_text}

USER CONTEXT:
- Trust Score: ${input.trust_score}/100
- Prior Flags: ${input.prior_flags.length > 0 ? input.prior_flags.join(', ') : 'None'}

Is there subtle coercion, off-platform solicitation, or social engineering in this task?`;
}
